import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __adaptiveQuizTestables,
  generateAdaptiveQuiz
} from './services/adaptiveQuiz.service.js';
import { getQuestionHash } from './utils/questionHash.js';

const buildValidQuizPayload = ({
  topic = 'Profit and Loss',
  difficulty = 'easy',
  complex = true
} = {}) => {
  const mediumTemplates = [
    (i) =>
      `A shop offers ${12 + i}% discount, then applies ${5 + (i % 4)}% tax; what is the minimum marked price needed to collect ${950 + i * 35}?`,
    (i) =>
      `In a two-phase sale, an item gets ${8 + i}% markup and then ${6 + (i % 3)}% markdown. Which option is closest to final value for base ${700 + i * 40}?`,
    (i) =>
      `A train covers equal distances at ${40 + i} km/h and ${60 + i} km/h. Which option gives the correct average speed with least error?`,
    (i) =>
      `A mixture has milk-water ratio ${3 + (i % 3)}:${2 + (i % 2)}. After adding ${10 + i} liters water, which ratio is closest to target 1:1?`,
    (i) =>
      `A worker and machine complete a task in ${12 + (i % 3)} and ${18 + (i % 4)} days. What is the least time if both work together for full shift?`,
    (i) =>
      `A bill is split across three departments in ratio ${2 + (i % 2)}:${3 + (i % 3)}:${4 + (i % 4)}. Which option is the maximum second-share under total ${1800 + i * 60}?`,
    (i) =>
      `An exam has +4 and -1 marking; a student attempted ${50 + i} with ${30 + (i % 10)} correct. Which score cannot be true?`,
    (i) =>
      `A vendor buys at ${500 + i * 20}, pays ${7 + (i % 3)}% transport, and wants ${15 + (i % 4)}% net gain. What should be the least selling price?`,
    (i) =>
      `Two pipes fill a tank in ${10 + (i % 3)} and ${15 + (i % 4)} minutes, while a leak empties in ${30 + i} minutes. Which completion time is closest?`,
    (i) =>
      `A coding contest ranks by score then penalty. If candidate gains ${20 + i} score but +${5 + (i % 3)} penalty, which position shift is most likely?`
  ];

  const hardTemplates = [
    (i) =>
      `A firm allocates budget to procurement, labor, and logistics in ratio ${2 + (i % 3)}:${3 + (i % 4)}:${4 + (i % 5)}; if labor rises ${7 + (i % 4)}% and rebate applies only above ${18 + (i % 4)}% margin, which revised selling price is closest to maximum feasible profit?`,
    (i) =>
      `A vessel route has three segments with speeds ${22 + i}, ${28 + i}, and ${35 + i} km/h, with waiting delays and fuel surcharge slabs. Which option is the minimum total trip cost when delay exceeds ${12 + (i % 4)} minutes?`,
    (i) =>
      `In a data-interpretation case, quarterly revenue grows by ${10 + (i % 5)}%, costs vary non-linearly, and tax changes at threshold ${120 + i * 5}. Which projection cannot satisfy both margin and cash constraints?`,
    (i) =>
      `A factory line has defect probabilities from machine A and B plus inspection miss-rate. Under replacement policy and penalty cap, which lot size gives the least expected loss?`,
    (i) =>
      `Given two discount chains and one cashback condition, what is the closest effective discount if GST is applied after cashback only when invoice exceeds ${1500 + i * 40}?`,
    (i) =>
      `A team assignment problem has skill, time-window, and dependency constraints. Which schedule maximizes completed tasks without violating minimum review coverage?`,
    (i) =>
      `Three investments have different compounding frequencies and lock-in penalties. Which allocation yields maximum maturity while keeping worst-case liquidity above ${2500 + i * 90}?`,
    (i) =>
      `A network packet system has retry limits, queue decay, and variable latency bands. Which threshold pair minimizes dropped packets under peak load?`,
    (i) =>
      `A warehouse uses tiered storage rates, handling fees, and spoilage risk. Which monthly order plan gives least total cost if demand variance remains above ${14 + (i % 4)}%?`,
    (i) =>
      `A hiring funnel has stage-wise conversion rates and interview capacity caps. Which candidate mix maximizes hires while keeping average quality score not less than ${78 + (i % 4)}?`
  ];

  const questions = Array.from({ length: 10 }).map((_, idx) => {
    const questionEasy = `What is ${idx + 12}% of ${200 + idx * 10}?`;
    const questionMedium = mediumTemplates[idx](idx);
    const questionHard = `${hardTemplates[idx](idx)} Consider overhead charges, compliance adjustments, and seasonal demand variation before selecting the final option.`;
    const questionSimpleForHard = `Find the value of ${20 + idx} + ${30 + idx}.`;

    const question =
      difficulty === 'hard'
        ? complex
          ? questionHard
          : questionSimpleForHard
        : difficulty === 'medium'
          ? complex
            ? questionMedium
            : questionEasy
          : questionEasy;

    return {
      question,
      options: [
        `${800 + idx * 20}`,
        `${840 + idx * 20}`,
        `${880 + idx * 20}`,
        `${920 + idx * 20}`
      ],
      correctAnswer: `${840 + idx * 20}`,
      explanation: 'Combine all constraints, compute adjusted cost, then select nearest valid option.'
    };
  });

  return {
    topic,
    difficulty,
    questions
  };
};

