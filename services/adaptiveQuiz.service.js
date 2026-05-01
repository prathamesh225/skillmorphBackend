import { askQuizAi } from './groqQuiz.service.js';
import { getQuestionHash } from '../utils/questionHash.js';
import { normalizeStem, validateQuizQuality } from '../utils/quizQuality.js';

const MAX_EXPLANATION_WORDS = 20;
const MAX_RECENT_FINGERPRINTS = 18;
const MAX_RECENT_HASH_GUARD = 12;
const MAX_RECENT_ANCHORS = 10;
const FALLBACK_QUESTION_COUNT = 10;
const isSqlTopic = (topic = '') => /(sql|database|dbms|query|relational)/i.test(String(topic || ''));

const replaceSmartQuotes = (value = '') =>
  String(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');

const normalizeMathNotation = (value = '') =>
  replaceSmartQuotes(String(value || ''))
    .replace(/\\\(/g, '')
    .replace(/\\\)/g, '')
    .replace(/\\\[/g, '')
    .replace(/\\\]/g, '')
    .replace(/\$/g, '')
    .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gi, '($1)/($2)')
    .replace(/\\sqrt\s*\{([^{}]+)\}/gi, 'sqrt($1)')
    .replace(/sqrt\s*\{([^{}]+)\}/gi, 'sqrt($1)')
    .replace(/\^\{([^{}]+)\}/g, '^$1')
    .replace(/_\{([^{}]+)\}/g, '_$1')
    .replace(/\\times/gi, ' x ')
    .replace(/\\cdot/gi, ' * ')
    .replace(/\\div/gi, ' / ')
    .replace(/\\pi/gi, 'pi')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const sanitizeJsonLikeText = (value = '') =>
  replaceSmartQuotes(String(value || ''))
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();

const stripCodeFences = (value = '') => {
  const trimmed = String(value || '').trim();
  if (!trimmed.startsWith('```')) return trimmed;

  const lines = trimmed.split('\n');
  if (!lines.length) return trimmed;

  if (lines[0].startsWith('```')) lines.shift();
  while (lines.length && lines[lines.length - 1].trim().startsWith('```')) {
    lines.pop();
  }

  return lines.join('\n').trim();
};

const extractFencedBlocks = (value = '') => {
  const blocks = [];
  const regex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = regex.exec(String(value || ''));

  while (match) {
    if (match[1] && match[1].trim()) {
      blocks.push(match[1].trim());
    }
    match = regex.exec(String(value || ''));
  }

  return blocks;
};

const extractBalancedJsonObject = (value = '') => {
  const source = String(value || '').trim();
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start !== -1) {
        return source.slice(start, i + 1);
      }
    }
  }

  return '';
};

const tryParseJson = (candidate = '') => {
  const raw = String(candidate || '').trim();
  if (!raw) return null;

  const variants = [raw, sanitizeJsonLikeText(raw)];

  for (const variant of variants) {
    if (!variant) continue;

    try {
      return JSON.parse(variant);
    } catch (error) {
      // try next variant
    }
  }

  return null;
};

const extractFirstJsonBlock = (text = '') => {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Empty model response');
  }

  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  pushCandidate(trimmed);
  pushCandidate(stripCodeFences(trimmed));

  const fencedBlocks = extractFencedBlocks(trimmed);
  for (const block of fencedBlocks) {
    pushCandidate(block);
  }

  for (const candidate of [...candidates]) {
    const balanced = extractBalancedJsonObject(candidate);
    if (balanced) pushCandidate(balanced);
  }

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  }

  const preview = trimmed.replace(/\s+/g, ' ').slice(0, 180);
  throw new Error(`No valid JSON block found (preview: "${preview}")`);
};

const normalizeQuestionShape = (question = {}) => {
  const options = Array.isArray(question.options)
    ? question.options
    : Array.isArray(question.option)
      ? question.option
      : Array.isArray(question.choices)
        ? question.choices
        : [];

  return {
    question: question.question,
    options,
    correctAnswer:
      question.correctAnswer ||
      question.correct_answer ||
      question.correctOption ||
      question.correct_option ||
      question.answer ||
      '',
    explanation: question.explanation || question.reason || ''
  };
};

