import { askQuizAi } from './groqQuiz.service.js';
import sanitizeQuizResponse from '../utils/sanitizeQuizResponse.js';
import { validateQuizQuality } from '../utils/quizQuality.js';

const extractJson = (text) => {
  const trimmed = (text || '').trim();

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
      throw new Error('No JSON object found in model response');
    }

    return JSON.parse(trimmed.slice(start, end + 1));
  }
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const toWordCount = (value = '') =>
  String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

const toReadableDuration = (seconds) => {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  if (!mins) return `${secs}s`;
  return `${mins}m ${secs}s`;
};

const toStringArray = (value, maxItems, fallback = []) => {
  if (!Array.isArray(value)) return fallback;

  const normalized = value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .slice(0, maxItems);

  return normalized.length ? normalized : fallback;
};

const normalizeSkillScores = (skillScores, fallback) => {
  if (!skillScores || typeof skillScores !== 'object') return fallback;

  const merged = {
    conceptualClarity: Number(skillScores.conceptualClarity),
    timeManagement: Number(skillScores.timeManagement),
    accuracy: Number(skillScores.accuracy),
    focusDiscipline: Number(skillScores.focusDiscipline)
  };

  return {
    conceptualClarity: Number.isFinite(merged.conceptualClarity)
      ? clamp(Math.round(merged.conceptualClarity), 0, 100)
      : fallback.conceptualClarity,
    timeManagement: Number.isFinite(merged.timeManagement)
      ? clamp(Math.round(merged.timeManagement), 0, 100)
      : fallback.timeManagement,
    accuracy: Number.isFinite(merged.accuracy)
      ? clamp(Math.round(merged.accuracy), 0, 100)
      : fallback.accuracy,
    focusDiscipline: Number.isFinite(merged.focusDiscipline)
      ? clamp(Math.round(merged.focusDiscipline), 0, 100)
      : fallback.focusDiscipline
  };
};

const buildDefaultFeedback = ({
  category,
  topic,
  difficulty,
  score,
  totalQuestions,
  wrongQuestions,
  timeTakenSeconds,
  allowedSeconds,
  violations
}) => {
  const safeTotal = Math.max(1, Number(totalQuestions) || 1);
  const safeScore = clamp(Number(score) || 0, 0, safeTotal);
  const accuracyPct = Math.round((safeScore / safeTotal) * 100);
  const safeAllowed = Math.max(1, Number(allowedSeconds) || 1);
  const paceRatio = clamp((Number(timeTakenSeconds) || safeAllowed) / safeAllowed, 0, 1);
  const violationCount = Math.max(0, Number(violations) || 0);

  const skillScores = {
    conceptualClarity: clamp(Math.round(accuracyPct * 0.88 + (100 - paceRatio * 100) * 0.12), 20, 98),
    timeManagement: clamp(Math.round((100 - paceRatio * 70) - violationCount * 5), 15, 98),
    accuracy: clamp(accuracyPct, 0, 100),
    focusDiscipline: clamp(100 - violationCount * 28, 10, 100)
  };

  const highAccuracy = accuracyPct >= 80;
  const mediumAccuracy = accuracyPct >= 55;
  const mostlyTimed = paceRatio > 0.8;
  const wrongCount = Math.max(0, safeTotal - safeScore);

  const paceLabel = mostlyTimed ? 'near the time limit' : paceRatio < 0.6 ? 'well within the time limit' : 'with balanced pacing';
  const violationLabel =
    violationCount === 0
      ? 'No focus violations were recorded, indicating stable attention throughout the attempt.'
      : `${violationCount} focus violation${violationCount > 1 ? 's were' : ' was'} recorded, which likely affected consistency on close-option questions.`;
  const wrongLabel =
    wrongCount === 0
      ? 'All questions were answered correctly, showing strong command over core patterns and option elimination.'
      : `${wrongCount} question${wrongCount > 1 ? 's were' : ' was'} missed, mainly where multi-step interpretation and final option verification were required.`;
  const timeLabel = `${toReadableDuration(timeTakenSeconds)} used out of ${toReadableDuration(allowedSeconds)} allowed`;

  const strengths = [];
  if (highAccuracy) strengths.push('Strong conceptual clarity across the selected topic.');
  if (!mostlyTimed) strengths.push('Maintained good pacing and completed decisions efficiently.');
  if (violationCount === 0) strengths.push('Stayed focused throughout the monitored session.');
  if (!strengths.length) strengths.push('Completed the full adaptive attempt under timed conditions.');

  const weakAreas = [];
  if (!highAccuracy) weakAreas.push('Accuracy dropped on multi-step or close-option questions.');
  if (mostlyTimed) weakAreas.push('Time pressure reduced final-question quality.');
  if (violationCount > 0) weakAreas.push('Focus breaks were detected during the monitored test.');
  if (!wrongQuestions?.length) weakAreas.push('Keep reinforcing consistency to sustain current performance.');

  const improvementTips = [
    'Review each incorrect question and write a 3-line solving logic summary.',
    `Run one ${topic} practice set daily with a ${difficulty} target and strict timer.`,
    'Use elimination first, then compute only between the final two options.',
    'Track recurring error patterns and revise that micro-topic before the next attempt.'
  ];

  const summary = highAccuracy
    ? `You delivered a strong ${difficulty} attempt in ${category} - ${topic} with ${safeScore}/${safeTotal} correct answers (${accuracyPct}%). The quiz was completed ${paceLabel}, with ${timeLabel}, showing efficient control under timed conditions. ${violationLabel} ${wrongLabel} Keep reinforcing speed-accuracy balance by continuing timed mixed sets and reviewing any minor slips to maintain this high-performance baseline.`
    : mediumAccuracy
      ? `You completed a solid ${difficulty} attempt in ${category} - ${topic} with ${safeScore}/${safeTotal} correct answers (${accuracyPct}%). The session was finished ${paceLabel}, with ${timeLabel}, indicating usable pacing but room to tighten decision quality under pressure. ${violationLabel} ${wrongLabel} The next improvement jump should come from stronger final-check habits, better elimination discipline, and targeted drills on recurring weak patterns.`
      : `This ${difficulty} attempt in ${category} - ${topic} ended at ${safeScore}/${safeTotal} correct answers (${accuracyPct}%), which is below target for stable progression. The quiz was completed ${paceLabel}, with ${timeLabel}, suggesting that time-pressure handling and confidence on multi-step items need improvement. ${violationLabel} ${wrongLabel} Focus next on fundamentals, stepwise reasoning checks, and short daily timed practice blocks before moving to harder variants.`;

  return {
    summary,
    strengths,
    weakAreas,
    improvementTips,
    nextFocus: `Next attempt focus: ${category} - ${topic} fundamentals + timed medium-level sets with accuracy-first approach.`,
    skillScores
  };
};

