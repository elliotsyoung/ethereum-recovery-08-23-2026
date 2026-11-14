const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGuidedConfig, getGuidedDefaults, SHIFT_SYMBOLS, summarizeGuidedConfig
} = require('../server/recovery/guidedConfig');
const {
  compileCandidatePlan, createCandidateResolver, candidateForUniqueIndex,
  calculateCandidateSpace, validateConfig, patternForIndex
} = require('../server/recovery/candidateGenerator');

function config(overrides = {}) {
  return buildGuidedConfig({
    word1: ['a'], word2: ['b'], minLength: 2, maxLength: 20,
    minDigits: 0, maxDigits: 2, minSymbols: 0, maxSymbols: 2,
    symbols: '!?', caseStyles: ['none'],
    layouts: ['suffix', 'between', 'split'],
    ...overrides
  });
}

function candidates(source) {
  const resolver = createCandidateResolver(source);
  return Array.from({ length: calculateCandidateSpace(source) }, (_, index) => resolver(index));
}

test('guided input uses ASCII words, shifted US keyboard symbols, and separate digit/symbol rules', () => {
  const defaults = getGuidedDefaults();
  assert.equal(defaults.minSymbols, 2);
  assert.equal(defaults.maxSymbols, 4);
  assert.equal(new Set(SHIFT_SYMBOLS).size, 21);
  assert.match(SHIFT_SYMBOLS, /[?~]/);
  const source = buildGuidedConfig({ word1: 'Alpha, Beta\nAlpha' });
  assert.deepEqual(source.guided.word1, ['Alpha', 'Beta']);
  assert.deepEqual(source.guided.word2, ['Alpha', 'Beta']);
  assert.deepEqual(validateConfig(source), source);
  assert.notEqual(validateConfig(source).guided, source.guided);
  assert.throws(() => config({ word1: ['Café'] }), /English keyboard/);
  assert.throws(() => config({ word1: ['hello!'] }), /English keyboard/);
  assert.throws(() => config({ symbols: '-' }), /shifted US/);
  assert.throws(() => config({ symbols: 'é' }), /shifted US/);
  assert.throws(() => config({ symbols: '' }), /at least one symbol/);
  assert.throws(() => config({ word1: [] }), /at least one word/);
  assert.throws(() => config({ maxLength: 1 }), /whole number/);
  assert.throws(() => config({ minLength: 10, maxLength: 9 }), /cannot exceed/);
  assert.throws(() => config({ minDigits: 1.5 }), /whole number/);
  assert.throws(() => config({ caseStyles: ['mixed'] }), /supported choice/);
  assert.throws(() => config({ layouts: [] }), /supported choice/);
  assert.throws(() => config({ digitMode: 'unknown' }), /repeated or all/);
  assert.throws(() => config({ unexpected: 'setting' }), /Unsupported/);
});

test('all three layouts cover an independently enumerated small search with exact counts', () => {
  const source = config();
  const expected = new Set();
  const symbols = ['', '!', '?', '!!', '??'];
  const digits = ['', ...'0123456789', ...[...'0123456789'].map((digit) => digit.repeat(2))];
  for (const ending of symbols) {
    for (const number of digits) {
      expected.add(`ab${number}${ending}`);
      if (number) expected.add(`a${number}b${ending}`);
    }
    for (const first of '0123456789') {
      for (const second of '0123456789') expected.add(`a${first}b${second}${ending}`);
    }
  }
  const actual = candidates(source);
  assert.equal(actual.length, expected.size);
  assert.deepEqual(new Set(actual), expected);
  const plan = compileCandidatePlan(source);
  assert.equal(plan.rawIndices, null);
  assert.equal(plan.kind, 'guided');
  assert.equal(plan.rawCount, expected.size);
  assert.equal(plan.uniqueCount, expected.size);
  assert.equal(plan.duplicateCount, 0);
  assert.equal(candidateForUniqueIndex(source, plan, 0), actual[0]);
  assert.equal(candidateForUniqueIndex(source, plan, actual.length - 1), actual.at(-1));
});

test('word boundary ambiguity, repeated input, and overlapping case styles never repeat a password', () => {
  const source = config({
    word1: ['a', 'A', 'ab', 'a'], word2: ['bc', 'c', 'BC'],
    caseStyles: ['none', 'title', 'lower', 'upper'],
    layouts: ['suffix', 'between', 'split', 'suffix'],
    symbols: '!!??', minLength: 5, maxLength: 7
  });
  const actual = candidates(source);
  assert.equal(new Set(actual).size, actual.length);
  assert.ok(actual.includes('abc!!'));
  for (const candidate of actual) {
    assert.ok(candidate.length >= 5 && candidate.length <= 7);
    assert.ok((candidate.match(/[0-9]/g) || []).length <= 2);
    assert.ok((candidate.match(/[!?]/g) || []).length <= 2);
  }
});

