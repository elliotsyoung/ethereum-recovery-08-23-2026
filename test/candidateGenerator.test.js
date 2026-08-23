const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCandidate, calculateCandidateSpace, getDefaultPatternConfig } = require('../server/recovery/candidateGenerator');

test('candidate generation is deterministic', () => {
  const config = getDefaultPatternConfig();
  const first = generateCandidate(config, 42);
  const second = generateCandidate(config, 42);
  assert.equal(first, second);
});

test('candidate-space calculation is correct', () => {
  const config = {
    patterns: [
      {
        name: 'test-pattern',
        slots: ['word1', 'number', 'suffix'],
        word1: ['Alpha', 'Beta'],
        number: ['1', '2', '3'],
        suffix: ['!', '@']
      }
    ],
    capitalization: ['none', 'title'],
    mutations: {
      word1: ['none']
    }
  };

  const expected = (2 * 3 * 2) * 2;
  assert.equal(calculateCandidateSpace(config), expected);
});
