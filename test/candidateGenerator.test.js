const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  GENERATOR_VERSION,
  MAX_RAW_CANDIDATES,
  calculateCandidateSpace,
  candidateForUniqueIndex,
  compileCandidatePlan,
  generateCandidate,
  getDefaultPatternConfig,
  normalizeConfig,
  patternForIndex,
  validateConfig
} = require('../server/recovery/candidateGenerator');

function oneSlotConfig(values = ['A'], overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    patterns: [
      {
        name: 'word',
        slots: ['word'],
        word: values
      }
    ],
    capitalization: ['none'],
    mutations: {},
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('exports version and candidate-limit constants', () => {
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(GENERATOR_VERSION, 2);
  assert.equal(MAX_RAW_CANDIDATES, 10_000_000);
});

test('default configuration is versioned and returned as an independent copy', () => {
  const first = getDefaultPatternConfig();
  const second = getDefaultPatternConfig();

  assert.equal(first.schemaVersion, SCHEMA_VERSION);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.patterns, second.patterns);
  first.patterns[0].word1[0] = 'changed';
  assert.equal(second.patterns[0].word1[0], 'Demo');
});

test('validation returns a detached, normalized configuration', () => {
  const source = oneSlotConfig(['Alpha']);
  const validated = validateConfig(source);
  const normalized = normalizeConfig(source);

  assert.deepEqual(validated, source);
  assert.deepEqual(normalized, source);
  assert.notStrictEqual(validated, source);
  assert.notStrictEqual(validated.patterns, source.patterns);
  assert.notStrictEqual(normalized, source);
});

test('candidate ordering and pattern boundaries preserve generator version 1 semantics', () => {
  const config = getDefaultPatternConfig();
  const expected = new Map([
    [0, 'DemoPass123!'],
    [1, 'BriarPass123!'],
    [7, 'HarborPass123!'],
    [8, 'DemooPass123!'],
    [23, 'HrbrPass123!'],
    [24, 'DemoBloom123!'],
    [23039, 'HrbrSmmt88&&'],
    [23040, 'DemoPass123!'],
    [46080, 'DEMOPASS123!'],
    [69120, 'demopass123!'],
    [92159, 'hrbrsmmt88&&'],
    [92160, 'Briar09Bloom!'],
    [153899, 'hrbr66smmt&&'],
    [153900, 'Briar@Bloom03!'],
    [462599, 'hrbr&smmt99&&']
  ]);

  for (const [index, candidate] of expected) {
    assert.equal(generateCandidate(config, index), candidate, `raw index ${index}`);
    assert.equal(generateCandidate(config, index), generateCandidate(config, index));
  }

  assert.deepEqual(
    [0, 92159, 92160, 153899, 153900, 462599].map((index) => patternForIndex(config, index).pattern.name),
    [
      'word1+word2+number+suffix',
      'word1+word2+number+suffix',
      'word1+number+word2+suffix',
      'word1+number+word2+suffix',
      'word1+symbol+word2+number+suffix',
      'word1+symbol+word2+number+suffix'
    ]
  );
});

test('mixed-radix ordering keeps the first slot fastest and capitalization slowest', () => {
  const config = {
    schemaVersion: SCHEMA_VERSION,
    patterns: [
      {
        name: 'word+number',
        slots: ['word', 'number'],
        word: ['A', 'B'],
        number: ['1', '2']
      }
    ],
    capitalization: ['none', 'lower'],
    mutations: { word: ['none', 'double-last'] }
  };

  assert.equal(calculateCandidateSpace(config), 16);
  assert.deepEqual(
    Array.from({ length: 16 }, (_, index) => generateCandidate(config, index)),
    [
      'A1', 'B1', 'AA1', 'BB1',
      'A2', 'B2', 'AA2', 'BB2',
      'a1', 'b1', 'aa1', 'bb1',
      'a2', 'b2', 'aa2', 'bb2'
    ]
  );
});

test('slot values may be supplied at the top level', () => {
  const config = {
    schemaVersion: SCHEMA_VERSION,
    patterns: [{ name: 'shared', slots: ['word', 'suffix'], suffix: ['!'] }],
    word: ['Alpha', 'Beta'],
    capitalization: ['none'],
    mutations: {}
  };

  assert.equal(calculateCandidateSpace(config), 2);
  assert.deepEqual([generateCandidate(config, 0), generateCandidate(config, 1)], ['Alpha!', 'Beta!']);
});

