import mongoose from 'mongoose';

const answerSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    questionHash: { type: String, default: null },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard', 'very_hard'], default: 'medium' },
    options: {
      type: [String],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length === 4,
        message: 'Each question must have exactly 4 options.'
      }
    },
    selectedAnswer: { type: String, default: '' },
    correctAnswer: { type: String, required: true },
    isCorrect: { type: Boolean, required: true },
    explanation: { type: String, default: '' }
  },
  { _id: false }
);

const feedbackSchema = new mongoose.Schema(
  {
    summary: { type: String, default: '' },
    strengths: { type: [String], default: [] },
    weakAreas: { type: [String], default: [] },
    improvementTips: { type: [String], default: [] },
    nextFocus: { type: String, default: '' },
    skillScores: {
      conceptualClarity: { type: Number, min: 0, max: 100, default: 0 },
      timeManagement: { type: Number, min: 0, max: 100, default: 0 },
      accuracy: { type: Number, min: 0, max: 100, default: 0 },
      focusDiscipline: { type: Number, min: 0, max: 100, default: 0 }
    }
  },
  { _id: false }
);

const quizAttemptSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'QuizSession',
      required: true,
      unique: true,
      index: true
    },
    category: { type: String, default: 'Uncategorized', index: true },
    topic: { type: String, required: true, index: true },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard', 'mixed'], required: true },
    score: { type: Number, required: true },
    totalQuestions: { type: Number, required: true },
    percentage: { type: Number, required: true },
    submissionMode: {
      type: String,
      enum: ['manual', 'auto_expiry', 'auto_violation'],
      default: 'manual'
    },
    feedback: { type: feedbackSchema, default: () => ({}) },
    answers: { type: [answerSchema], required: true },
    timeTakenSeconds: { type: Number, required: true },
    violations: { type: Number, default: 0 }
  },
  {
    timestamps: true
  }
);

const QuizAttempt = mongoose.model('QuizAttempt', quizAttemptSchema);
export default QuizAttempt;
