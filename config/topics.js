const TOPIC_CATEGORIES = [
  {
    category: 'Quantitative Ability',
    topics: [
      'Percentages',
      'Profit and Loss',
      'Simple Interest',
      'Compound Interest',
      'Ratio and Proportion',
      'Partnership',
      'Average',
      'Mixtures and Alligation',
      'Time and Work',
      'Pipes and Cistern',
      'Time Speed Distance',
      'Trains',
      'Boats and Streams',
      'Number System',
      'HCF and LCM',
      'Remainders',
      'Surds and Indices',
      'Linear Equations',
      'Quadratic Equations',
      'Logarithms',
      'Permutation and Combination',
      'Probability',
      'Geometry Basics',
      'Mensuration',
      'Coordinate Geometry',
      'Data Interpretation'
    ]
  },
  {
    category: 'Logical Reasoning',
    topics: [
      'Seating Arrangement',
      'Circular Arrangement',
      'Linear Arrangement',
      'Puzzles',
      'Blood Relations',
      'Direction Sense',
      'Order and Ranking',
      'Coding Decoding',
      'Syllogisms',
      'Statement and Assumptions',
      'Statement and Conclusions',
      'Cause and Effect',
      'Series Completion',
      'Odd One Out',
      'Analogy'
    ]
  },
  {
    category: 'Verbal Ability',
    topics: [
      'Reading Comprehension',
      'Error Detection',
      'Sentence Correction',
      'Fill in the Blanks',
      'Para Jumbles',
      'Synonyms',
      'Antonyms',
      'Idioms',
      'One Word Substitution'
    ]
  },
  {
    category: 'Technical MCQ',
    topics: [
      'C Programming',
      'Data Structures',
      'Algorithms Basics',
      'Time Complexity',
      'OOP Concepts',
      'DBMS',
      'SQL Queries',
      'Operating Systems',
      'Computer Networks'
    ]
  }
];

const normalize = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const CATEGORY_BY_KEY = new Map();
const TOPIC_BY_KEY = new Map();
const TOPIC_TO_CATEGORY = new Map();
const FLAT_TOPICS = [];
const TOPIC_DESCRIPTIONS = {};

for (const categoryBlock of TOPIC_CATEGORIES) {
  const categoryName = categoryBlock.category;
  CATEGORY_BY_KEY.set(normalize(categoryName), categoryName);

  for (const topic of categoryBlock.topics) {
    const topicKey = normalize(topic);
    TOPIC_BY_KEY.set(topicKey, topic);
    TOPIC_TO_CATEGORY.set(topic, categoryName);
    FLAT_TOPICS.push(topic);
    TOPIC_DESCRIPTIONS[topic] = `${categoryName} • ${topic}`;
  }
}

export const getTopicCatalog = () => TOPIC_CATEGORIES;

export const getFlatTopics = () => FLAT_TOPICS;

export const getTopicDescriptions = () => TOPIC_DESCRIPTIONS;

export const toCanonicalTopic = (topic = '') => TOPIC_BY_KEY.get(normalize(topic)) || '';

export const toCanonicalCategory = (category = '') =>
  CATEGORY_BY_KEY.get(normalize(category)) || '';

export const getCategoryForTopic = (topic = '') => {
  const canonicalTopic = toCanonicalTopic(topic);
  if (!canonicalTopic) return '';
  return TOPIC_TO_CATEGORY.get(canonicalTopic) || '';
};

export const isValidTopic = (topic = '') => Boolean(toCanonicalTopic(topic));

export const isValidCategory = (category = '') => Boolean(toCanonicalCategory(category));

export const getTopicsByCategory = (category = '') => {
  const canonicalCategory = toCanonicalCategory(category);
  if (!canonicalCategory) return [];
  return (
    TOPIC_CATEGORIES.find((block) => block.category === canonicalCategory)?.topics || []
  );
};

export default TOPIC_CATEGORIES;
