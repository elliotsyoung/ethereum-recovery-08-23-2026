const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildQuestionnaireConfig, buildGuidedConfig, getQuestionnaireDefaults,
  summarizeGuidedConfig, ASCII_SYMBOLS
} = require('../server/recovery/guidedConfig');
const {
  validateConfig, compileCandidatePlan, createCandidateResolver,
  candidateForUniqueIndex, calculateCandidateSpace, patternForIndex
} = require('../server/recovery/candidateGenerator');

function config(masks, overrides = {}) {
  return buildQuestionnaireConfig({ searchMode: 'mask', masks, minLength: 11, maxLength: 64, ...overrides });
}

function candidates(source) {
  const resolve = createCandidateResolver(source);
  return Array.from({ length: calculateCandidateSpace(source) }, (_, index) => resolve(index));
}

test('unknown answers retain all printable ASCII characters without spelling, rhyme, or layout assumptions', () => {
  const defaults = getQuestionnaireDefaults();
  assert.equal(defaults.searchMode, 'mask');
  assert.deepEqual(defaults.masks, []);
  assert.equal(defaults.minLength, 11);
  assert.equal(defaults.maxLength, 64);
  assert.deepEqual(buildQuestionnaireConfig(defaults).guided, defaults);
  const summary = summarizeGuidedConfig(config([]));
  let expected = 0n;
  for (let length = 11n; length <= 64n; length += 1n) expected += 95n ** length;
  assert.equal(summary.candidateCountExact, String(expected));
  assert.equal(summary.uniqueCandidateCount, null);
  assert.equal(summary.runnable, false);
  assert.equal(summary.perLength.length, 54);
  assert.equal(summary.perLength[0].candidateCountExact, String(95n ** 11n));
  assert.throws(() => compileCandidatePlan(config([])), /executable job/);
  const reduced = summarizeGuidedConfig(config([], { maxLength: 11 }));
  assert.equal(reduced.candidateCountExact, String(95n ** 11n));
});

test('mask alternatives have an exact union, including overlap, duplicates and broad alternatives', () => {
  const source = config(['abCDefghij?l', 'abCDefghij?a', 'abCDefghij?u', 'abCDefghij?d', 'abCDefghija']);
  const actual = candidates(source);
  const expected = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'].map((char) => `abCDefghij${char}`);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
  assert.equal(summarizeGuidedConfig(source).candidateCountExact, '62');
  const plan = compileCandidatePlan(source);
  assert.equal(plan.kind, 'guided');
  assert.equal(plan.uniqueCount, 62);
  assert.equal(candidateForUniqueIndex(source, plan, 61), expected[61]);
  assert.equal(patternForIndex(source, 0).pattern.name, 'mask');
});

test('arbitrary letter strings, mixed capitalization, unshifted punctuation and spaces are all literal', () => {
  const values = ["fRgmntz-_.';", ' aB zXy123! ', 'abcde??GHIJK', 'ab[CD]efGHi'];
  const actual = candidates(config(values));
  assert.deepEqual(new Set(actual), new Set(["fRgmntz-_.';", ' aB zXy123! ', 'abcde?GHIJK', 'ab[CD]efGHi']));
  const specials = candidates(config(['abcdefghij?s']));
  assert.equal(specials.length, 33);
  for (const character of ASCII_SYMBOLS) assert.ok(specials.includes(`abcdefghij${character}`));
  const wildcard = candidates(config(['abcdefghij?x']));
  assert.equal(wildcard.length, 95);
  assert.ok(wildcard.includes('abcdefghij '));
});

test('variable token lengths count and enumerate every arrangement, deduplicating ambiguous splits', () => {
  const source = config(['abcdefghij?d{1,2}', 'abcdefghij?d{0,1}?d{1,2}'], { maxLength: 12 });
  const actual = candidates(source);
  const expected = [];
  for (let value = 0; value < 10; value += 1) expected.push(`abcdefghij${value}`);
  for (let value = 0; value < 100; value += 1) expected.push(`abcdefghij${String(value).padStart(2, '0')}`);
  assert.deepEqual(actual, expected);
  assert.deepEqual(summarizeGuidedConfig(source).perLength, [
    { length: 11, candidateCountExact: '10' }, { length: 12, candidateCountExact: '100' }
  ]);
});

