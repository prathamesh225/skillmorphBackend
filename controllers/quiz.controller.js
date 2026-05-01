import {
  getCategoryForTopic,
  getFlatTopics,
  getTopicCatalog,
  getTopicDescriptions,
  toCanonicalCategory,
  toCanonicalTopic
} from '../config/topics.js';
import QuizSession from '../models/quizSession.model.js';
import QuizAttempt from '../models/quizAttempt.model.js';
import User from '../models/user.model.js';
import {
  generateOverallQuizSummary,
  generateQuizFeedback
} from '../services/quizAi.service.js';
import { generateAdaptiveQuiz } from '../services/adaptiveQuiz.service.js';
import {
  fetchRecentQuestionHashes,
    storeQuestionHashes
} from '../services/questionMemory.service.js';

const VALID_TIMERS = [5, 10, 15];
const MAX_VIOLATIONS = 5;

const toSafeViolationCount = (value) => Math.max(0, Number(value) || 0);
const normalizeQuestionFingerprint = (text = '') =>
  String(text || '')
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\b/g, '#')
    .replace(/[^a-z#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildRecentQuestionFingerprints = (attempts = [], limit = 24) => {
  const fingerprints = [];
  const seen = new Set();

  for (const attempt of attempts) {
    const answers = Array.isArray(attempt?.answers) ? attempt.answers : [];

    for (const answer of answers) {
      const normalized = normalizeQuestionFingerprint(answer?.question || '')
        .split(' ')
        .slice(0, 18)
        .join(' ');

      if (!normalized || normalized.split(' ').length < 6) continue;
      if (seen.has(normalized)) continue;

      seen.add(normalized);
      fingerprints.push(normalized);
      if (fingerprints.length >= limit) {
        return fingerprints;
      }
    }
  }

  return fingerprints;
};

const buildRecentQuestionAnchors = (attempts = [], limit = 12) => {
  const anchors = [];
  const seen = new Set();

  for (const attempt of attempts) {
    const answers = Array.isArray(attempt?.answers) ? attempt.answers : [];

    for (const answer of answers) {
      const raw = String(answer?.question || '').replace(/\s+/g, ' ').trim();
      if (!raw || raw.split(' ').length < 5) continue;

      const normalized = normalizeQuestionFingerprint(raw)
        .split(' ')
        .slice(0, 20)
        .join(' ');

      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      anchors.push(raw.slice(0, 130));

      if (anchors.length >= limit) {
        return anchors;
      }
    }
  }

  return anchors;
};

const buildRecentQuestionTexts = (attempts = [], limit = 20) => {
  const questions = [];
  const seen = new Set();

  for (const attempt of attempts) {
    const answers = Array.isArray(attempt?.answers) ? attempt.answers : [];

    for (const answer of answers) {
      const raw = String(answer?.question || '').replace(/\s+/g, ' ').trim();
      if (!raw || raw.split(' ').length < 5) continue;

      const normalized = normalizeQuestionFingerprint(raw)
        .split(' ')
        .slice(0, 24)
        .join(' ');

      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      questions.push(raw.slice(0, 220));

      if (questions.length >= limit) {
        return questions;
      }
    }
  }

  return questions;
};

const serializeSessionForClient = (session) => ({
  sessionId: session._id,
  category: session.category || getCategoryForTopic(session.topic) || 'Uncategorized',
  topic: session.topic,
  difficulty: session.difficulty,
  timeLimitMinutes: session.timeLimitMinutes,
  startedAt: session.createdAt,
  expiresAt: session.expiresAt,
  violationCount: toSafeViolationCount(session.violationCount),
  questions: (session.questions || []).map((q, index) => ({
    index,
    question: q.question,
    options: q.options
  }))
});

const serializeAttemptForClient = (attempt) => ({
  attemptId: attempt._id,
  category: attempt.category || getCategoryForTopic(attempt.topic) || 'Uncategorized',
  topic: attempt.topic,
  difficulty: attempt.difficulty,
  score: attempt.score,
  totalQuestions: attempt.totalQuestions,
  percentage: attempt.percentage,
  timeTakenSeconds: attempt.timeTakenSeconds,
  violations: toSafeViolationCount(attempt.violations),
  submissionMode: attempt.submissionMode || 'manual',
  feedback: attempt.feedback,
  answers: attempt.answers,
  submittedAt: attempt.createdAt
});

const markExpiredSessions = async ({ userId, topic = '' }) => {
  const query = {
    userId,
    status: { $in: ['active', 'submitting'] },
    expiresAt: { $lte: new Date() }
  };
  if (topic) query.topic = topic;

  await QuizSession.updateMany(query, { $set: { status: 'expired' } });
};

const computeSafeTimeTaken = ({ session, clientReportedSeconds }) => {
  const maxSeconds = Math.max(1, Number(session.timeLimitMinutes) * 60);
  const inferredTime = Math.max(0, Math.floor((Date.now() - new Date(session.createdAt).getTime()) / 1000));

  const claimed = Number(clientReportedSeconds);
  const normalizedClaim = Number.isFinite(claimed) && claimed >= 0 ? claimed : inferredTime;
  const hardenedSeconds = Math.max(inferredTime, normalizedClaim);

  return {
    maxSeconds,
    inferredTime,
    safeTimeTaken: Math.min(maxSeconds, hardenedSeconds)
  };
};

const resolveDifficultyFromLastScore = (lastScore) => {
  if (!Number.isFinite(lastScore)) return 'easy';
  if (lastScore >= 8) return 'hard';
  if (lastScore >= 5 && lastScore <= 7) return 'medium';
  return 'easy';
};

export const __quizControllerTestables = {
  resolveDifficultyFromLastScore,
  computeSafeTimeTaken
};

const buildAggregateMetrics = (attempts = []) => {
  const totalAttempts = attempts.length;

  if (!totalAttempts) {
    return {
      totalAttempts: 0,
      avgPercentage: 0,
      avgScoreOutOfTen: 0,
      avgTimeTakenSeconds: 0,
      avgSecondsPerQuestion: 0,
      avgViolations: 0,
      zeroViolationRate: 0,
      recentTrendDelta: 0,
      recentTrendDirection: 'flat',
      difficultyDistribution: { easy: 0, medium: 0, hard: 0, mixed: 0 },
      topCategories: [],
      strongTopics: [],
      weakTopics: []
    };
  }

  const categoryMap = new Map();
  const topicMap = new Map();
  const difficultyDistribution = { easy: 0, medium: 0, hard: 0, mixed: 0 };

  let percentageSum = 0;
  let scoreOutOfTenSum = 0;
  let totalTimeTaken = 0;
  let totalViolations = 0;
  let zeroViolationCount = 0;
  let totalQuestions = 0;

  for (const attempt of attempts) {
    const category = attempt.category || getCategoryForTopic(attempt.topic) || 'Uncategorized';
    const topic = attempt.topic || 'Unknown Topic';
    const percentage = Number(attempt.percentage) || 0;
    const score = Number(attempt.score) || 0;
    const questionCount = Math.max(1, Number(attempt.totalQuestions) || 1);
    const scoreOutOfTen = (score / questionCount) * 10;
    const timeTakenSeconds = Math.max(0, Number(attempt.timeTakenSeconds) || 0);
    const violations = Math.max(0, Number(attempt.violations) || 0);
    const difficulty = String(attempt.difficulty || 'medium').toLowerCase();

    if (Object.prototype.hasOwnProperty.call(difficultyDistribution, difficulty)) {
      difficultyDistribution[difficulty] += 1;
    }

    percentageSum += percentage;
    scoreOutOfTenSum += scoreOutOfTen;
    totalTimeTaken += timeTakenSeconds;
    totalViolations += violations;
    totalQuestions += questionCount;
    if (violations === 0) zeroViolationCount += 1;

    if (!categoryMap.has(category)) {
      categoryMap.set(category, { category, attempts: 0, percentageSum: 0 });
    }
    const categoryAgg = categoryMap.get(category);
    categoryAgg.attempts += 1;
    categoryAgg.percentageSum += percentage;

    if (!topicMap.has(topic)) {
      topicMap.set(topic, { topic, category, attempts: 0, percentageSum: 0 });
    }
    const topicAgg = topicMap.get(topic);
    topicAgg.attempts += 1;
    topicAgg.percentageSum += percentage;
  }

  const toSortedRows = (map) =>
    [...map.values()].map((item) => ({
      ...item,
      avgPercentage: Number((item.percentageSum / item.attempts).toFixed(2))
    }));

  const categoryRows = toSortedRows(categoryMap).sort((a, b) => b.avgPercentage - a.avgPercentage);
  const topicRows = toSortedRows(topicMap).sort((a, b) => b.avgPercentage - a.avgPercentage);

  const recentAttempts = attempts.slice(0, 5);
  const previousAttempts = attempts.slice(5, 10);
  const recentAvg =
    recentAttempts.length > 0
      ? recentAttempts.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0) /
        recentAttempts.length
      : 0;
  const previousAvg =
    previousAttempts.length > 0
      ? previousAttempts.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0) /
        previousAttempts.length
      : recentAvg;
  const recentTrendDelta = Number((recentAvg - previousAvg).toFixed(2));

  return {
    totalAttempts,
    avgPercentage: Number((percentageSum / totalAttempts).toFixed(2)),
    avgScoreOutOfTen: Number((scoreOutOfTenSum / totalAttempts).toFixed(2)),
    avgTimeTakenSeconds: Number((totalTimeTaken / totalAttempts).toFixed(2)),
    avgSecondsPerQuestion: Number((totalTimeTaken / Math.max(1, totalQuestions)).toFixed(2)),
    avgViolations: Number((totalViolations / totalAttempts).toFixed(2)),
    zeroViolationRate: Math.round((zeroViolationCount / totalAttempts) * 100),
    recentTrendDelta,
    recentTrendDirection: recentTrendDelta > 2 ? 'up' : recentTrendDelta < -2 ? 'down' : 'flat',
    difficultyDistribution,
    topCategories: categoryRows.slice(0, 5),
    strongTopics: topicRows.slice(0, 5),
    weakTopics: [...topicRows].sort((a, b) => a.avgPercentage - b.avgPercentage).slice(0, 5)
  };
};