const normalizeForComparison = (value = '') =>
  replaceSmartQuotes(String(value || ''))
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const normalizeFingerprint = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\b/g, '#')
    .replace(/[^a-z#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const toFingerprintList = (questions = []) => {
  const seen = new Set();
  const fingerprints = [];

  for (const item of questions) {
    const raw = normalizeFingerprint(item).split(' ').slice(0, 18).join(' ');
    if (!raw) continue;
    if (raw.split(' ').length < 6) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    fingerprints.push(raw);
    if (fingerprints.length >= MAX_RECENT_FINGERPRINTS) break;
  }

  return fingerprints;
};

const toAnchorList = (questions = []) => {
  const anchors = [];
  const seen = new Set();

  for (const item of questions) {
    const anchor = String(item || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!anchor || anchor.split(' ').length < 5) continue;
    const normalized = normalizeFingerprint(anchor).split(' ').slice(0, 18).join(' ');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    anchors.push(anchor);
    if (anchors.length >= MAX_RECENT_ANCHORS) break;
  }

  return anchors;
};

const toQuestionFingerprint = (question = '') =>
  normalizeFingerprint(question)
    .split(' ')
    .slice(0, 22)
    .join(' ');

const tokenizeStem = (text = '') => normalizeStem(text).split(' ').filter(Boolean);

const stemSimilarity = (left = '', right = '') => {
  const leftTokens = new Set(tokenizeStem(left));
  const rightTokens = new Set(tokenizeStem(right));

  if (!leftTokens.size || !rightTokens.size) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  const union = leftTokens.size + rightTokens.size - intersection;
  return union ? intersection / union : 0;
};

const detectRecentFingerprintCollisions = ({ questions = [], recentQuestionFingerprints = [] }) => {
  const recentSet = new Set(
    toFingerprintList(recentQuestionFingerprints)
      .map((item) => toQuestionFingerprint(item))
      .filter(Boolean)
  );

  const collisions = [];
  for (const question of questions) {
    const fp = toQuestionFingerprint(question?.question || '');
    if (fp && recentSet.has(fp)) {
      collisions.push(fp);
    }
  }

  return [...new Set(collisions)];
};

const findHistoricalConflicts = ({ questions = [], recentHashes = [], recentQuestionAnchors = [] }) => {
  const guardedRecentHashes = new Set(recentHashes.slice(0, MAX_RECENT_HASH_GUARD));
  const recentAnchors = toAnchorList(recentQuestionAnchors).map((anchor) => ({
    anchor,
    stem: normalizeStem(anchor)
  }));

  const conflicts = [];

  questions.forEach((question, index) => {
    if (guardedRecentHashes.has(question.questionHash)) {
      conflicts.push({ index, reason: 'hash' });
      return;
    }

    const questionStem = normalizeStem(question.question || '');
    if (!questionStem) return;

    for (const recent of recentAnchors) {
      if (!recent.stem) continue;
      if (questionStem === recent.stem || stemSimilarity(questionStem, recent.stem) >= 0.94) {
        conflicts.push({ index, reason: 'recent-attempt' });
        return;
      }
    }
  });

  return conflicts;
};

const buildRetryCorrectionNote = ({ previousError = '', difficulty = '' }) => {
  const message = String(previousError || '').toLowerCase();

  if (message.includes('no valid json block found') || message.includes('empty model response')) {
    return `Previous response was incomplete/truncated JSON. Return compact strict JSON only.
- No markdown or code fences.
- Do not provide hidden reasoning, analysis, or scratch work.
- Return the final JSON object immediately.
- Keep each question under 34 words.
- Keep each option under 10 words.
- Keep explanation under ${MAX_EXPLANATION_WORDS} words.
- Ensure the JSON object is complete and properly closed.`;
  }

  if (message.includes('correctanswer must match one option')) {
    return 'Set correctAnswer exactly equal to one option string for every question.';
  }

  if (message.includes('quality check failed')) {
    return 'Increase structural diversity across questions and avoid repeated patterns.';
  }

  if (
    message.includes('repeats questions from recent attempts') ||
    message.includes('repeats question hash from recent memory')
  ) {
    return `Previous output repeated historical questions.
- Generate a fully new set with different context and logic structure.
- Change variable names, values, and scenario framing.
- Do not reuse prior stems even with minor edits.`;
  }

  if (message.includes('difficulty-enrichment mismatch')) {
    return `Maintain ${difficulty} difficulty while keeping output compact and complete.`;
  }

  return previousError || 'JSON/schema invalid';
};

const getTopicSpecificRules = (topic = '') => {
  const safeTopic = String(topic || '').toLowerCase();

  if (/(sql|database|dbms|query)/i.test(safeTopic)) {
    return [
      '- Topic focus (SQL/DB): include joins, aggregation, GROUP BY/HAVING, subqueries, and window-function reasoning.',
      "- SQL text in question/options must be single-line plain text (no multiline code blocks).",
      "- Avoid unescaped double quotes inside JSON strings; prefer single quotes in SQL snippets."
    ];
  }

  return [];
};

const getGraduateLevelStandard = () => [
  '- Base academic standard: every quiz must target graduate-level learners or job-seeking graduates.',
  '- Even easy questions must feel like campus-placement or graduate aptitude questions, not school-level trivia.',
  '- Test conceptual clarity, interpretation, and practical reasoning expected from a graduate candidate.',
  '- Avoid childish contexts, overly basic arithmetic-only stems, or rote textbook phrasing.',
  '- Use professional, exam-style wording suitable for aptitude screening and competitive graduate assessments.'
];

const getDifficultyRules = (difficulty, topic = '') => {
  const sqlTopic = isSqlTopic(topic);

  if (difficulty === 'hard') {
    if (sqlTopic) {
      return [
        '- Difficulty profile HARD (SQL/DB) on a graduate baseline:',
        '- Include at least 2 multi-concept SQL reasoning questions (e.g., join + aggregation, subquery + filter).',
        '- Include at least 1 tricky SQL question (NULL behavior, duplicate handling, or query equivalence).',
        '- Include at least 1 detailed case-style SQL question (22+ words).',
        '- Prefer scenario-based debugging, query evaluation, output prediction, or correction-style questions.',
        '- Keep SQL snippets single-line plain text and avoid markdown/code fences.',
        '- Keep each question concise enough to fit a complete JSON response.'
      ];
    }

    return [
      '- Difficulty profile HARD on a graduate baseline:',
      '- At least 4 questions must be multi-concept (combine 2+ concepts in one solve path).',
      '- At least 2 questions must be tricky (minimum/maximum/except/cannot/not-true/closest).',
      '- At least 2 questions must be lengthy case-style statements (28+ words in question text).',
      '- Use layered constraints and data-rich setups; avoid one-step direct formulas.',
      '- Expect a well-prepared graduate candidate to need careful reasoning, not immediate recall.',
      '- Keep each question concise enough to fit a complete JSON response.'
    ];
  }

  if (difficulty === 'medium') {
    return [
      '- Difficulty profile MEDIUM on a graduate baseline:',
      '- At least 2 questions must be multi-concept (two-step reasoning with linked conditions).',
      '- At least 1 question must include tricky qualifiers (least/closest/not/maximum/minimum).',
      '- At least 1 question should be moderately lengthy (22+ words in question text).',
      '- Keep balance: conceptual plus computational, not only direct substitution.',
      '- Questions should be clearly solvable but still require graduate-level interpretation and disciplined option elimination.'
    ];
  }

  return [
    '- Difficulty profile EASY on a graduate baseline:',
    '- Mostly direct or lightly structured questions, but still placement-style and professionally worded.',
    '- Keep wording compact and clear.',
    '- Avoid deep multi-constraint reasoning, but preserve conceptual quality and realistic distractors.',
    '- Easy means accessible for graduates, not simplistic for beginners.'
  ];
};

const getGlobalPromptRules = () => [
  '- Generate exactly 10 MCQs and ensure all 10 are meaningfully different in structure.',
  '- Vary scenario type, verbs, numerical setup, answer-pattern logic, and distractor design across questions.',
  '- Do not recycle the same stem template with only number changes.',
  '- Do not paraphrase historical questions too closely; change context, relationship, constraint order, and objective.',
  '- Keep correct answers logically defensible and free from ambiguity.',
  '- Options must be plausible, distinct, and designed to test graduate-level misunderstanding patterns.',
  '- Prefer clean single-line strings in JSON output.',
  '- Do not use markdown, bullets, code fences, commentary, or prose outside the JSON object.',
  '- Ensure the final JSON object is complete, valid, and closed properly.'
];

const getTopicQualityRules = (topic = '') => {
  if (isSqlTopic(topic)) {
    return [
      '- For SQL topics, cover a mix of output prediction, query correction, logical filtering, joins, grouping, and subquery reasoning.',
      '- Favor conceptual SQL reasoning over rote syntax recall.',
      '- Use concise SQL snippets embedded inside the question text when needed.'
    ];
  }

  return [
    '- For non-SQL topics, mix computational, conceptual, interpretive, and trap-based question styles.',
    '- Ensure at least some questions require reasoning about constraints, not just formula substitution.'
  ];
};


const getCategoryPromptRules = (category = '') => {
  const normalized = String(category || '').trim().toLowerCase();

  if (!normalized) {
    return ['- Align the quiz with the broad aptitude category context implied by the topic.'];
  }

  if (/(verbal|english|language|reading|comprehension)/i.test(normalized)) {
    return [
      `- Category context: ${category}.`,
      '- Focus on vocabulary precision, grammar judgment, sentence logic, para-structure, and reading-comprehension style aptitude.',
      '- Prefer professional assessment-style wording over conversational phrasing.'
    ];
  }

  if (/(reasoning|logical|critical)/i.test(normalized)) {
    return [
      `- Category context: ${category}.`,
      '- Focus on logical consistency, arrangement constraints, pattern decoding, inference discipline, and elimination-based reasoning.',
      '- Favor analytical reasoning formats over direct formula recall.'
    ];
  }

  if (/(quant|quantitative|aptitude|math|numerical|data)/i.test(normalized)) {
    return [
      `- Category context: ${category}.`,
      '- Focus on quantitative aptitude, arithmetic interpretation, data handling, and multi-step numerical reasoning.',
      '- Use placement-test style numeric setups and realistic distractors.'
    ];
  }

  return [
    `- Category context: ${category}.`,
    '- Align question style, wording, and reasoning patterns to this category while preserving aptitude-exam tone.'
  ];
};

const getVariationBlueprint = ({ category = '', difficulty = 'easy', topic = '' }) => {
  const normalizedCategory = String(category || '').toLowerCase();
  const normalizedTopic = String(topic || '').toLowerCase();

  if (isSqlTopic(topic) || /(sql|database|dbms|query)/i.test(normalizedTopic)) {
    return [
      'output prediction with join plus filter conditions',
      'query correction for wrong aggregate or grouping logic',
      'subquery or EXISTS-based reasoning with elimination',
      'NULL, DISTINCT, or duplicate-handling trap question',
      'HAVING versus WHERE decision under grouped output',
      'window-function or ranking interpretation case',
      'multi-table condition ordering with tricky result set',
      'case-style debugging question with one broken clause',
      'equivalent-query comparison with one subtle difference',
      'scenario-driven query design under business constraints'
    ];
  }

  if (/(verbal|english|language|reading|comprehension)/i.test(normalizedCategory)) {
    return [
      'vocabulary-in-context choice with close distractors',
      'grammar judgment with one subtle error pattern',
      'sentence improvement or correction question',
      'para-order or sentence sequencing question',
      'short reading-inference question with one trap option',
      'tone, assumption, or intent interpretation question',
      'analogy or usage question with professional wording',
      'error-detection question with layered sentence structure',
      'fill-in-the-blank question using contextual logic',
      'critical verbal reasoning question with elimination'
    ];
  }

  if (/(reasoning|logical|critical)/i.test(normalizedCategory)) {
    return [
      'family, order, or directional relation chain',
      'arrangement question with linked conditions',
      'statement-conclusion or assumption evaluation',
      'coded pattern or symbol mapping question',
      'selection or grouping problem with exclusions',
      'matrix-style elimination or comparison logic',
      'ranking or sequencing with one tricky qualifier',
      'set-based reasoning with overlap constraints',
      'cause-effect or inference discipline question',
      'case-style logical puzzle with compact clues'
    ];
  }

  const hard = difficulty === 'hard';
  const medium = difficulty === 'medium';
  return [
    hard ? 'case-based multi-step quantitative reasoning' : medium ? 'two-step quantitative reasoning' : 'direct quantitative computation',
    hard ? 'reverse-calculation with hidden constraint' : medium ? 'reverse-calculation with one condition' : 'reverse-calculation question',
    hard ? 'ratio, percentage, or profit-loss trap with qualifier' : medium ? 'ratio or percentage application question' : 'percentage or ratio question',
    hard ? 'work, speed, or mixture problem with layered data' : medium ? 'work, speed, or mixture question' : 'simple work, speed, or average question',
    hard ? 'comparison question using closest/least/maximum logic' : medium ? 'comparison question with elimination' : 'basic comparison question',
    hard ? 'data-rich decision question with at least two constraints' : medium ? 'data interpretation with one linked condition' : 'straightforward data interpretation question',
    hard ? 'multi-concept case where order of operations matters' : medium ? 'multi-concept arithmetic question' : 'single-concept aptitude question',
    hard ? 'option-elimination problem with a trap distractor' : medium ? 'option-elimination question' : 'clear option-based question',
    hard ? 'realistic placement-style scenario with detailed wording' : medium ? 'practical scenario-based question' : 'compact practical scenario question',
    hard ? 'final question using exception, cannot, or minimum wording' : medium ? 'final question with a tricky qualifier' : 'final question with a clean direct ask'
  ];
};

const analyzeQuestionComplexity = ({ question = '', options = [] }, difficulty) => {
  const merged = `${question} ${(options || []).join(' ')}`;
  const lowerMerged = merged.toLowerCase();
  const wordCount = String(question || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const numericCount = (merged.match(/\b\d+(?:\.\d+)?\b/g) || []).length;

  const conceptTags = [
    /(percentage|percent|discount|markup|profit|loss|simple interest|compound interest)/i,
    /(ratio|proportion|mixture|alligation)/i,
    /(time and work|pipes|cistern|speed|distance|time|train)/i,
    /(average|mean|weighted|data set)/i,
    /(probability|permutation|combination|arrangement|selection)/i,
    /(inequality|constraint|at least|at most|maximum|minimum)/i,
    /(statement|conclusion|reasoning|logic|assumption|inference)/i
  ];

  const conceptHits = conceptTags.reduce((count, regex) => count + (regex.test(merged) ? 1 : 0), 0);
  const sqlConceptTags = [
    /\bjoin\b|\binner join\b|\bleft join\b|\bright join\b|\bfull join\b|\bself join\b/i,
    /\bgroup by\b|\bhaving\b|\baggregate\b|\bsum\(|\bavg\(|\bcount\(|\bmax\(|\bmin\(/i,
    /\bsubquery\b|\bcorrelated\b|\bexists\b|\bnot exists\b|\bin\s*\(/i,
    /\bwindow\b|\bover\s*\(|\bpartition by\b|\brow_number\b|\brank\b|\bdense_rank\b|\blag\b|\blead\b/i,
    /\bwhere\b|\bcase when\b|\bcoalesce\b|\bnullif\b|\bis null\b|\bis not null\b|\bdistinct\b/i
  ];
  const sqlConceptHits = sqlConceptTags.reduce((count, regex) => count + (regex.test(merged) ? 1 : 0), 0);
  const connectorHit = /\b(and|or|while|whereas|after|before|simultaneously|together|combined)\b/i.test(question);
  const trickyHit =
    /\b(except|not true|cannot|least|minimum|max(?:imum)?|closest|best estimate|none of these|null|duplicate|equivalent|result set)\b/i.test(
      question
    );

  const sqlStyledQuestion = /\bselect\b|\bfrom\b|\bwhere\b|\bjoin\b|\bgroup by\b|\bhaving\b|\border by\b/i.test(
    lowerMerged
  );

  const multiConcept = sqlStyledQuestion
    ? sqlConceptHits >= 2 || (sqlConceptHits >= 1 && connectorHit)
    : conceptHits >= 2 || (conceptHits >= 1 && numericCount >= 3 && connectorHit);

  const lengthy = sqlStyledQuestion
    ? difficulty === 'hard'
      ? wordCount >= 22
      : wordCount >= 18
    : difficulty === 'hard'
      ? wordCount >= 28
      : wordCount >= 22;

  const numericDense = sqlStyledQuestion
    ? sqlConceptHits >= 2 ||
      /\bgroup by\b.*\bhaving\b|\bwhere\b.*\band\b|\bover\s*\(.*partition by\b/i.test(lowerMerged)
    : difficulty === 'hard'
      ? numericCount >= 2
      : numericCount >= 2;

  return {
    multiConcept,
    tricky: trickyHit,
    lengthy,
    numericDense,
    sqlStyledQuestion
  };
};

const enforceDifficultyComplexity = ({ questions = [], difficulty, topic = '' }) => {
  if (!['medium', 'hard'].includes(difficulty)) return;

  const metrics = questions.reduce(
    (acc, q) => {
      const result = analyzeQuestionComplexity(q, difficulty);
      if (result.multiConcept) acc.multiConcept += 1;
      if (result.tricky) acc.tricky += 1;
      if (result.lengthy) acc.lengthy += 1;
      if (result.numericDense) acc.numericDense += 1;
      if (result.sqlStyledQuestion) acc.sqlStyled += 1;
      return acc;
    },
    { multiConcept: 0, tricky: 0, lengthy: 0, numericDense: 0, sqlStyled: 0 }
  );

  const sqlTopic = isSqlTopic(topic) || metrics.sqlStyled >= 4;
  const minTargets = sqlTopic
    ? difficulty === 'hard'
      ? { multiConcept: 1, tricky: 1, lengthy: 1, numericDense: 1 }
      : { multiConcept: 1, tricky: 1, lengthy: 1, numericDense: 1 }
    : difficulty === 'hard'
      ? { multiConcept: 4, tricky: 2, lengthy: 2, numericDense: 4 }
      : { multiConcept: 2, tricky: 1, lengthy: 1, numericDense: 3 };

  const gaps = Object.keys(minTargets).filter((key) => metrics[key] < minTargets[key]);
  if (gaps.length) {
    const detail = gaps.map((key) => `${key} ${metrics[key]}/${minTargets[key]}`).join(', ');
    throw new Error(`difficulty-enrichment mismatch for ${difficulty}: ${detail}`);
  }
};

const stripLeadingOptionLabel = (value = '') =>
  String(value || '')
    .trim()
    .replace(/^(?:\(?\s*[a-d]\s*\)?|option\s*[a-d]|[1-4])\s*[\).:\-]\s*/i, '')
    .trim();

const resolveCorrectAnswer = ({ rawCorrectAnswer = '', options = [] }) => {
  const answer = String(rawCorrectAnswer || '').trim();
  if (!answer) return '';

  if (options.includes(answer)) {
    return answer;
  }

  const answerNormalized = normalizeForComparison(answer);
  const letters = ['a', 'b', 'c', 'd'];
  const byNormalized = new Map();
  const byLabel = new Map();

  options.forEach((option, index) => {
    const original = String(option || '').trim();
    const normalized = normalizeForComparison(original);
    if (normalized && !byNormalized.has(normalized)) {
      byNormalized.set(normalized, original);
    }

    const stripped = stripLeadingOptionLabel(original);
    const strippedNormalized = normalizeForComparison(stripped);
    if (strippedNormalized && !byNormalized.has(strippedNormalized)) {
      byNormalized.set(strippedNormalized, original);
    }

    const suffixStripped = stripped.replace(/\s*\((?:choice|alt)\s+[a-d0-9]+\)$/i, '').trim();
    const suffixStrippedNormalized = normalizeForComparison(suffixStripped);
    if (suffixStrippedNormalized && !byNormalized.has(suffixStrippedNormalized)) {
      byNormalized.set(suffixStrippedNormalized, original);
    }

    const letter = letters[index];
    byLabel.set(letter, original);
    byLabel.set(`option ${letter}`, original);
    byLabel.set(String(index + 1), original);
  });

  if (byNormalized.has(answerNormalized)) {
    return byNormalized.get(answerNormalized);
  }

  const strippedAnswerNormalized = normalizeForComparison(stripLeadingOptionLabel(answer));
  if (byNormalized.has(strippedAnswerNormalized)) {
    return byNormalized.get(strippedAnswerNormalized);
  }

  const labelMatch = answerNormalized.match(/^(?:option\s*)?([a-d])(?:[\).:\-]|\s|$)/i);
  if (labelMatch) {
    const option = byLabel.get(String(labelMatch[1]).toLowerCase());
    if (option) return option;
  }

  const numericMatch = answerNormalized.match(/^([1-4])(?:[\).:\-]|\s|$)/);
  if (numericMatch) {
    const option = byLabel.get(String(numericMatch[1]));
    if (option) return option;
  }

  return '';
};

const hasUniqueOptions = (options = []) => new Set(options.map((opt) => String(opt || '').toLowerCase())).size === options.length;

const normalizeOptionInput = (rawOptions = []) =>
  rawOptions
    .map((opt) => normalizeMathNotation(String(opt || '')).trim().replace(/\s+/g, ' '))
    .filter(Boolean);

const toDisplayOptions = (options = []) =>
  options.map((opt) => {
    const stripped = stripLeadingOptionLabel(opt).replace(/\s+/g, ' ').trim();
    return stripped || opt;
  });

const normalizeOptionForMatch = (value = '') => normalizeForComparison(stripLeadingOptionLabel(value));

const buildFallbackOption = ({ correctAnswer = '', existingOptions = [], variant = 0 }) => {
  const base = stripLeadingOptionLabel(correctAnswer).trim();
  const numericMatch = base.match(/^(-?\d+(?:\.\d+)?)(.*)$/);

  if (numericMatch) {
    const number = Number(numericMatch[1]);
    const suffix = numericMatch[2] || '';
    const delta = Math.max(1, Math.round(Math.max(Math.abs(number), 10) * (0.08 + variant * 0.04)));
    const nextValue = number + (variant % 2 === 0 ? delta : -delta);
    const candidate = `${nextValue}${suffix}`.trim();
    if (!existingOptions.some((item) => normalizeOptionForMatch(item) === normalizeOptionForMatch(candidate))) {
      return candidate;
    }
  }

  const genericPool = [
    'Cannot be determined',
    'Insufficient data',
    'None of these',
    'Both statements hold',
    'More information needed',
    'No valid option'
  ];

  for (let index = 0; index < genericPool.length; index += 1) {
    const candidate = genericPool[(variant + index) % genericPool.length];
    if (!existingOptions.some((item) => normalizeOptionForMatch(item) === normalizeOptionForMatch(candidate))) {
      return candidate;
    }
  }

  return `Alternative ${existingOptions.length + 1}`;
};

const buildNormalizedOptions = ({ rawOptions = [], rawCorrectAnswer = '' }) => {
  const rawNormalized = normalizeOptionInput(rawOptions);
  const strippedNormalized = toDisplayOptions(rawNormalized);
  let options = [];

  if (strippedNormalized.length && hasUniqueOptions(strippedNormalized)) {
    options = [...strippedNormalized];
  } else if (rawNormalized.length && hasUniqueOptions(rawNormalized)) {
    options = [...rawNormalized];
  } else {
    const seen = new Map();
    options = strippedNormalized.map((opt, index) => {
      const base = String(opt || rawNormalized[index] || '').trim();
      const key = base.toLowerCase();
      const count = seen.get(key) || 0;
      seen.set(key, count + 1);
      if (count === 0) return base;
      return `${base} (choice ${index + 1})`;
    });
  }

  const desiredAnswerKey = normalizeOptionForMatch(rawCorrectAnswer);
  if (options.length > 4) {
    const selected = [];
    for (const option of options) {
      if (selected.length >= 4) break;
      if (!selected.some((item) => normalizeOptionForMatch(item) === normalizeOptionForMatch(option))) {
        selected.push(option);
      }
    }

    if (desiredAnswerKey) {
      const answerOption = options.find((option) => normalizeOptionForMatch(option) === desiredAnswerKey);
      const selectedHasAnswer = selected.some((option) => normalizeOptionForMatch(option) === desiredAnswerKey);
      if (answerOption && !selectedHasAnswer) {
        selected[selected.length - 1] = answerOption;
      }
    }

    options = selected;
  }

  let variant = 0;
  while (options.length < 4) {
    const nextOption = buildFallbackOption({
      correctAnswer: rawCorrectAnswer,
      existingOptions: options,
      variant
    });
    variant += 1;
    if (!options.some((item) => normalizeOptionForMatch(item) === normalizeOptionForMatch(nextOption))) {
      options.push(nextOption);
    }
  }

  return options.slice(0, 4);
};

const repairQuestionText = (value = '', topic = '') => {
  const source = normalizeMathNotation(stripCodeFences(String(value || '')))
    .replace(/\s+/g, ' ')
    .replace(/[`]+/g, '')
    .trim();

  if (!source) {
    throw new Error('Question missing');
  }

  let question = source.replace(/\s*(?:\.\.\.|…)+\s*$/g, '').trim();
  if (!question) question = source;

  const trailingToken = question
    .replace(/[.?!,:;\-]+$/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .pop()
    ?.toLowerCase() || '';

  const abruptEnding =
    /[:;,\-]$/.test(question) ||
    /(?:and|or|with|if|when|where|whose|that|which|what|find|choose|select|determine)$/i.test(question) ||
    ['and', 'or', 'with', 'if', 'when', 'where', 'whose', 'that', 'which', 'what', 'find', 'choose', 'select', 'determine'].includes(trailingToken) ||
    /[\(\[\{][^\)\]\}]*$/.test(question) ||
    /["']$/.test(question);

  const wordCount = question.split(/\s+/).filter(Boolean).length;
  if (abruptEnding || wordCount < 5) {
    question = `${question.replace(/[:;,\-]+$/g, '').trim()} Choose the correct option.`.trim();
  }

  if (!/[.?!]$/.test(question)) {
    question = `${question}?`.replace(/\?\./g, '?');
  }

  if (question.split(/\s+/).filter(Boolean).length < 5) {
    question = `For ${topic || 'this topic'}, ${question.replace(/[?]+$/g, '').trim()}. Select the correct option.`;
  }

  return question.replace(/\s+/g, ' ').trim();
};

const trimExplanation = (value = '') =>
  String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_EXPLANATION_WORDS)
    .join(' ');

const buildFallbackExplanation = ({ question = '', correctAnswer = '' }) => {
  const correctText = stripLeadingOptionLabel(correctAnswer).trim();
  const base = correctText
    ? `The correct option ${correctText} best satisfies the given conditions.`
    : 'The correct option best satisfies the given conditions.';
  return trimExplanation(base);
};

const createStableSeed = (...parts) => {
  const source = parts.map((item) => String(item || '')).join('|');
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) % 2147483647;
  }
  return Math.abs(hash);
};

const buildFallbackDistractors = (answer, seed) => {
  const numeric = Number(answer);
  if (Number.isFinite(numeric)) {
    const offsets = [2, 5, 9, 12, 15, 18, 21].map((value) => value + (seed % 4));
    const options = [numeric];
    for (const offset of offsets) {
      if (options.length >= 4) break;
      const candidate = numeric + (options.length % 2 === 0 ? offset : -offset);
      if (!options.includes(candidate)) {
        options.push(candidate);
      }
    }
    return options
      .slice(0, 4)
      .sort((left, right) => left - right)
      .map((value) => String(value));
  }

  const baseChoices = [
    answer,
    `Most plausible ${seed % 7}`,
    `Closest alternative ${seed % 5}`,
    `Elimination trap ${seed % 3}`
  ];
  return [...new Set(baseChoices)].slice(0, 4);
};

const getFallbackQuestionPlan = ({
  index = 0,
  topic = '',
  category = '',
  difficulty = 'easy',
  recentHashes = []
}) => {
  const safeTopic = String(topic || 'this topic');
  const safeCategory = String(category || 'General Aptitude');
  const base = index + 1;
  const recentSeed = Array.isArray(recentHashes) ? recentHashes.slice(0, 4).join('|') : '';
  const seed = createStableSeed(safeTopic, safeCategory, difficulty, recentSeed, String(index));
  const templateIndex = seed % 4;
  const sqlTopic = isSqlTopic(safeTopic);
  const lowerCategory = safeCategory.toLowerCase();

  if (sqlTopic) {
    const threshold = 2 + (seed % 4);
    const questionTemplates = [
      {
        question: `For ${safeTopic}, which query clause should appear after GROUP BY when filtering grouped rows above ${threshold}?`,
        options: ['HAVING', 'WHERE', 'ORDER BY', 'DISTINCT'],
        correctAnswer: 'HAVING',
        explanation: 'Grouped-row filters belong in HAVING, not WHERE.'
      },
      {
        question: `In ${safeTopic}, which JOIN keeps all rows from the left table even when no right-table match exists?`,
        options: ['LEFT JOIN', 'INNER JOIN', 'CROSS JOIN', 'SELF JOIN'],
        correctAnswer: 'LEFT JOIN',
        explanation: 'LEFT JOIN preserves all left-table rows.'
      },
      {
        question: `For ${safeTopic}, which function assigns sequential row numbers inside each PARTITION BY group?`,
        options: ['ROW_NUMBER()', 'COUNT()', 'COALESCE()', 'GROUPING()'],
        correctAnswer: 'ROW_NUMBER()',
        explanation: 'ROW_NUMBER() numbers rows within each partition.'
      },
      {
        question: `In ${safeTopic}, which condition correctly tests missing values in SQL?`,
        options: ['IS NULL', '= NULL', '== NULL', 'IN NULL'],
        correctAnswer: 'IS NULL',
        explanation: 'SQL uses IS NULL to test missing values.'
      }
    ];
    return questionTemplates[templateIndex];
  }

  if (/(verbal|english|language|reading|comprehension)/i.test(lowerCategory)) {
    const templates = [
      {
        question: `In ${safeCategory}, choose the word closest in meaning to "pragmatic" as used in placement communication for ${safeTopic}.`,
        options: ['practical', 'careless', 'ornamental', 'uncertain'],
        correctAnswer: 'practical',
        explanation: 'Pragmatic most closely means practical here.'
      },
      {
        question: `For ${safeTopic} under ${safeCategory}, choose the sentence with the best grammatical structure.`,
        options: [
          'Each of the candidates is prepared.',
          'Each of the candidates are prepared.',
          'Each candidates is prepared.',
          'Each candidate are prepared.'
        ],
        correctAnswer: 'Each of the candidates is prepared.',
        explanation: 'Each takes a singular verb here.'
      },
      {
        question: `In ${safeCategory}, choose the best connector for the sentence: "The data was limited, ____ the conclusion remained valid."`,
        options: ['yet', 'because', 'unless', 'therefore'],
        correctAnswer: 'yet',
        explanation: 'Yet correctly contrasts the two clauses.'
      },
      {
        question: `For ${safeTopic}, choose the option that is most logically coherent in formal written English.`,
        options: [
          'The policy was revised after review.',
          'The policy revised after review were.',
          'After review revise policy was.',
          'Policy after were revised review.'
        ],
        correctAnswer: 'The policy was revised after review.',
        explanation: 'It is the only grammatically coherent sentence.'
      }
    ];
    return templates[templateIndex];
  }

  if (/(reasoning|logical|critical)/i.test(lowerCategory)) {
    const templates = [
      {
        question: `In ${safeCategory} for ${safeTopic}, if all coders are analysts and some analysts are reviewers, which conclusion is definitely true?`,
        options: [
          'Some coders are analysts.',
          'All reviewers are coders.',
          'No analyst is a reviewer.',
          'Some reviewers are coders.'
        ],
        correctAnswer: 'Some coders are analysts.',
        explanation: 'All coders belonging to analysts makes that definite.'
      },
      {
        question: `Five people stand in a row for ${safeTopic}. If A is left of B and C is right of B, which statement must be true?`,
        options: ['A is left of C.', 'C is left of A.', 'B is right of C.', 'A is next to B.'],
        correctAnswer: 'A is left of C.',
        explanation: 'If A is left of B and C right of B, A is left of C.'
      },
      {
        question: `For ${safeTopic} under ${safeCategory}, if code APPLE is written as BQQMF, how is GRAPE written?`,
        options: ['HSBQF', 'GQZOD', 'HRAQF', 'GSAQE'],
        correctAnswer: 'HSBQF',
        explanation: 'Each letter shifts forward by one place.'
      },
      {
        question: `In ${safeCategory}, which option completes the pattern 3, 6, 12, 24, ? for ${safeTopic}?`,
        options: ['36', '42', '48', '52'],
        correctAnswer: '48',
        explanation: 'Each term doubles, so 24 becomes 48.'
      }
    ];
    return templates[templateIndex];
  }

  if (difficulty === 'hard') {
    const a = 22 + base + (seed % 5);
    const b = 9 + (base % 4) + (seed % 3);
    const c = 3 + (base % 5);
    const answer = a * b - c;
    const templates = [
      `In ${safeCategory} practice for ${safeTopic}, evaluate (${a} x ${b}) - ${c}. Choose the correct option.`,
      `For ${safeTopic} in ${safeCategory}, a value is multiplied by ${b}, increased conceptually, then reduced by ${c}. What is the final result when the starting value is ${a}?`,
      `During ${safeCategory} preparation, a case in ${safeTopic} yields (${a} x ${b}) - ${c}. Which option is correct?`,
      `In a graduate-level ${safeTopic} question under ${safeCategory}, compute (${a} x ${b}) - ${c}.`
    ];
    return {
      question: templates[templateIndex],
      options: buildFallbackDistractors(answer, seed),
      correctAnswer: String(answer),
      explanation: trimExplanation(`Multiply ${a} by ${b}, subtract ${c}, and select ${answer}.`)
    };
  }

  if (difficulty === 'medium') {
    const start = 44 + base * 3 + (seed % 6);
    const gain = 12 + base + (seed % 4);
    const loss = 4 + (base % 3);
    const answer = start + gain - loss;
    const templates = [
      `For ${safeTopic} under ${safeCategory}, start with ${start}, add ${gain}, then subtract ${loss}. What is the result?`,
      `In ${safeCategory} preparation for ${safeTopic}, a quantity rises from ${start} by ${gain} and then falls by ${loss}. Choose the final value.`,
      `A ${safeTopic} scenario in ${safeCategory} begins at ${start}. After adding ${gain} and removing ${loss}, what remains?`,
      `Within ${safeCategory}, ${safeTopic} requires computing ${start} + ${gain} - ${loss}. Which option is correct?`
    ];
    return {
      question: templates[templateIndex],
      options: buildFallbackDistractors(answer, seed),
      correctAnswer: String(answer),
      explanation: trimExplanation(`Add ${gain} to ${start}, subtract ${loss}, and obtain ${answer}.`)
    };
  }

  const left = 15 + base + (seed % 4);
  const right = 9 + (base % 6) + (seed % 3);
  const answer = left + right;
  const templates = [
    `In ${safeTopic} for ${safeCategory}, what is ${left} + ${right}?`,
    `For ${safeCategory} practice in ${safeTopic}, add ${left} and ${right}. Choose the correct result.`,
    `A baseline ${safeTopic} question under ${safeCategory} asks for ${left} + ${right}. What is the answer?`,
    `During ${safeCategory} preparation, compute ${left} + ${right} for this ${safeTopic} item.`
  ];
  return {
    question: templates[templateIndex],
    options: buildFallbackDistractors(answer, seed),
    correctAnswer: String(answer),
    explanation: trimExplanation(`Add ${left} and ${right} to get ${answer}.`)
  };
};

const buildFallbackQuestionSlot = ({
  index = 0,
  category = '',
  topic = '',
  difficulty = 'easy',
  reason = '',
  recentHashes = []
}) => {
  const draft = getFallbackQuestionPlan({ index, topic, category, difficulty, recentHashes });
  const question = repairQuestionText(draft.question, topic);
  const options = buildNormalizedOptions({
    rawOptions: draft.options,
    rawCorrectAnswer: draft.correctAnswer
  });
  const correctAnswer =
    resolveCorrectAnswer({
      rawCorrectAnswer: draft.correctAnswer,
      options
    }) || options[1] || options[0];
  const explanation = trimExplanation(draft.explanation) || buildFallbackExplanation({ question, correctAnswer });

  return {
    question,
    questionHash: getQuestionHash(question),
    difficulty,
    options,
    correctAnswer,
    explanation,
    fallbackReason: String(reason || '').trim()
  };
};

const buildLocalFallbackQuiz = ({ category = '', topic = '', difficulty = 'easy', reason = '', recentHashes = [] }) => {
  const questions = Array.from({ length: FALLBACK_QUESTION_COUNT }).map((_, index) =>
    buildFallbackQuestionSlot({ index, category, topic, difficulty, reason, recentHashes })
  );

  return {
    topic: String(topic || '').trim() || 'General Aptitude',
    difficulty: String(difficulty || 'easy').trim() || 'easy',
    questions,
    modelUsed: 'local-fallback',
    qualityWarnings: [
      `fallback quiz used: ${String(reason || 'AI generation unavailable').replace(/\s+/g, ' ').trim()}`
    ],
    fallbackUsed: true
  };
};

const validateQuizPayload = ({ payload, topic, difficulty, expectedCount = 10 }) => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid payload: not an object');
  }

  if (!Array.isArray(payload.questions) || payload.questions.length !== expectedCount) {
    throw new Error(`Invalid payload: questions must contain exactly ${expectedCount} items`);
  }

  const sanitizedQuestions = payload.questions.map((rawQuestion, idx) => {
    try {
      const q = normalizeQuestionShape(rawQuestion);

      if (!q || typeof q !== 'object') {
        throw new Error(`Invalid question at index ${idx}`);
      }

      const question = repairQuestionText(q.question, topic);

      const options = buildNormalizedOptions({
        rawOptions: Array.isArray(q.options) ? q.options : [],
        rawCorrectAnswer: q.correctAnswer
      });

      if (options.length !== 4 || options.some((opt) => !opt)) {
        throw new Error(`Options could not be normalized at index ${idx}`);
      }

      const correctAnswer = resolveCorrectAnswer({
        rawCorrectAnswer: q.correctAnswer,
        options
      });
      if (!correctAnswer || !options.includes(correctAnswer)) {
        throw new Error(`correctAnswer must match one option at index ${idx}`);
      }

      const explanationSource = normalizeMathNotation(String(q.explanation || '')).trim();
      const explanation = explanationSource
        ? trimExplanation(explanationSource)
        : buildFallbackExplanation({
            question,
            correctAnswer
          });

      return {
        question,
        questionHash: getQuestionHash(question),
        difficulty,
        options,
        correctAnswer,
        explanation
      };
    } catch (error) {
      return buildFallbackQuestionSlot({
        index: idx,
        category: payload?.category || '',
        topic,
        difficulty,
        reason: error?.message || 'malformed question'
      });
    }
  });

  return {
    topic: String(payload.topic || topic).trim() || topic,
    difficulty: String(payload.difficulty || difficulty).trim() || difficulty,
    questions: sanitizedQuestions
  };
};

const buildPrompt = ({
  category = '',
  topic,
  difficulty,
  strongerVariation = false,
  correctionNote = '',
  recentQuestionFingerprints = [],
  recentQuestionAnchors = [],
  recentQuestionTexts = []
}) => {
  const graduateRules = getGraduateLevelStandard().join('\n');
  const difficultyRules = getDifficultyRules(difficulty, topic).join('\n');
  const globalRules = getGlobalPromptRules().join('\n');
  const topicQualityRules = getTopicQualityRules(topic).join('\n');
  const categoryRules = getCategoryPromptRules(category).join('\n');
  const topicSpecificRules = getTopicSpecificRules(topic).join('\n');
  const variationBlueprint = getVariationBlueprint({ category, difficulty, topic });
  const exclusionList = toFingerprintList(recentQuestionFingerprints);
  const anchorList = toAnchorList(recentQuestionAnchors);
  const recentTextList = [...new Set(
    (recentQuestionTexts || [])
      .map((item) => String(item || '').replace(/\s+/g, ' ').trim().slice(0, 160))
      .filter((item) => item && item.split(' ').length >= 5)
  )].slice(0, 20);
  const exclusionBlock = exclusionList.length
    ? `Recent pattern fingerprints to avoid repeating:\n${exclusionList
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n')}`
    : 'No historical fingerprint list provided. Avoid repeating previous wording or logic templates.';
  const anchorBlock = anchorList.length
    ? `Do NOT reproduce or paraphrase these recent question anchors:\n${anchorList
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n')}`
    : 'No recent anchor list provided.';
  const recentTextBlock = recentTextList.length
    ? `Recent 20 question stems from the same topic to avoid repeating or paraphrasing:\n${recentTextList
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n')}`
    : 'No recent full question list provided.';
  const variationBlock = `Question design blueprint (all 10 must use distinct styles):\n${variationBlueprint
    .map((item, index) => `${index + 1}. ${item}`)
    .join('\n')}`;

  return [
    {
      role: 'system',
      content:
        'You generate graduate-level AMCAT-style aptitude quizzes. Output strict JSON only, without markdown, code fences, reasoning, or any non-JSON text. Return the final JSON immediately.'
    },
    {
      role: 'user',
      content: `Generate exactly 10 AMCAT aptitude MCQs.

Category: ${category || 'General Aptitude'}
Topic: ${topic}
Difficulty: ${difficulty}

Requirements:
- Treat this as a graduate-level aptitude assessment first, then apply the requested difficulty.
- Difficulty is relative to a graduate standard, not a school standard.
- Exam-style wording, clear and concise.
- Exactly 4 options per question.
- correctAnswer must exactly match one option.
- explanation required for every question (8 to 20 words).
- Do not provide hidden reasoning, analysis, or scratch work.
- Return the final JSON object directly.
- Keep phrasing compact to avoid verbose output.
- Keep each question under 34 words when possible.
- Keep each option under 10 words.
- Do not prefix options with labels like A), B), 1., or Option C.
- Use only plain ASCII punctuation and plain-text math.
- Do not use LaTeX, markdown math, escaped notation, or backslash-heavy formatting.
- Write mathematical expressions in plain text such as sqrt(3), (3/4), 2^5, or 6 x 7.
- Avoid repeating previously asked questions for this user/topic.
- Ensure question stems are structurally diverse across all 10 items.
- Do not repeat the same equation pattern with only number swaps.
- Do not output duplicate options, placeholder text, or blank fields.
- If any question is too similar to recent history, replace it before finalizing the JSON.
${graduateRules}
${globalRules}
${difficultyRules}
${topicQualityRules}
${categoryRules}
${topicSpecificRules}
${variationBlock}
${exclusionBlock}
${anchorBlock}
- Use strong variation across all questions:
- change scenario framing
- change objective type
- change logic flow/order of constraints
- change numbers, entities, and context
- vary distractor patterns
${recentTextBlock}
- Before returning, self-check all 10 questions against the blocked patterns and anchors; if any one is similar, replace it before producing the final JSON.
- Final self-check before output: exactly 10 questions, 4 unique options each, correctAnswer equals one option, explanations stay within limit, no repeated stems, no markdown, no code fences.
${strongerVariation ? '- Use stronger variation in numbers, phrasing, problem setup, and solve-path structure.' : ''}
${correctionNote ? `- Fix this issue from previous output: ${correctionNote}` : ''}

Return strict JSON only with this schema:
{
  "topic": "${topic}",
  "difficulty": "${difficulty}",
  "questions": [
    {
      "question": "string",
      "options": ["A","B","C","D"],
      "correctAnswer": "string",
      "explanation": "string"
    }
  ]
}`
    }
  ];
};

const getGenerationRequestOptions = ({ model = '', strongerVariation = false }) => {
  const normalizedModel = String(model || '').trim().toLowerCase();
  const isGptOss120b = normalizedModel === 'openai/gpt-oss-120b';

  if (isGptOss120b) {
    return {
      temperature: strongerVariation ? 0.35 : 0.2,
      topP: strongerVariation ? 0.92 : 0.85,
      maxTokens: 2500,
      reasoningEffort: 'low',
      usageTag: 'quiz-generation'
    };
  }

  return {
    temperature: strongerVariation ? 0.45 : 0.2,
    topP: strongerVariation ? 0.92 : 0.85,
    maxTokens: 1600,
    reasoningEffort: 'low',
    usageTag: 'quiz-generation'
  };
};

const runGeneration = async ({
  category = '',
  topic,
  difficulty,
  model,
  strongerVariation = false,
  correctionNote = '',
  recentHashes = [],
  recentQuestionFingerprints = [],
  recentQuestionAnchors = [],
  recentQuestionTexts = [],
  aiClient = askQuizAi
}) => {
  const response = await aiClient(
    buildPrompt({
      category,
      topic,
      difficulty,
      strongerVariation,
      correctionNote,
      recentQuestionFingerprints,
      recentQuestionAnchors,
      recentQuestionTexts
    }),
    {
      model,
      ...getGenerationRequestOptions({ model, strongerVariation })
    }
  );

  const parsed = extractFirstJsonBlock(response);
  const validated = validateQuizPayload({ payload: parsed, topic, difficulty });

  const quality = validateQuizQuality({
    questions: validated.questions,
    targetDifficulty: difficulty,
    excludedQuestions: [],
    recentHashes: [],
    reducedSimilarityMode: false,
    requireExplanations: true
  });

  const qualityWarnings = [];
  if (!quality.isFallbackAcceptable) {
    const issues = quality.criticalReasons?.length ? quality.criticalReasons : quality.reasons;
    if (issues?.length) {
      qualityWarnings.push(`quality check warning: ${issues.join('; ')}`);
    }
  }

  const questions = [...validated.questions];
  const historicalConflicts = findHistoricalConflicts({
    questions,
    recentHashes,
    recentQuestionAnchors
  });

  if (historicalConflicts.length) {
    const groupedReasons = [...new Set(historicalConflicts.map((item) => item.reason))];
    qualityWarnings.push(`repeat warning: ${groupedReasons.join(', ')}`);
  }

  try {
    enforceDifficultyComplexity({ questions, difficulty, topic });
  } catch (error) {
    qualityWarnings.push(String(error?.message || 'difficulty-enrichment mismatch'));
  }

  return {
    ...validated,
    questions,
    modelUsed: model,
    qualityWarnings
  };
};

export const generateAdaptiveQuiz = async ({
  category = '',
  topic,
  difficulty,
  strongerVariation = false,
  primaryModel,
  recentHashes = [],
  recentQuestionFingerprints = [],
  recentQuestionAnchors = [],
  recentQuestionTexts = [],
  aiClient = askQuizAi
}) => {
  const primary = primaryModel || process.env.GROQ_QUIZ_MODEL || 'openai/gpt-oss-120b';

  try {
    return await runGeneration({
      category,
      topic,
      difficulty,
      model: primary,
      strongerVariation,
      recentHashes,
      recentQuestionFingerprints,
      recentQuestionAnchors,
      recentQuestionTexts,
      aiClient
    });
  } catch (error) {
    return buildLocalFallbackQuiz({
      category,
      topic,
      difficulty,
      reason: error?.message || 'unknown error',
      recentHashes
    });
  }
};

export const __adaptiveQuizTestables = {
  extractFirstJsonBlock,
  validateQuizPayload,
  buildPrompt,
  enforceDifficultyComplexity,
  buildLocalFallbackQuiz,
  buildFallbackQuestionSlot
};