test('independent oracle verifies overlapping rectangular mask products', () => {
  const prefix = 'abcdefghij';
  const source = config([`${prefix}?a?d`, `${prefix}?u?x`, `${prefix}A?l`, `${prefix}?d?s`]);
  const expected = new Set();
  const all = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32));
  for (const first of all) for (const second of all) {
    if ((/[A-Za-z]/.test(first) && /[0-9]/.test(second))
        || /[A-Z]/.test(first)
        || (first === 'A' && /[a-z]/.test(second))
        || (/[0-9]/.test(first) && !/[A-Za-z0-9]/.test(second))) expected.add(prefix + first + second);
  }
  const actual = candidates(source);
  assert.equal(actual.length, expected.size);
  assert.deepEqual(new Set(actual), expected);
});

test('indexed mask candidates remain exact near the safe integer bound', () => {
  const source = config(['prefix?d{15}']);
  const plan = compileCandidatePlan(source);
  assert.equal(plan.uniqueCount, 1_000_000_000_000_000);
  for (const index of [0, 1, 99, 901_393_433_927_281, plan.uniqueCount - 1]) {
    assert.equal(candidateForUniqueIndex(source, plan, index), `prefix${String(index).padStart(15, '0')}`);
  }
  assert.throws(() => candidateForUniqueIndex(source, plan, plan.uniqueCount), RangeError);
});

test('v3 rejects malformed or uncertain constraints instead of silently narrowing', () => {
  assert.throws(() => config(['abcdefghij?']), /Unknown mask token/);
  assert.throws(() => config(['abcdefghij?z']), /Unknown mask token/);
  assert.throws(() => config(['abcdefghij?d{2,1}']), /repetitions/);
  assert.throws(() => config(['abcdefghij?d{65}']), /repetitions/);
  assert.throws(() => config(['abcdefghij?d{x}']), /repetition must/);
  assert.throws(() => config(['abcdefghijé']), /non-ASCII/);
  assert.throws(() => config(['abcdefghij\t']), /non-ASCII/);
  assert.throws(() => config([], { minLength: 10 }), /11 to 64/);
  assert.throws(() => config([], { maxLength: 10 }), /11 to 64/);
  assert.throws(() => config([], { mask: 'abcdefghijk' }), /not both/);
  assert.throws(() => config([], { rhyme: true }), /Unsupported/);
  assert.throws(() => compileCandidatePlan(config(['short'])), /No passwords/);
  assert.throws(() => config(Array(65).fill('abcdefghijk')), /up to 64/);
  assert.throws(() => summarizeGuidedConfig(config(['?x{0,1}'.repeat(30)])), /too many structural/);
});

test('v3 fragments accept misspellings and all special characters but cannot require rhyme', () => {
  const source = buildQuestionnaireConfig({
    searchMode: 'fragments', word1: ['qzxwrr'], word2: ['tbyrp'],
    minLength: 11, maxLength: 12, minDigits: 0, maxDigits: 0,
    minSymbols: 0, maxSymbols: 1, symbols: '- ', caseStyles: ['none'], layouts: ['suffix']
  });
  assert.deepEqual(validateConfig(source), source);
  assert.deepEqual(candidates(source), ['qzxwrrtbyrp', 'qzxwrrtbyrp-', 'qzxwrrtbyrp ']);
  assert.throws(() => buildQuestionnaireConfig({ ...source.guided, sharedEnding: 2 }), /not reliable/);
  assert.throws(() => buildQuestionnaireConfig({ ...source.guided, minLength: 2 }), /whole number/);
  assert.ok(!Object.hasOwn(source.guided, 'sharedEnding'));
});

test('oversized fragment previews count exactly while legacy executable indexing is unchanged', () => {
  const source = buildGuidedConfig({ word1: ['Alpha'], word2: ['Beta'], maxLength: 64,
    minDigits: 12, maxDigits: 12, minSymbols: 12, maxSymbols: 12, symbols: '!?' });
  const summary = summarizeGuidedConfig(source);
  assert.equal(summary.candidateCountExact, String(10n ** 12n * 2n ** 12n));
  assert.equal(summary.runnable, true);
  const large = buildGuidedConfig({ ...source.guided, symbols: '!?#' });
  assert.equal(summarizeGuidedConfig(large).candidateCountExact, String(10n ** 12n * 3n ** 12n));
  assert.equal(summarizeGuidedConfig(large).runnable, false);
  assert.throws(() => compileCandidatePlan(large), /exact counting limit/);
});