test('manual validation rejects malformed or ambiguous configuration', async (t) => {
  const cases = [
    ['non-object config', null, /plain object/],
    ['missing schema version', (() => { const config = oneSlotConfig(); delete config.schemaVersion; return config; })(), /schemaVersion/],
    ['wrong schema version', oneSlotConfig(['A'], { schemaVersion: 1 }), /schemaVersion/],
    ['empty patterns', oneSlotConfig(['A'], { patterns: [] }), /patterns/],
    ['non-object pattern', oneSlotConfig(['A'], { patterns: [null] }), /plain object/],
    ['blank pattern name', oneSlotConfig(['A'], { patterns: [{ name: ' ', slots: ['word'], word: ['A'] }] }), /name/],
    ['empty slots', oneSlotConfig(['A'], { patterns: [{ name: 'empty', slots: [] }] }), /slots/],
    ['reserved slot name', oneSlotConfig(['A'], { patterns: [{ name: 'reserved', slots: ['constructor'], constructor: ['A'] }] }), /reserved/],
    ['missing slot values', oneSlotConfig(['A'], { patterns: [{ name: 'missing', slots: ['word'] }] }), /no values/],
    ['empty slot values', oneSlotConfig([]), /non-empty array/],
    ['non-string slot value', oneSlotConfig(['A', 1]), /must be a string/],
    ['empty capitalization', oneSlotConfig(['A'], { capitalization: [] }), /capitalization/],
    ['unsupported capitalization', oneSlotConfig(['A'], { capitalization: ['capitalize'] }), /unsupported/],
    ['non-object mutations', oneSlotConfig(['A'], { mutations: [] }), /plain object/],
    ['unsupported mutation', oneSlotConfig(['A'], { mutations: { word: ['reverse'] } }), /unsupported/],
    ['unused mutation slot', oneSlotConfig(['A'], { mutations: { other: ['none'] } }), /unused slot/],
    ['unknown config property', { ...oneSlotConfig(), note: 'ignored before v2' }, /unsupported property/],
    ['unknown pattern property', (() => { const config = oneSlotConfig(); config.patterns[0].typo = ['A']; return config; })(), /unsupported property/]
  ];

  for (const [name, config, errorPattern] of cases) {
    await t.test(name, () => {
      assert.throws(() => validateConfig(config), errorPattern);
      assert.throws(() => calculateCandidateSpace(config), errorPattern);
    });
  }
});

test('candidate-space arithmetic is safe and enforces the raw limit', () => {
  const tenValues = Array.from({ length: 10 }, (_, index) => String(index));
  const atLimit = oneSlotConfig(tenValues);
  atLimit.patterns[0].slots = Array(7).fill('word');
  assert.equal(calculateCandidateSpace(atLimit), MAX_RAW_CANDIDATES);

  const aboveLimit = clone(atLimit);
  aboveLimit.patterns[0].slots.push('word');
  assert.throws(
    () => calculateCandidateSpace(aboveLimit),
    /exceeds the maximum of 10000000/
  );

  const thousandValues = Array.from({ length: 1000 }, (_, index) => String(index));
  const unsafe = oneSlotConfig(thousandValues);
  unsafe.patterns[0].slots = Array(6).fill('word');
  assert.throws(() => calculateCandidateSpace(unsafe), /safe integer range/);
});

test('raw candidate and pattern lookups reject invalid boundaries', () => {
  const config = oneSlotConfig(['A', 'B']);
  for (const invalid of [-1, 2, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => generateCandidate(config, invalid), RangeError);
    assert.throws(() => patternForIndex(config, invalid), RangeError);
  }
  assert.throws(() => generateCandidate(config, '0'), TypeError);
  assert.throws(() => patternForIndex(config, null), TypeError);
});

