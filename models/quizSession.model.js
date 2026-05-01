import mongoose from 'mongoose';

const sessionQuestionSchema = new mongoose.Schema(
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
    correctAnswer: { type: String, required: true },
    explanation: { type: String, default: '' }
  },
  { _id: false }
);

const quizSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: { type: String, default: 'Uncategorized', index: true },
    topic: { type: String, required: true, index: true },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard', 'mixed'], required: true },
    timeLimitMinutes: { type: Number, enum: [5, 10, 15], required: true },
    questions: { type: [sessionQuestionSchema], required: true },
    adaptationPlan: { type: Object, default: null },
    violationCount: { type: Number, default: 0, min: 0 },
    submittedAt: { type: Date, default: null },
    lastViolationAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['active', 'submitting', 'submitted', 'expired'],
      default: 'active',
      index: true
    }
  },
  {
    timestamps: true
  }
);

quizSessionSchema.index(
  { userId: 1, topic: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['active', 'submitting'] }
    }
  }
);
quizSessionSchema.index({ userId: 1, status: 1, expiresAt: 1 });

const QuizSession = mongoose.model('QuizSession', quizSessionSchema);
export default QuizSession;