const getDifficultyBlueprint = (difficulty) => {
  if (difficulty === 'easy') {
    return [
      'Mostly direct one-step questions',
      'Use simpler numbers and straightforward statements',
      'Avoid layered traps and heavy multi-constraint reasoning'
    ];
  }

  if (difficulty === 'hard') {
    return [
      'Use multi-step reasoning and mixed constraints',
      'Include tricky but fair distractors',
      'Require deeper conceptual clarity and careful interpretation'
    ];
  }

  return [
    'Balanced two-step reasoning for most questions',
    'Moderate numerical complexity',
    'Avoid too-trivial and too-puzzle-heavy extremes'
  ];
};

const buildQuizPrompt = ({
  category,
  topic,
  difficulty,
  excludedQuestions = [],
  correctionNotes = ''
}) => {
  const exclusionBlock = excludedQuestions.length
    ? `Avoid repeating or paraphrasing these previously asked question stems:\n${excludedQuestions
        .slice(0, 20)
        .map((q, idx) => `${idx + 1}. ${q}`)
        .join('\n')}`
    : 'No previous question exclusion list provided.';

  const difficultyBlueprint = getDifficultyBlueprint(difficulty)
    .map((line, idx) => `${idx + 1}. ${line}`)
    .join('\n');

  return [
    {
      role: 'system',
      content:
        'You are an aptitude quiz generator. Return strict JSON only. No markdown. No comments. Ensure high diversity and no repeated patterns.'
    },
    {
      role: 'user',
      content: `Generate exactly 10 multiple-choice aptitude questions in strict JSON format for category "${category}", topic "${topic}", and difficulty "${difficulty}".

Example intent:
Generate 10 ${difficulty.toUpperCase()} level MCQ questions for ${category} topic "${topic}".

Difficulty blueprint:
${difficultyBlueprint}

${exclusionBlock}

Required JSON schema:
{
  "category": "${category}",
  "topic": "${topic}",
  "difficulty": "${difficulty}",
  "questions": [
    {
      "question": "string",
      "options": ["A","B","C","D"],
      "correctAnswer": "must match one option exactly",
      "explanation": "brief and useful reasoning"
    }
  ]
}

Rules:
- Return exactly 10 questions.
- Every question must test a different concept/sub-pattern.
- options must contain exactly 4 unique strings.
- correctAnswer must be one of the options.
- Keep question text clear, unambiguous, and non-repetitive.
- Avoid repeating structure with just number changes.
- Ensure all questions are aligned to ${category} topic "${topic}".
- Only return JSON.
${correctionNotes ? `\nCorrective constraints from previous invalid output:\n${correctionNotes}` : ''}`
    }
  ];
};