const refreshUserOverallSummary = async (userId) => {
  const attempts = await QuizAttempt.find({ userId })
    .sort({ createdAt: -1 })
    .select('category topic difficulty score totalQuestions percentage timeTakenSeconds violations createdAt')
    .lean();

  const aggregate = buildAggregateMetrics(attempts);
  if (!aggregate.totalAttempts) {
    return {
      summary: null,
      updatedAt: null,
      sampleSize: 0
    };
  }

  const summary = await generateOverallQuizSummary({ aggregate });
  const updatedAt = new Date();

  await User.findByIdAndUpdate(userId, {
    quizOverallSummary: summary,
    quizOverallSummaryUpdatedAt: updatedAt,
    quizOverallSummarySampleSize: aggregate.totalAttempts
  });

  return {
    summary,
    updatedAt,
    sampleSize: aggregate.totalAttempts
  };
};

export const getQuizTopics = (req, res) => {
  return res.status(200).json({
    categories: getTopicCatalog(),
    topics: getFlatTopics(),
    topicDescriptions: getTopicDescriptions()
  });
};

export const startQuiz = async (req, res) => {
  try {
    const { category = '', topic = '', timeLimitMinutes } = req.body;

    const canonicalTopic = toCanonicalTopic(topic);
    const derivedCategory = getCategoryForTopic(canonicalTopic);
    const canonicalCategory = category ? toCanonicalCategory(category) : derivedCategory;

    if (!canonicalTopic) {
      return res.status(400).json({ message: 'Invalid topic selected.' });
    }

    if (!canonicalCategory) {
      return res.status(400).json({ message: 'Invalid category selected.' });
    }

    if (derivedCategory && canonicalCategory !== derivedCategory) {
      return res.status(400).json({ message: 'Selected topic does not belong to selected category.' });
    }

    const normalizedTimeLimit = Number(timeLimitMinutes);
    if (!VALID_TIMERS.includes(normalizedTimeLimit)) {
      return res.status(400).json({ message: 'Invalid time limit. Use 5, 10, or 15 minutes.' });
    }

    await markExpiredSessions({ userId: req.userId, topic: canonicalTopic });

    const existingActiveSession = await QuizSession.findOne({
      userId: req.userId,
      topic: canonicalTopic,
      status: 'active',
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (existingActiveSession) {
      return res.status(200).json({
        ...serializeSessionForClient(existingActiveSession),
        reusedSession: true
      });
    }

    const lastAttempt = await QuizAttempt.findOne({ userId: req.userId, topic: canonicalTopic })
      .sort({ createdAt: -1 })
      .select('score');

    const difficulty = resolveDifficultyFromLastScore(Number(lastAttempt?.score));

    const recentHashes = await fetchRecentQuestionHashes({
      userId: req.userId,
      topic: canonicalTopic,
      limit: 30
    });

    const recentAttempts = await QuizAttempt.find({
      userId: req.userId,
      topic: canonicalTopic
    })
      .sort({ createdAt: -1 })
      .limit(4)
      .select('answers.question')
      .lean();

    const recentQuestionFingerprints = buildRecentQuestionFingerprints(recentAttempts, 24);
    const recentQuestionAnchors = buildRecentQuestionAnchors(recentAttempts, 12);
    const recentQuestionTexts = buildRecentQuestionTexts(recentAttempts, 20);

    const generated = await generateAdaptiveQuiz({
      category: canonicalCategory,
      topic: canonicalTopic,
      difficulty,
      strongerVariation: false,
      recentHashes,
      recentQuestionFingerprints,
      recentQuestionAnchors,
      recentQuestionTexts,
      primaryModel: process.env.GROQ_QUIZ_MODEL || 'openai/gpt-oss-120b'
    });

    if (Array.isArray(generated.qualityWarnings) && generated.qualityWarnings.length) {
      console.warn(
        `[quiz-generation][warning] topic=${canonicalTopic} category=${canonicalCategory} warnings=${generated.qualityWarnings.join(' | ')}`
      );
    }

    const expiresAt = new Date(Date.now() + normalizedTimeLimit * 60 * 1000);

    let session;
    try {
      session = await QuizSession.create({
        userId: req.userId,
        category: canonicalCategory,
        topic: canonicalTopic,
        difficulty,
        timeLimitMinutes: normalizedTimeLimit,
        questions: generated.questions,
        expiresAt,
        status: 'active',
        adaptationPlan: null,
        violationCount: 0
      });
    } catch (createError) {
      if (createError?.code === 11000) {
        const racedSession = await QuizSession.findOne({
          userId: req.userId,
          topic: canonicalTopic,
          status: 'active',
          expiresAt: { $gt: new Date() }
        }).sort({ createdAt: -1 });

        if (racedSession) {
          return res.status(200).json({
            ...serializeSessionForClient(racedSession),
            reusedSession: true
          });
        }

        return res.status(409).json({
          message: 'Quiz session initialization is in progress. Please retry.'
        });
      }
      throw createError;
    }

    try {
      await storeQuestionHashes({
        userId: req.userId,
        topic: canonicalTopic,
        questions: generated.questions,
        maxPerTopic: 100
      });
    } catch (memoryError) {
      console.warn('[question-memory] failed to persist hashes:', memoryError?.message || memoryError);
    }

    return res.status(201).json(serializeSessionForClient(session));
  } catch (error) {
    return res.status(500).json({ message: `failed to start quiz ${error.message || error}` });
  }
};

export const submitQuiz = async (req, res) => {
  let lockedSession = null;

  try {
    const { sessionId, answers = [], violationCount = 0, timeTakenSeconds, submissionMode = 'manual' } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: 'sessionId is required.' });
    }

    await QuizSession.updateOne(
      {
        _id: sessionId,
        userId: req.userId,
        status: 'active',
        expiresAt: { $lte: new Date() }
      },
      { $set: { status: 'expired' } }
    );

    lockedSession = await QuizSession.findOneAndUpdate(
      {
        _id: sessionId,
        userId: req.userId,
        status: { $in: ['active', 'expired'] }
      },
      { $set: { status: 'submitting' } },
      { new: true }
    );

    if (!lockedSession) {
      const existingAttempt = await QuizAttempt.findOne({ sessionId, userId: req.userId });
      if (existingAttempt) {
        return res.status(200).json({
          ...serializeAttemptForClient(existingAttempt),
          autoSubmitted: existingAttempt.submissionMode !== 'manual',
          duplicateSubmission: true
        });
      }

      const session = await QuizSession.findOne({
        _id: sessionId,
        userId: req.userId
      }).select('status');

      if (!session) {
        return res.status(404).json({ message: 'Active quiz session not found.' });
      }

      if (session.status === 'submitting') {
        return res.status(409).json({ message: 'Submission is already in progress for this session.' });
      }

      if (session.status === 'submitted') {
        return res.status(409).json({ message: 'Quiz is already submitted.' });
      }

      return res.status(400).json({ message: 'Quiz session is not submittable.' });
    }

    const sessionCategory = lockedSession.category || getCategoryForTopic(lockedSession.topic) || 'Uncategorized';
    const safeAnswers = Array.isArray(answers) ? answers : [];

    const answerMap = new Map();
    for (const ans of safeAnswers) {
      const index = Number(ans.questionIndex);
      if (!Number.isNaN(index)) {
        answerMap.set(index, String(ans.selectedAnswer || ''));
      }
    }

    const evaluated = lockedSession.questions.map((question, index) => {
      const selectedAnswer = answerMap.get(index) || '';
      const isCorrect = selectedAnswer === question.correctAnswer;

      return {
        question: question.question,
        questionHash: question.questionHash || null,
        difficulty: question.difficulty || lockedSession.difficulty || 'medium',
        options: question.options,
        selectedAnswer,
        correctAnswer: question.correctAnswer,
        isCorrect,
        explanation: question.explanation || ''
      };
    });

    const score = evaluated.filter((item) => item.isCorrect).length;
    const totalQuestions = lockedSession.questions.length;
    const percentage = Number(((score / Math.max(1, totalQuestions)) * 100).toFixed(2));

    const { maxSeconds, safeTimeTaken } = computeSafeTimeTaken({
      session: lockedSession,
      clientReportedSeconds: timeTakenSeconds
    });

    const sessionExpired = new Date() >= new Date(lockedSession.expiresAt);
    const mergedViolations = Math.max(
      toSafeViolationCount(lockedSession.violationCount),
      toSafeViolationCount(violationCount)
    );

    let finalSubmissionMode = 'manual';
    if (sessionExpired || safeTimeTaken >= maxSeconds) {
      finalSubmissionMode = 'auto_expiry';
    } else if (mergedViolations >= MAX_VIOLATIONS || submissionMode === 'auto_violation') {
      finalSubmissionMode = 'auto_violation';
    }

    const wrongQuestions = evaluated.filter((a) => !a.isCorrect);

    const feedback = await generateQuizFeedback({
      category: sessionCategory,
      topic: lockedSession.topic,
      difficulty: lockedSession.difficulty,
      score,
      totalQuestions,
      wrongQuestions,
      timeTakenSeconds: safeTimeTaken,
      allowedSeconds: maxSeconds,
      violations: mergedViolations
    });

    let attempt;
    try {
      attempt = await QuizAttempt.create({
        userId: req.userId,
        sessionId: lockedSession._id,
        category: sessionCategory,
        topic: lockedSession.topic,
        difficulty: lockedSession.difficulty,
        score,
        totalQuestions,
        percentage,
        submissionMode: finalSubmissionMode,
        feedback,
        answers: evaluated,
        timeTakenSeconds: safeTimeTaken,
        violations: mergedViolations
      });
    } catch (createError) {
      if (createError?.code === 11000) {
        const existingAttempt = await QuizAttempt.findOne({ sessionId: lockedSession._id, userId: req.userId });
        if (existingAttempt) {
          await QuizSession.updateOne(
            { _id: lockedSession._id },
            { $set: { status: 'submitted', submittedAt: existingAttempt.createdAt } }
          );

          return res.status(200).json({
            ...serializeAttemptForClient(existingAttempt),
            autoSubmitted: existingAttempt.submissionMode !== 'manual',
            duplicateSubmission: true
          });
        }
      }
      throw createError;
    }

    await QuizSession.updateOne(
      { _id: lockedSession._id },
      {
        $set: {
          status: 'submitted',
          submittedAt: new Date(),
          violationCount: mergedViolations
        }
      }
    );

    refreshUserOverallSummary(req.userId).catch((summaryErr) => {
      console.error('Failed to refresh overall quiz summary:', summaryErr?.message || summaryErr);
    });

    return res.status(200).json({
      ...serializeAttemptForClient(attempt),
      autoSubmitted: attempt.submissionMode !== 'manual'
    });
  } catch (error) {
    if (lockedSession?._id) {
      await QuizSession.updateOne(
        {
          _id: lockedSession._id,
          status: 'submitting'
        },
        {
          $set: {
            status: new Date() >= new Date(lockedSession.expiresAt) ? 'expired' : 'active'
          }
        }
      ).catch(() => {});
    }

    return res.status(500).json({ message: `failed to submit quiz ${error.message || error}` });
  }
};

