import mongoose from 'mongoose';

const questionMemorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    topic: { type: String, required: true, trim: true, index: true },
    questionHash: { type: String, required: true, trim: true, index: true },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: false }
);

questionMemorySchema.index({ userId: 1, topic: 1, createdAt: -1 });
questionMemorySchema.index({ userId: 1, topic: 1, questionHash: 1 });

const QuestionMemory = mongoose.model('QuestionMemory', questionMemorySchema);

export default QuestionMemory;