test('compiled plans exact-dedupe candidates while preserving first occurrence', () => {
  const config = {
    schemaVersion: SCHEMA_VERSION,
    patterns: [
      { name: 'first', slots: ['word'], word: ['A', 'a'] },
      { name: 'second', slots: ['word'], word: ['A', 'B'] }
    ],
    capitalization: ['none', 'lower'],
    mutations: {}
  };

  const plan = compileCandidatePlan(config);
  assert.deepEqual(Object.keys(plan).sort(), [
    'duplicateCount',
    'generatorVersion',
    'rawCount',
    'rawIndices',
    'schemaVersion',
    'uniqueCount'
  ]);
  assert.equal(plan.schemaVersion, SCHEMA_VERSION);
  assert.equal(plan.generatorVersion, GENERATOR_VERSION);
  assert.equal(plan.rawCount, 8);
  assert.equal(plan.uniqueCount, 4);
  assert.equal(plan.duplicateCount, 4);
  assert.ok(plan.rawIndices instanceof Uint32Array);
  assert.deepEqual(Array.from(plan.rawIndices), [0, 1, 5, 7]);
  assert.deepEqual(
    Array.from({ length: plan.uniqueCount }, (_, index) => candidateForUniqueIndex(config, plan, index)),
    ['A', 'a', 'B', 'b']
  );
  assert.equal(Object.prototype.hasOwnProperty.call(plan, 'candidates'), false);
  assert.equal(Object.values(plan).some((value) => typeof value === 'string'), false);
});

test('compiled plans are deterministic', () => {
  const config = oneSlotConfig(['A', 'a', 'B'], { capitalization: ['none', 'lower'] });
  const first = compileCandidatePlan(config);
  const second = compileCandidatePlan(config);

  assert.deepEqual(
    { ...first, rawIndices: Array.from(first.rawIndices) },
    { ...second, rawIndices: Array.from(second.rawIndices) }
  );
});

test('compiled plans deduplicate NFKC-equivalent KDF inputs at their first raw index', () => {
  const config = oneSlotConfig([
    '\uff21',
    'A',
    'Cafe\u0301',
    'Caf\u00e9'
  ]);
  const plan = compileCandidatePlan(config);

  assert.equal(plan.rawCount, 4);
  assert.equal(plan.uniqueCount, 2);
  assert.equal(plan.duplicateCount, 2);
  assert.deepEqual(Array.from(plan.rawIndices), [0, 2]);
  assert.deepEqual(
    Array.from({ length: plan.uniqueCount }, (_, index) => (
      candidateForUniqueIndex(config, plan, index).normalize('NFKC')
    )),
    ['A', 'Caf\u00e9']
  );
});

test('unique candidate lookup validates its plan and index boundaries', () => {
  const config = oneSlotConfig(['A', 'B']);
  const plan = compileCandidatePlan(config);

  for (const invalid of [-1, plan.uniqueCount, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => candidateForUniqueIndex(config, plan, invalid), RangeError);
  }
  assert.throws(() => candidateForUniqueIndex(config, plan, '0'), TypeError);
  assert.throws(
    () => candidateForUniqueIndex(oneSlotConfig(['A', 'B', 'C']), plan, 0),
    /does not match/
  );
  assert.throws(
    () => candidateForUniqueIndex(config, { ...plan, rawIndices: Array.from(plan.rawIndices) }, 0),
    /Uint32Array/
  );
  assert.throws(
    () => candidateForUniqueIndex(config, { ...plan, generatorVersion: 1 }, 0),
    /generatorVersion/
  );
  assert.throws(
    () => candidateForUniqueIndex(config, { ...plan, duplicateCount: 1 }, 0),
    /inconsistent/
  );

  const badMap = { ...plan, rawIndices: Uint32Array.from([plan.rawCount, 1]) };
  assert.throws(() => candidateForUniqueIndex(config, badMap, 0), /outside/);
});

test('default candidate plan has the accepted raw and unique counts', () => {
  const config = getDefaultPatternConfig();
  const plan = compileCandidatePlan(config);

  assert.equal(calculateCandidateSpace(config), 462_600);
  assert.equal(plan.rawCount, 462_600);
  assert.equal(plan.uniqueCount, 352_320);
  assert.equal(plan.duplicateCount, 110_280);
  assert.equal(plan.rawIndices[0], 0);
  assert.equal(candidateForUniqueIndex(config, plan, 0), 'DemoPass123!');

  for (let index = 1; index < plan.rawIndices.length; index += 1) {
    assert.ok(plan.rawIndices[index] > plan.rawIndices[index - 1]);
  }
});