export const getActiveQuizSession = async (req, res) => {
  try {
    await markExpiredSessions({ userId: req.userId });

    const session = await QuizSession.findOne({
      userId: req.userId,
      status: 'active',
      expiresAt: { $gt: new Date() }
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!session) {
      return res.status(200).json({ session: null });
    }

    return res.status(200).json({
      session: serializeSessionForClient(session)
    });
  } catch (error) {
    return res.status(500).json({ message: `failed to load active quiz session ${error.message || error}` });
  }
};

export const recordQuizViolation = async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: 'sessionId is required.' });
    }

    const session = await QuizSession.findOneAndUpdate(
      {
        _id: sessionId,
        userId: req.userId,
        status: { $in: ['active', 'submitting'] },
        expiresAt: { $gt: new Date() }
      },
      {
        $inc: { violationCount: 1 },
        $set: { lastViolationAt: new Date() }
      },
      {
        new: true
      }
    ).select('violationCount status');

    if (session) {
      return res.status(200).json({
        violationCount: toSafeViolationCount(session.violationCount),
        status: session.status
      });
    }

    const existing = await QuizSession.findOne({ _id: sessionId, userId: req.userId }).select(
      'status violationCount expiresAt'
    );
    if (!existing) {
      return res.status(404).json({ message: 'Quiz session not found.' });
    }

    if (existing.status === 'submitted') {
      return res.status(200).json({
        violationCount: toSafeViolationCount(existing.violationCount),
        status: existing.status
      });
    }

    if (new Date(existing.expiresAt) <= new Date()) {
      await QuizSession.updateOne({ _id: existing._id, status: existing.status }, { $set: { status: 'expired' } });
      return res.status(409).json({ message: 'Quiz session has expired.' });
    }

    return res.status(409).json({ message: 'Quiz session cannot register more violations.' });
  } catch (error) {
    return res.status(500).json({ message: `failed to record violation ${error.message || error}` });
  }
};

