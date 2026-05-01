import { getQuestionHash } from './questionHash.js';

const ALLOWED_QUESTION_DIFFICULTIES = ['easy', 'medium', 'hard', 'very_hard'];

const normalizeQuestionDifficulty = (value = '') => {
  const normalized = String(value).toLowerCase().replace(/\s+/g, '_').trim();
  if (normalized === 'veryhard' || normalized === 'very_hard') return 'very_hard';
  if (normalized === 'easy' || normalized === 'medium' || normalized === 'hard') return normalized;
  return null;
};

const sanitizeQuizResponse = (arg1, categoryArg, topicArg, difficultyArg) => {
  const payload = arg1 && typeof arg1 === 'object' && 'quizData' in arg1
    ? arg1
    : {
        quizData: arg1,
        category: categoryArg,
        topic: topicArg,
        difficultyProfile: difficultyArg,
        composition: null
      };

  const { quizData, category, topic, difficultyProfile, composition } = payload;

  if (!quizData || typeof quizData !== 'object') {
    throw new Error('Invalid quiz payload: not an object');
  }

  const parsedCategory =
    typeof quizData.category === 'string' && quizData.category.trim()
      ? quizData.category.trim()
      : category;
  const parsedTopic = typeof quizData.topic === 'string' ? quizData.topic : topic;

  const fallbackDifficulty = ['easy', 'medium', 'hard', 'mixed'].includes(String(difficultyProfile))
    ? difficultyProfile
    : ['easy', 'medium', 'hard'].includes(String(quizData.difficulty))
      ? quizData.difficulty
      : 'medium';

  const slots = composition?.slots || [];
  const targetCount = slots.length || 10;
  if (!Array.isArray(quizData.questions) || quizData.questions.length !== targetCount) {
    throw new Error(`Invalid quiz payload: questions must be an array of ${targetCount} items`);
  }

  const questions = quizData.questions.map((q, idx) => {
    if (!q || typeof q !== 'object') {
      throw new Error(`Invalid question at index ${idx}`);
    }

    if (!q.question || typeof q.question !== 'string') {
      throw new Error(`Question text missing at index ${idx}`);
    }

    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(`Options must be 4 items at index ${idx}`);
    }

    const normalizedOptions = q.options.map((opt) => String(opt).trim());
    const uniqueOptions = new Set(normalizedOptions.map((opt) => opt.toLowerCase()));
    if (uniqueOptions.size !== 4) {
      throw new Error(`Options must be unique at index ${idx}`);
    }

    if (!q.correctAnswer || typeof q.correctAnswer !== 'string') {
      throw new Error(`correctAnswer missing at index ${idx}`);
    }

    const correctAnswer = q.correctAnswer.trim();
    if (!normalizedOptions.includes(correctAnswer)) {
      throw new Error(`correctAnswer must be inside options at index ${idx}`);
    }

    const slot = slots[idx] || null;
    const difficulty =
      normalizeQuestionDifficulty(q.difficulty) || slot?.difficulty || fallbackDifficulty || 'medium';

    if (!ALLOWED_QUESTION_DIFFICULTIES.includes(difficulty)) {
      throw new Error(`Invalid question difficulty at index ${idx}`);
    }

    const conceptTag =
      typeof q.conceptTag === 'string' && q.conceptTag.trim()
        ? q.conceptTag.trim().slice(0, 100)
        : null;
    const question = q.question.trim();

    return {
      question,
      questionHash: getQuestionHash(question),
      conceptTag,
      difficulty,
      options: normalizedOptions,
      correctAnswer,
      explanation: typeof q.explanation === 'string' ? q.explanation.trim() : ''
    };
  });

  return {
    category: parsedCategory,
    topic: parsedTopic,
    difficulty: fallbackDifficulty,
    questions
  };
};

export default sanitizeQuizResponse;