test('extractFirstJsonBlock parses JSON wrapped in non-JSON text', () => {
  const wrapped = `noise\n${JSON.stringify({ a: 1, b: { c: true } })}\nnoise`;
  const parsed = __adaptiveQuizTestables.extractFirstJsonBlock(wrapped);
  assert.deepEqual(parsed, { a: 1, b: { c: true } });
});

test('validateQuizPayload trims explanation length beyond cap', () => {
  const tooLong = {
    topic: 'Profit and Loss',
    difficulty: 'easy',
    questions: Array.from({ length: 10 }).map((_, idx) => ({
      question: `Question ${idx + 1}`,
      options: ['A', 'B', 'C', 'D'],
      correctAnswer: 'A',
      explanation:
        'This explanation intentionally contains far more than twenty words so the validator must trim it instead of rejecting quiz payloads during service hardening tests.'
    }))
  };

  const validated = __adaptiveQuizTestables.validateQuizPayload({
    payload: tooLong,
    topic: 'Profit and Loss',
    difficulty: 'easy'
  });

  assert.ok(validated.questions[0].explanation.split(/\s+/).length <= 20);
});

test('validateQuizPayload maps letter-style correctAnswer to the matching option', () => {
  const payload = {
    topic: 'Simple Interest',
    difficulty: 'easy',
    questions: Array.from({ length: 10 }).map((_, idx) => ({
      question: `SI Question ${idx + 1}`,
      options: ['A) 120', 'B) 180', 'C) 240', 'D) 360'],
      correctAnswer: 'B',
      explanation: 'Apply simple interest formula and substitute values.'
    }))
  };

  const validated = __adaptiveQuizTestables.validateQuizPayload({
    payload,
    topic: 'Simple Interest',
    difficulty: 'easy'
  });

  assert.equal(validated.questions[0].options[0], '120');
  assert.equal(validated.questions[0].options[1], '180');
  assert.equal(validated.questions[0].correctAnswer, '180');
});

test('generateAdaptiveQuiz uses a single primary-model attempt', async () => {
  const modelCalls = [];
  const aiClient = async (_messages, options = {}) => {
    modelCalls.push(options.model);
    return JSON.stringify(buildValidQuizPayload({ difficulty: 'hard', complex: true }));
  };

  const result = await generateAdaptiveQuiz({
    topic: 'Profit and Loss',
    difficulty: 'hard',
    primaryModel: 'primary-model',
    aiClient
  });

  assert.equal(modelCalls[0], 'primary-model');
  assert.equal(modelCalls.length, 1);
  assert.equal(result.modelUsed, 'primary-model');
  assert.equal(result.questions.length, 10);
});

test('enforceDifficultyComplexity still reports weak hard payloads', () => {
  const weakHard = buildValidQuizPayload({ difficulty: 'hard', complex: false });

  assert.throws(
    () =>
      __adaptiveQuizTestables.enforceDifficultyComplexity({
        questions: weakHard.questions,
        difficulty: 'hard'
      }),
    /difficulty-enrichment mismatch/
  );
});