const fallbackQuiz = (category, topic, difficulty) => {
  const questions = [
    {
      question: `A worker completes a task in 12 days. How many days will 3 workers take to finish the same task together?`,
      options: ['4 days', '6 days', '8 days', '12 days'],
      correctAnswer: '4 days',
      explanation: 'Work rate adds linearly: 1/12 per worker, so 3 workers do 3/12 per day.'
    },
    {
      question: `A train covers 180 km in 3 hours. What is its average speed?`,
      options: ['45 km/h', '50 km/h', '60 km/h', '75 km/h'],
      correctAnswer: '60 km/h',
      explanation: 'Average speed equals distance divided by time: 180/3 = 60 km/h.'
    },
    {
      question: `If 25% of a number is 40, what is the number?`,
      options: ['120', '140', '160', '180'],
      correctAnswer: '160',
      explanation: '25% means one-fourth. So number = 40 × 4 = 160.'
    },
    {
      question: `A shopkeeper buys an item for 500 and sells it for 575. What is the profit percentage?`,
      options: ['10%', '12%', '15%', '20%'],
      correctAnswer: '15%',
      explanation: 'Profit = 75. Profit% = 75/500 × 100 = 15%.'
    },
    {
      question: `Simplify: (48 ÷ 6) + (7 × 3)`,
      options: ['25', '27', '29', '31'],
      correctAnswer: '29',
      explanation: '48 ÷ 6 = 8 and 7 × 3 = 21, total = 29.'
    },
    {
      question: `If A:B = 3:5 and B:C = 10:7, then A:C equals?`,
      options: ['3:7', '5:7', '6:7', '9:14'],
      correctAnswer: '6:7',
      explanation: 'From A:B=3:5 and B:C=10:7, scale first ratio to B=10, A=6, so A:C=6:7.'
    },
    {
      question: `Find the next number: 2, 6, 12, 20, 30, ?`,
      options: ['36', '40', '42', '44'],
      correctAnswer: '42',
      explanation: 'Differences are +4, +6, +8, +10, so next difference is +12.'
    },
    {
      question: `Which word is opposite in meaning to "Scarce"?`,
      options: ['Rare', 'Abundant', 'Limited', 'Small'],
      correctAnswer: 'Abundant',
      explanation: 'Scarce means insufficient, while abundant means available in plenty.'
    },
    {
      question: `What is the output of this code? int x=5; x+=3; print(x);`,
      options: ['5', '8', '15', '53'],
      correctAnswer: '8',
      explanation: 'x starts at 5 and x += 3 updates x to 8.'
    },
    {
      question: `Two pipes fill a tank in 10 and 15 minutes respectively. Time taken together?`,
      options: ['5 minutes', '6 minutes', '8 minutes', '12 minutes'],
      correctAnswer: '6 minutes',
      explanation: 'Combined rate = 1/10 + 1/15 = 1/6 tank per minute.'
    }
  ];

  return { category, topic, difficulty, questions };
};

export const generateQuizWithQuality = async ({
  category,
  topic,
  difficulty,
  excludedQuestions = []
}) => {
  const maxAttempts = 2;
  const totalBudgetMs = 15000;
  const startTs = Date.now();

  let correctionNotes = '';
  let bestFallback = null;
  let bestAny = null;

  for (let i = 0; i < maxAttempts; i += 1) {
    const elapsed = Date.now() - startTs;
    const remaining = totalBudgetMs - elapsed;

    if (remaining < 2500) break;

    try {
      const aiResponse = await askQuizAi(
        buildQuizPrompt({ category, topic, difficulty, excludedQuestions, correctionNotes }),
        {
          model: process.env.GROQ_QUIZ_MODEL || process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
          usageTag: 'quiz-generation'
        }
      );
      const parsed = extractJson(aiResponse);
      const sanitized = sanitizeQuizResponse(parsed, category, topic, difficulty);

      const quality = validateQuizQuality({
        questions: sanitized.questions,
        targetDifficulty: difficulty,
        excludedQuestions
      });

      if (!bestAny || quality.qualityScore > bestAny.qualityScore) {
        bestAny = {
          quiz: sanitized,
          qualityScore: quality.qualityScore,
          reasons: quality.reasons
        };
      }

      if (
        quality.isFallbackAcceptable &&
        (!bestFallback || quality.qualityScore > bestFallback.qualityScore)
      ) {
        bestFallback = {
          quiz: sanitized,
          qualityScore: quality.qualityScore,
          reasons: quality.reasons
        };
      }

      if (!quality.isValid) {
        correctionNotes = quality.reasons.join('; ');
        throw new Error(`Generated quiz rejected: ${correctionNotes}`);
      }

      return sanitized;
    } catch (error) {
      correctionNotes = correctionNotes || String(error?.message || '');
    }
  }

  if (bestFallback?.quiz) return bestFallback.quiz;
  if (bestAny?.quiz) return bestAny.quiz;

  // Guaranteed fast fallback to avoid blocking quiz start
  return fallbackQuiz(category, topic, difficulty);
};

