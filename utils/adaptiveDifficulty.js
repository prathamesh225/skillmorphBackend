export const getAdaptiveDifficulty = (lastScore) => {
  if (typeof lastScore !== 'number') return 'easy';
  if (lastScore >= 8) return 'hard';
  if (lastScore >= 5) return 'medium';
  return 'easy';
};