test('generateAdaptiveQuiz allows recent-history collisions and returns warnings', async () => {
  const repeatedPayload = buildValidQuizPayload({ difficulty: 'hard', complex: true });
  let callCount = 0;
  const aiClient = async () => {
    callCount += 1;
    return JSON.stringify(repeatedPayload);
  };

  const result = await generateAdaptiveQuiz({
    category: 'Quantitative Aptitude',
    topic: 'Profit and Loss',
    difficulty: 'hard',
    primaryModel: 'primary-model',
    recentHashes: [getQuestionHash(repeatedPayload.questions[0].question)],
    recentQuestionAnchors: [repeatedPayload.questions[0].question],
    aiClient
  });

  assert.equal(callCount, 1);
  assert.equal(result.questions.length, 10);
  assert.match(result.qualityWarnings.join(' | '), /repeat warning|difficulty-enrichment mismatch|quality check warning/);
});

test('buildPrompt includes category context for the model', () => {
  const prompt = __adaptiveQuizTestables.buildPrompt({
    category: 'Logical Reasoning',
    topic: 'Blood Relations',
    difficulty: 'medium'
  });

  assert.match(prompt[1].content, /Category: Logical Reasoning/);
  assert.match(prompt[1].content, /logical consistency|arrangement constraints|analytical reasoning/i);
});

test('generateAdaptiveQuiz falls back to a local quiz when AI output is invalid', async () => {
  const aiClient = async () => 'still-invalid-response';

  const result = await generateAdaptiveQuiz({
    topic: 'Profit and Loss',
    difficulty: 'easy',
    primaryModel: 'primary-model',
    aiClient
  });

  assert.equal(result.modelUsed, 'local-fallback');
  assert.equal(result.questions.length, 10);
  assert.equal(result.fallbackUsed, true);
  assert.match(result.qualityWarnings[0], /fallback quiz used/i);
});

test('validateQuizPayload repairs duplicate sanitized options instead of rejecting the quiz', () => {
  const payload = {
    topic: 'Simple Interest',
    difficulty: 'easy',
    questions: Array.from({ length: 10 }).map((_, idx) => ({
      question: `Question ${idx + 1}`,
      options: ['A) 120', 'B) 120', 'C) 240', 'D) 360'],
      correctAnswer: 'A',
      explanation: 'Apply the formula and pick the correct result.'
    }))
  };

  const validated = __adaptiveQuizTestables.validateQuizPayload({
    payload,
    topic: 'Simple Interest',
    difficulty: 'easy'
  });

  assert.deepEqual(validated.questions[0].options, ['A) 120', 'B) 120', 'C) 240', 'D) 360']);
  assert.equal(validated.questions[0].correctAnswer, 'A) 120');
});


test('validateQuizPayload fills missing explanations with a concise fallback', () => {
  const payload = {
    topic: 'Profit and Loss',
    difficulty: 'easy',
    questions: Array.from({ length: 10 }).map((_, idx) => ({
      question: `What is ${idx + 10}% of ${200 + idx * 5}?`,
      options: ['20', '25', '30', '35'],
      correctAnswer: '20',
      explanation: ''
    }))
  };

  const validated = __adaptiveQuizTestables.validateQuizPayload({
    payload,
    topic: 'Profit and Loss',
    difficulty: 'easy'
  });

  assert.match(validated.questions[0].explanation, /The correct option/);
  assert.ok(validated.questions[0].explanation.split(/\s+/).length <= 20);
});

test('validateQuizPayload repairs option arrays that do not contain exactly four items', () => {
  const payload = {
    topic: 'Simple Interest',
    difficulty: 'easy',
    questions: Array.from({ length: 10 }).map((_, idx) => ({
      question: `Interest question ${idx + 1}`,
      options: ['12', '18', '24'],
      correctAnswer: '18',
      explanation: 'Use the simple interest relation.'
    }))
  };

  const validated = __adaptiveQuizTestables.validateQuizPayload({
    payload,
    topic: 'Simple Interest',
    difficulty: 'easy'
  });

  assert.equal(validated.questions[0].options.length, 4);
  assert.equal(validated.questions[0].correctAnswer, '18');
});

test('validateQuizPayload repairs obviously truncated question text', () => {
  const payload = {
    topic: 'Simple Interest',
    difficulty: 'easy',
    questions: Array.from({ length: 10 }).map((_, idx) => ({
      question: `What is the simple interest on principal ${1000 + idx * 10} when`,
      options: ['100', '120', '140', '160'],
      correctAnswer: '120',
      explanation: 'Use the simple interest relation.'
    }))
  };

  const validated = __adaptiveQuizTestables.validateQuizPayload({
    payload,
    topic: 'Simple Interest',
    difficulty: 'easy'
  });

  assert.match(validated.questions[0].question, /Choose the correct option|Select the correct option/);
});
