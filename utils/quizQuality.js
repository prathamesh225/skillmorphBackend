const normalizeText = (text = '') =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeStem = (text = '') =>
  normalizeText(text)
    .replace(/\b\d+(?:\.\d+)?\b/g, '#')
    .trim();

const tokenize = (text = '') => normalizeText(text).split(' ').filter(Boolean);

const jaccardSimilarity = (a, b) => {
  const aSet = new Set(tokenize(a));
  const bSet = new Set(tokenize(b));

  if (!aSet.size || !bSet.size) return 0;

  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }

  const union = aSet.size + bSet.size - intersection;
  return union ? intersection / union : 0;
};

const difficultyScoreForQuestion = (questionObj) => {
  const text = `${questionObj.question} ${(questionObj.options || []).join(' ')} ${
    questionObj.explanation || ''
  }`.toLowerCase();
  const numbers = text.match(/\b\d+(?:\.\d+)?\b/g) || [];

  let score = 0;

  if ((questionObj.question || '').length > 120) score += 1;
  if (numbers.length >= 3) score += 1;
  if (numbers.some((n) => Number(n) > 200)) score += 1;
  if (/(ratio|mixture|combined|successive|compound|nested|arrange|constraint)/.test(text)) score += 1;
  if (/(except|not true|cannot|minimum|maximum|least|at least)/.test(text)) score += 1;
  if (
    /(time and work|pipes|probability|permutation|coding|reasoning|syllogism|backtracking|bitwise|dp|combinatorics)/.test(
      text
    )
  )
    score += 1;
  if (questionObj.difficulty === 'very_hard') score += 1.2;

  return score;
};

const validateDifficultyAlignment = (questions, targetDifficulty) => {
  if (targetDifficulty === 'mixed') {
    const hasEasy = questions.some((q) => q.difficulty === 'easy');
    const hasMedium = questions.some((q) => q.difficulty === 'medium');
    const hasHard = questions.some((q) => q.difficulty === 'hard' || q.difficulty === 'very_hard');
    return hasEasy && hasMedium && hasHard;
  }

  const scores = questions.map(difficultyScoreForQuestion);
  const avg = scores.reduce((sum, v) => sum + v, 0) / (scores.length || 1);

  if (targetDifficulty === 'easy') return avg <= 2.2;
  if (targetDifficulty === 'medium') return avg >= 1.8 && avg <= 3.8;
  return avg >= 2.9;
};

export const validateCompositionAlignment = (questions, composition) => {
  if (!composition?.distribution?.length) return { ok: true };

  const expected = composition.distribution.reduce((acc, item) => {
    acc[item.difficulty] = (acc[item.difficulty] || 0) + item.count;
    return acc;
  }, {});

  const actual = questions.reduce((acc, item) => {
    acc[item.difficulty] = (acc[item.difficulty] || 0) + 1;
    return acc;
  }, {});

  const mismatches = Object.keys(expected).filter((key) => (actual[key] || 0) !== expected[key]);
  return { ok: mismatches.length === 0, mismatches };
};

export const validateQuizQuality = ({
  questions,
  targetDifficulty,
  excludedQuestions = [],
  recentHashes = [],
  composition,
  reducedSimilarityMode = false,
  requireExplanations = true
}) => {
  const criticalReasons = [];
  const softReasons = [];

  const normalized = questions.map((q) => normalizeText(q.question));
  const stems = questions.map((q) => normalizeStem(q.question));
  const excludedSet = new Set(excludedQuestions.map((q) => normalizeStem(q)));
  const recentHashSet = new Set(recentHashes);

  if (new Set(normalized).size !== questions.length) {
    criticalReasons.push('contains exact duplicate questions');
  }

  if (new Set(stems).size !== questions.length) {
    if (reducedSimilarityMode) {
      softReasons.push('contains repeated question patterns');
    } else {
      criticalReasons.push('contains repeated question patterns');
    }
  }

  for (let i = 0; i < questions.length; i += 1) {
    if (excludedSet.has(stems[i])) {
      criticalReasons.push('repeats questions from recent attempts');
      break;
    }
  }

  for (const question of questions) {
    if (question.questionHash && recentHashSet.has(question.questionHash)) {
      criticalReasons.push('repeats question hash from recent memory');
      break;
    }
  }

  const similarityThreshold = reducedSimilarityMode ? 0.93 : 0.86;
  for (let i = 0; i < questions.length; i += 1) {
    for (let j = i + 1; j < questions.length; j += 1) {
      if (jaccardSimilarity(questions[i].question, questions[j].question) > similarityThreshold) {
        if (reducedSimilarityMode) {
          softReasons.push('contains near-duplicate questions');
        } else {
          criticalReasons.push('contains near-duplicate questions');
        }
        i = questions.length;
        break;
      }
    }
  }

  const compositionCheck = validateCompositionAlignment(questions, composition);
  if (!compositionCheck.ok) {
    criticalReasons.push(`difficulty composition mismatch (${compositionCheck.mismatches.join(', ')})`);
  }

  if (!validateDifficultyAlignment(questions, targetDifficulty)) {
    softReasons.push(`difficulty does not match ${targetDifficulty}`);
  }

  if (requireExplanations) {
    const weakExplanations = questions.filter((q) => (q.explanation || '').trim().length < 16).length;
    if (weakExplanations > 2) {
      softReasons.push('explanations are too short');
    }
  }

  const reasons = [...criticalReasons, ...softReasons];
  const qualityScore = Math.max(0, 100 - criticalReasons.length * 35 - softReasons.length * 12);

  return {
    isValid: reasons.length === 0,
    isFallbackAcceptable: criticalReasons.length === 0,
    qualityScore,
    reasons,
    criticalReasons,
    softReasons
  };
};

export { normalizeText, normalizeStem };
