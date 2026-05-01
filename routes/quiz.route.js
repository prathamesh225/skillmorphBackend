import express from 'express';
import isAuth from '../middlewares/isAuth.js';
import {
  getActiveQuizSession,
  getQuizAttemptDetail,
  getQuizHistory,
  getQuizTopics,
  recordQuizViolation,
  startQuiz,
  submitQuiz
} from '../controllers/quiz.controller.js';

const quizRouter = express.Router();

quizRouter.get('/topics', isAuth, getQuizTopics);
quizRouter.get('/session/active', isAuth, getActiveQuizSession);
quizRouter.post('/session/violation', isAuth, recordQuizViolation);
quizRouter.post('/start', isAuth, startQuiz);
quizRouter.post('/submit', isAuth, submitQuiz);
quizRouter.get('/history', isAuth, getQuizHistory);
quizRouter.get('/history/:id', isAuth, getQuizAttemptDetail);

export default quizRouter;
