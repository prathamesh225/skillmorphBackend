import test from 'node:test';
import assert from 'node:assert/strict';

import { getFlatTopics } from './config/topics.js';
import {
  __quizControllerTestables,
  recordQuizViolation,
  startQuiz,
  submitQuiz
} from './controllers/quiz.controller.js';
import QuizSession from './models/quizSession.model.js';
import QuizAttempt from './models/quizAttempt.model.js';

const createRes = () => {
  const res = {};
  res.statusCode = 200;
  res.payload = null;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.payload = body;
    return res;
  };
  return res;
};

const originalSessionMethods = {
  updateMany: QuizSession.updateMany,
  findOne: QuizSession.findOne,
  create: QuizSession.create,
  updateOne: QuizSession.updateOne,
  findOneAndUpdate: QuizSession.findOneAndUpdate
};

const originalAttemptMethods = {
  findOne: QuizAttempt.findOne,
  create: QuizAttempt.create
};

const resetModelMethods = () => {
  QuizSession.updateMany = originalSessionMethods.updateMany;
  QuizSession.findOne = originalSessionMethods.findOne;
  QuizSession.create = originalSessionMethods.create;
  QuizSession.updateOne = originalSessionMethods.updateOne;
  QuizSession.findOneAndUpdate = originalSessionMethods.findOneAndUpdate;

  QuizAttempt.findOne = originalAttemptMethods.findOne;
  QuizAttempt.create = originalAttemptMethods.create;
};

test.afterEach(() => {
  resetModelMethods();
});

test('startQuiz reuses an existing active session instead of creating duplicates', async () => {
  const topic = getFlatTopics()[0];
  const userId = '507f191e810c19729de860ea';
  let created = false;

  QuizSession.updateMany = async () => ({ modifiedCount: 0 });
  QuizSession.findOne = () => ({
    sort: async () => ({
      _id: 'session-1',
      category: 'Quantitative Ability',
      topic,
      difficulty: 'easy',
      timeLimitMinutes: 10,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      violationCount: 0,
      questions: [{ question: 'Q1', options: ['A', 'B', 'C', 'D'] }]
    })
  });
  QuizSession.create = async () => {
    created = true;
    throw new Error('Should not be called when active session exists');
  };

  const req = {
    userId,
    body: { category: 'Quantitative Ability', topic, timeLimitMinutes: 10 }
  };
  const res = createRes();

  await startQuiz(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.reusedSession, true);
  assert.equal(created, false);
  assert.equal(Array.isArray(res.payload?.questions), true);
  assert.equal(Object.prototype.hasOwnProperty.call(res.payload.questions[0], 'correctAnswer'), false);
});

test('submitQuiz returns existing attempt for duplicate submission race', async () => {
  const userId = '507f191e810c19729de860eb';
  const sessionId = '507f191e810c19729de860ec';

  QuizSession.updateOne = async () => ({ modifiedCount: 0 });
  QuizSession.findOneAndUpdate = async () => null;
  QuizAttempt.findOne = async () => ({
    _id: 'attempt-1',
    category: 'Quantitative Ability',
    topic: 'Profit and Loss',
    difficulty: 'medium',
    score: 7,
    totalQuestions: 10,
    percentage: 70,
    timeTakenSeconds: 420,
    violations: 1,
    submissionMode: 'manual',
    feedback: { summary: 'ok' },
    answers: [],
    createdAt: new Date()
  });

  const req = {
    userId,
    body: {
      sessionId,
      answers: [{ questionIndex: 0, selectedAnswer: 'A' }]
    }
  };
  const res = createRes();

  await submitQuiz(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.duplicateSubmission, true);
  assert.equal(res.payload?.attemptId, 'attempt-1');
});

test('recordQuizViolation returns incremented server count', async () => {
  QuizSession.findOneAndUpdate = () => ({
    select: async () => ({
      violationCount: 3,
      status: 'active'
    })
  });

  const req = {
    userId: '507f191e810c19729de860ed',
    body: { sessionId: '507f191e810c19729de860ee' }
  };
  const res = createRes();

  await recordQuizViolation(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.violationCount, 3);
  assert.equal(res.payload?.status, 'active');
});

test('computeSafeTimeTaken cannot be under-reported by client payload', () => {
  const createdAt = new Date(Date.now() - 90_000);
  const { safeTimeTaken, inferredTime } = __quizControllerTestables.computeSafeTimeTaken({
    session: {
      createdAt,
      timeLimitMinutes: 10
    },
    clientReportedSeconds: 2
  });

  assert.equal(safeTimeTaken >= inferredTime, true);
  assert.equal(safeTimeTaken >= 89, true);
});