export const generateQuizFeedback = async ({
  category,
  topic,
  difficulty,
  score,
  totalQuestions,
  wrongQuestions = [],
  timeTakenSeconds = 0,
  allowedSeconds = 0,
  violations = 0
}) => {
  const defaultFeedback = buildDefaultFeedback({
    category,
    topic,
    difficulty,
    score,
    totalQuestions,
    wrongQuestions,
    timeTakenSeconds,
    allowedSeconds,
    violations
  });

  const safeTotalQuestions = Math.max(1, Number(totalQuestions) || 1);
  const safeScore = clamp(Number(score) || 0, 0, safeTotalQuestions);

  const payload = {
    category,
    topic,
    difficulty,
    score: safeScore,
    totalQuestions: safeTotalQuestions,
    percentage: Number(((safeScore / safeTotalQuestions) * 100).toFixed(2)),
    timeTakenSeconds: Number(timeTakenSeconds) || 0,
    allowedSeconds: Number(allowedSeconds) || 0,
    violations: Number(violations) || 0,
    wrongQuestions: wrongQuestions.slice(0, 6).map((q) => ({
      question: String(q.question || '').slice(0, 220),
      selectedAnswer: String(q.selectedAnswer || ''),
      correctAnswer: String(q.correctAnswer || '')
    }))
  };

  const messages = [
    {
      role: 'system',
      content:
        'You are an aptitude performance coach. Return strict JSON only. No markdown. No extra keys. Keep insights specific and detailed.'
    },
    {
      role: 'user',
      content: `Analyze this quiz attempt and return this strict JSON schema only:
{
  "summary": "string",
  "strengths": ["string"],
  "weakAreas": ["string"],
  "improvementTips": ["string"],
  "nextFocus": "string",
  "skillScores": {
    "conceptualClarity": 0,
    "timeManagement": 0,
    "accuracy": 0,
    "focusDiscipline": 0
  }
}

Constraints:
- summary: 4 to 6 sentences, 80 to 140 words, and must reference score quality, pacing, and focus discipline.
- strengths: 2 to 5 items
- weakAreas: 2 to 5 items
- improvementTips: 3 to 6 items
- skillScores are integers from 0 to 100
- content must be specific to this attempt

Attempt data:
${JSON.stringify(payload)}`
    }
  ];

  try {
    const aiResponse = await askQuizAi(messages, {
      timeoutMs: 12000,
      temperature: 0.2,
      model: process.env.GROQ_SUMMARY_MODEL || process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      usageTag: 'quiz-summary'
    });
    const parsed = extractJson(aiResponse);

    const parsedSummary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const summary = toWordCount(parsedSummary) >= 60 ? parsedSummary : defaultFeedback.summary;

    return {
      summary,
      strengths: toStringArray(parsed.strengths, 5, defaultFeedback.strengths),
      weakAreas: toStringArray(parsed.weakAreas, 5, defaultFeedback.weakAreas),
      improvementTips: toStringArray(parsed.improvementTips, 6, defaultFeedback.improvementTips),
      nextFocus:
        typeof parsed.nextFocus === 'string' && parsed.nextFocus.trim()
          ? parsed.nextFocus.trim()
          : defaultFeedback.nextFocus,
      skillScores: normalizeSkillScores(parsed.skillScores, defaultFeedback.skillScores)
    };
  } catch (error) {
    return defaultFeedback;
  }
};

