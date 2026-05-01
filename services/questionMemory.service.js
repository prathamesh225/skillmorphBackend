import QuestionMemory from '../models/questionMemory.model.js';
import { getQuestionHash } from '../utils/questionHash.js';

export const fetchRecentQuestionHashes = async ({ userId, topic, limit = 30 }) => {
  const logs = await QuestionMemory.find({ userId, topic })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('questionHash')
    .lean();

  return [...new Set(logs.map((item) => item.questionHash).filter(Boolean))];
};

export const detectHashCollisions = ({ questions = [], recentHashes = [] }) => {
  const recentSet = new Set(recentHashes);
  const localSet = new Set();
  const collisions = [];

  for (const question of questions) {
    const hash = question.questionHash || getQuestionHash(question.question || '');
    if (recentSet.has(hash) || localSet.has(hash)) {
      collisions.push(hash);
    }
    localSet.add(hash);
  }

  return [...new Set(collisions)];
};

export const storeQuestionHashes = async ({ userId, topic, questions = [], maxPerTopic = 100 }) => {
  if (!questions.length) return;

  const docs = questions.map((question) => ({
    userId,
    topic,
    questionHash: question.questionHash || getQuestionHash(question.question || ''),
    createdAt: new Date()
  }));

  await QuestionMemory.insertMany(docs, { ordered: false });

  const overflowDocs = await QuestionMemory.find({ userId, topic })
    .sort({ createdAt: -1 })
    .skip(maxPerTopic)
    .select('_id')
    .lean();

  if (overflowDocs.length) {
    await QuestionMemory.deleteMany({ _id: { $in: overflowDocs.map((item) => item._id) } });
  }
};