test('minimum symbol count is independent of the digit count and supports split digits', () => {
  const source = config({
    word1: ['Tomato'], word2: ['Potato'], caseStyles: ['none'],
    minDigits: 2, maxDigits: 2, minSymbols: 2, maxSymbols: 2,
    layouts: ['split'], symbols: '?'
  });
  const actual = candidates(source);
  assert.equal(actual.length, 100);
  assert.ok(actual.includes('Tomato7Potato5??'));
  assert.equal(patternForIndex(source, 0).pattern.name, 'split');
  const fourSymbols = candidates(config({
    word1: ['A'], word2: ['B'], minDigits: 2, maxDigits: 2,
    minSymbols: 4, maxSymbols: 4, symbols: '&', layouts: ['suffix']
  }));
  assert.ok(fourSymbols.includes('AB77&&&&'));
  assert.ok(!fourSymbols.includes('AB77&&'));
});

test('arbitrary digit/symbol modes cover nonrepeated combinations and leading zeroes', () => {
  const source = config({
    layouts: ['suffix'], minDigits: 2, maxDigits: 2,
    minSymbols: 2, maxSymbols: 2, digitMode: 'all', symbolMode: 'all'
  });
  const actual = candidates(source);
  assert.equal(actual.length, 100 * 4);
  assert.ok(actual.includes('ab05!?'));
  assert.ok(actual.includes('ab79?!'));
  assert.ok(actual.includes('ab00!!'));
});

test('billions of candidates have a compact plan and random access without enumeration', () => {
  const source = config({
    word1: ['Alpha'], word2: ['Beta'], caseStyles: ['none'], layouts: ['suffix'],
    minDigits: 8, maxDigits: 8, minSymbols: 2, maxSymbols: 2,
    symbols: SHIFT_SYMBOLS, digitMode: 'all', symbolMode: 'all'
  });
  const plan = compileCandidatePlan(source);
  assert.equal(plan.uniqueCount, 44_100_000_000);
  assert.equal(plan.rawIndices, null);
  assert.ok(JSON.stringify(plan).length < 250);
  assert.equal(candidateForUniqueIndex(source, plan, 0), 'AlphaBeta00000000!!');
  assert.equal(candidateForUniqueIndex(source, plan, plan.uniqueCount - 1), 'AlphaBeta99999999~~');
  assert.equal(summarizeGuidedConfig(source).uniqueCandidateCount, plan.uniqueCount);
  assert.throws(() => candidateForUniqueIndex(source, plan, plan.uniqueCount), RangeError);
  assert.throws(() => candidateForUniqueIndex(source, { ...plan, kind: 'legacy' }, 0), /direct indexing/);
  assert.throws(() => candidateForUniqueIndex(source, { ...plan, duplicateCount: 1 }, 0), /inconsistent/);
});

test('empty and unsafe-sized searches fail before recovery starts', () => {
  const empty = config({ minLength: 19, maxLength: 20 });
  assert.throws(() => compileCandidatePlan(empty), /No passwords/);
  const tooLarge = config({
    maxLength: 64, minDigits: 12, maxDigits: 12,
    minSymbols: 12, maxSymbols: 12, digitMode: 'all', symbolMode: 'all',
    symbols: SHIFT_SYMBOLS
  });
  assert.throws(() => compileCandidatePlan(tooLarge), /exact counting limit/);
  assert.throws(() => config({ word1: Array.from({ length: 201 }, (_, index) => `w${String.fromCharCode(65 + Math.floor(index / 26), 65 + index % 26)}`) }), /200 distinct words/);
});

test('mixed-radix random access remains exact near the safe integer ceiling', () => {
  const source = config({
    layouts: ['suffix'], minDigits: 8, maxDigits: 8,
    minSymbols: 6, maxSymbols: 6, digitMode: 'all', symbolMode: 'all',
    symbols: SHIFT_SYMBOLS
  });
  const plan = compileCandidatePlan(source);
  assert.equal(plan.uniqueCount, 8_576_612_100_000_000);
  const total = BigInt(plan.uniqueCount);
  const oracle = (index) => {
    const digits = String(index % 100_000_000n).padStart(8, '0');
    let quotient = index / 100_000_000n;
    let symbols = '';
    for (let position = 0; position < 6; position += 1) {
      symbols = SHIFT_SYMBOLS[Number(quotient % 21n)] + symbols;
      quotient /= 21n;
    }
    return `ab${digits}${symbols}`;
  };
  let seed = 8723408591234n;
  const indices = [0n, total - 1n, total - 2n, total / 2n, 100_000_000n - 1n, 100_000_000n];
  for (let iteration = 0; iteration < 500; iteration += 1) {
    seed = (seed * 48271n + 1n) % total;
    indices.push(seed);
  }
  for (const index of indices) {
    assert.equal(candidateForUniqueIndex(source, plan, Number(index)), oracle(index), String(index));
  }
});

test('normalization and resolver compilation detach their source values', () => {
  const input = { word1: ['Alpha'], word2: ['Beta'] };
  const source = buildGuidedConfig(input);
  input.word1.push('Changed');
  assert.deepEqual(source.guided.word1, ['Alpha']);
  const resolve = createCandidateResolver(source);
  const first = resolve(0);
  source.guided.word1[0] = 'Changed';
  source.guided.caseStyles.push('upper');
  assert.equal(resolve(0), first);
  assert.match(first, /^AlphaBeta/);
});