export const generateExplanationsForWrongQuestions = async ({
  category,
  topic,
  difficulty,
  wrongQuestions = []
}) => {
  if (!Array.isArray(wrongQuestions) || !wrongQuestions.length) {
    return {};
  }

  const payload = wrongQuestions.slice(0, 8).map((item, idx) => ({
    index: idx,
    question: String(item.question || '').slice(0, 220),
    options: Array.isArray(item.options) ? item.options.map((v) => String(v).slice(0, 80)) : [],
    correctAnswer: String(item.correctAnswer || '')
  }));

  const messages = [
    {
      role: 'system',
      content:
        'You are an aptitude tutor. Return strict JSON only. Keep explanations concise, clear, and direct.'
    },
    {
      role: 'user',
      content: `Generate concise explanations for wrong quiz questions.\nReturn JSON only in this schema:\n{\"items\":[{\"index\":0,\"explanation\":\"string\"}]}\n\nRules:\n- explanation length: 12-35 words.\n- explain the solving idea, not full chain-of-thought.\n- tie explanation to correctAnswer.\n- no markdown.\n\nmeta: category=${category}, topic=${topic}, difficulty=${difficulty}\nquestions=${JSON.stringify(payload)}`
    }
  ];

  try {
    const aiResponse = await askQuizAi(messages, {
      timeoutMs: 10000,
      temperature: 0.2,
      maxTokens: 500,
      maxRetries: 2,
      backoffMs: [2000, 5000, 8000],
      model: process.env.GROQ_SUMMARY_MODEL || process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      fallbackModel: process.env.GROQ_QUIZ_MODEL || process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      usageTag: 'quiz-explanations'
    });
    const parsed = extractJson(aiResponse);
    const map = {};

    if (Array.isArray(parsed?.items)) {
      for (const item of parsed.items) {
        const idx = Number(item?.index);
        const explanation = typeof item?.explanation === 'string' ? item.explanation.trim() : '';
        if (!Number.isNaN(idx) && explanation) {
          map[idx] = explanation;
        }
      }
    }

    return map;
  } catch (error) {
    return {};
  }
};

const requireNonEmptyString = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Overall summary missing valid "${label}"`);
  }
  return value.trim();
};

const requireStringArray = (value, label, minItems, maxItems) => {
  const normalized = toStringArray(value, maxItems, []);
  if (normalized.length < minItems) {
    throw new Error(`Overall summary missing valid "${label}" items`);
  }
  return normalized;
};

export const generateOverallQuizSummary = async ({ aggregate }) => {
  const safeAggregate = aggregate || {};

  const messages = [
    {
      role: 'system',
      content:
        'You are a senior aptitude performance analyst. Return strict JSON only. No markdown. No extra keys. Keep output detailed, actionable, and structured.'
    },
    {
      role: 'user',
      content: `Generate an overall AI summary for this user based on aggregate quiz history.
Return strict JSON with this exact schema:
{
  "headline": "string",
  "summary": "string",
  "strengths": ["string"],
  "weakAreas": ["string"],
  "timingInsights": ["string"],
  "disciplineInsights": ["string"],
  "nextActions": ["string"]
}

Rules:
- Use plain, professional language.
- summary: 5 to 8 sentences, 110 to 180 words, and must synthesize trend, timing behavior, and discipline behavior.
- strengths, weakAreas, timingInsights, disciplineInsights: 2 to 4 items each.
- nextActions: 3 to 5 items.
- Ground every point in the provided aggregate stats.
- Mention performance trend, timing behavior, and discipline/violation behavior.
- Keep items short and easy to scan.

Aggregate data:
${JSON.stringify(safeAggregate)}`
    }
  ];

  try {
    console.log('[quiz-overall-summary] requesting AI summary', {
      totalAttempts: safeAggregate.totalAttempts || 0
    });

    const aiResponse = await askQuizAi(messages, {
      timeoutMs: 12000,
      temperature: 0.2,
      model: process.env.GROQ_SUMMARY_MODEL || process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      usageTag: 'quiz-summary'
    });
    const parsed = extractJson(aiResponse);

    const summary = {
      headline: requireNonEmptyString(parsed.headline, 'headline'),
      summary: requireNonEmptyString(parsed.summary, 'summary'),
      strengths: requireStringArray(parsed.strengths, 'strengths', 2, 4),
      weakAreas: requireStringArray(parsed.weakAreas, 'weakAreas', 2, 4),
      timingInsights: requireStringArray(parsed.timingInsights, 'timingInsights', 2, 4),
      disciplineInsights: requireStringArray(parsed.disciplineInsights, 'disciplineInsights', 2, 4),
      nextActions: requireStringArray(parsed.nextActions, 'nextActions', 3, 5)
    };

    console.log('[quiz-overall-summary] AI summary generated successfully');
    return summary;
  } catch (error) {
    console.error('[quiz-overall-summary] AI summary generation failed', error?.message || error);
    throw new Error(`Overall AI summary generation failed: ${error?.message || error}`);
  }
};