export const getQuizHistory = async (req, res) => {
  try {
    const { topic = '', category = '', limit = 20, includeSummary = '' } = req.query;

    const query = { userId: req.userId };
    const canonicalTopic = topic ? toCanonicalTopic(topic) : '';
    const canonicalCategory = category ? toCanonicalCategory(category) : '';

    if (topic && !canonicalTopic) {
      return res.status(200).json({ attempts: [] });
    }
    if (category && !canonicalCategory) {
      return res.status(200).json({ attempts: [] });
    }

    if (canonicalTopic) {
      query.topic = canonicalTopic;
    }
    if (canonicalCategory) {
      query.category = canonicalCategory;
    }

    const limitNum = Math.min(500, Math.max(1, Number(limit) || 20));

    const attempts = await QuizAttempt.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum)
      .select('category topic difficulty score totalQuestions percentage timeTakenSeconds violations createdAt');

    const normalizedAttempts = attempts.map((attempt) => {
      const plain = attempt.toObject();
      return {
        ...plain,
        category: plain.category || getCategoryForTopic(plain.topic) || 'Uncategorized'
      };
    });

    const shouldIncludeSummary = ['1', 'true', 'yes'].includes(String(includeSummary).toLowerCase());

    if (!shouldIncludeSummary) {
      return res.status(200).json({ attempts: normalizedAttempts });
    }

    const totalAttempts = await QuizAttempt.countDocuments({ userId: req.userId });
    const user = await User.findById(req.userId)
      .select('quizOverallSummary quizOverallSummaryUpdatedAt quizOverallSummarySampleSize')
      .lean();

    let summary = user?.quizOverallSummary || null;
    let summaryUpdatedAt = user?.quizOverallSummaryUpdatedAt || null;
    let summarySampleSize = Number(user?.quizOverallSummarySampleSize) || 0;

    if (!summary || summarySampleSize !== totalAttempts) {
      try {
        const refreshed = await refreshUserOverallSummary(req.userId);
        summary = refreshed.summary;
        summaryUpdatedAt = refreshed.updatedAt;
        summarySampleSize = refreshed.sampleSize;
      } catch (summaryError) {
        summary = null;
        summaryUpdatedAt = null;
        summarySampleSize = 0;
      }
    }

    return res.status(200).json({
      attempts: normalizedAttempts,
      overallSummary: summary
        ? {
            ...summary,
            updatedAt: summaryUpdatedAt,
            sampleSize: summarySampleSize
          }
        : null
    });
  } catch (error) {
    return res.status(500).json({ message: `failed to load quiz history ${error.message || error}` });
  }
};

export const getQuizAttemptDetail = async (req, res) => {
  try {
    const attempt = await QuizAttempt.findOne({ _id: req.params.id, userId: req.userId });

    if (!attempt) {
      return res.status(404).json({ message: 'Attempt not found.' });
    }

    const normalizedAttempt = attempt.toObject();
    normalizedAttempt.category =
      normalizedAttempt.category || getCategoryForTopic(normalizedAttempt.topic) || 'Uncategorized';

    return res.status(200).json({ attempt: normalizedAttempt });
  } catch (error) {
    return res.status(500).json({ message: `failed to load quiz attempt ${error.message || error}` });
  }
};
