import crypto from 'crypto';

export const normalizeQuestionForHash = (text = '') =>
  String(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export const getQuestionHash = (questionText = '') =>
  crypto.createHash('sha256').update(normalizeQuestionForHash(questionText)).digest('hex');
