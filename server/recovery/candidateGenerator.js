const SCHEMA_VERSION = 2;
const GENERATOR_VERSION = 2;
const MAX_RAW_CANDIDATES = 10_000_000;

const CAPITALIZATION_MODES = new Set(['none', 'title', 'upper', 'lower']);
const MUTATION_MODES = new Set(['none', 'double-last', 'drop-vowel']);
const CONFIG_KEYS = new Set(['schemaVersion', 'patterns', 'capitalization', 'mutations']);
const PATTERN_KEYS = new Set(['name', 'slots']);
const RESERVED_SLOT_NAMES = new Set([
  'name',
  'slots',
  'schemaVersion',
  'patterns',
  'capitalization',
  'mutations',
  '__proto__',
  'constructor',
  'prototype'
]);

const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  patterns: [
    {
      name: 'word1+word2+number+suffix',
      slots: ['word1', 'word2', 'number', 'suffix'],
      word1: ['Demo', 'Briar', 'Cinder', 'Drift', 'Ember', 'Fable', 'Grove', 'Harbor'],
      word2: ['Pass', 'Bloom', 'Fjord', 'Harbor', 'Lumen', 'North', 'Quill', 'Summit'],
      number: ['123', '01', '07', '12', '22', '44', '77', '88'],
      suffix: ['!', '!!', '**', '$$', '&&']
    },
    {
      name: 'word1+number+word2+suffix',
      slots: ['word1', 'number', 'word2', 'suffix'],
      word1: ['Briar', 'Cinder', 'Drift', 'Ember', 'Fable', 'Grove', 'Harbor'],
      number: ['09', '14', '21', '32', '47', '55', '66'],
      word2: ['Bloom', 'Fjord', 'Harbor', 'Lumen', 'North', 'Quill', 'Summit'],
      suffix: ['!', '!!', '**', '$$', '&&']
    },
    {
      name: 'word1+symbol+word2+number+suffix',
      slots: ['word1', 'symbol', 'word2', 'number', 'suffix'],
      word1: ['Briar', 'Cinder', 'Drift', 'Ember', 'Fable', 'Grove', 'Harbor'],
      symbol: ['@', '#', '$', '%', '&'],
      word2: ['Bloom', 'Fjord', 'Harbor', 'Lumen', 'North', 'Quill', 'Summit'],
      number: ['03', '09', '18', '29', '45', '72', '99'],
      suffix: ['!', '!!', '**', '$$', '&&']
    }
  ],
  capitalization: ['none', 'title', 'upper', 'lower'],
  mutations: {
    word1: ['none', 'double-last', 'drop-vowel'],
    word2: ['none', 'double-last', 'drop-vowel']
  }
};

const planModelCache = new WeakMap();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function assertRecord(value, location) {
  if (!isRecord(value)) {
    throw new TypeError(`${location} must be a plain object.`);
  }
}

function assertNonEmptyString(value, location) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${location} must be a non-empty string.`);
  }
}

function assertStringArray(value, location, allowedValues = null) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${location} must be a non-empty array of strings.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string') {
      throw new TypeError(`${location}[${index}] must be a string.`);
    }
    if (allowedValues && !allowedValues.has(value[index])) {
      throw new TypeError(`${location}[${index}] has unsupported value "${value[index]}".`);
    }
  }
}

function validateConfig(config) {
  assertRecord(config, 'config');

  if (config.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`config.schemaVersion must be ${SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(config.patterns) || config.patterns.length === 0) {
    throw new TypeError('config.patterns must be a non-empty array.');
  }
  assertStringArray(config.capitalization, 'config.capitalization', CAPITALIZATION_MODES);
  assertRecord(config.mutations, 'config.mutations');

  const usedSlots = new Set();

  for (let patternIndex = 0; patternIndex < config.patterns.length; patternIndex += 1) {
    const pattern = config.patterns[patternIndex];
    const location = `config.patterns[${patternIndex}]`;
    assertRecord(pattern, location);
    assertNonEmptyString(pattern.name, `${location}.name`);
    assertStringArray(pattern.slots, `${location}.slots`);

    for (let slotIndex = 0; slotIndex < pattern.slots.length; slotIndex += 1) {
      const slotName = pattern.slots[slotIndex];
      assertNonEmptyString(slotName, `${location}.slots[${slotIndex}]`);
      if (RESERVED_SLOT_NAMES.has(slotName)) {
        throw new TypeError(`${location}.slots[${slotIndex}] uses reserved slot name "${slotName}".`);
      }
      usedSlots.add(slotName);
    }
  }

  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key) && !usedSlots.has(key)) {
      throw new TypeError(`config contains unsupported property "${key}".`);
    }
  }

  for (const slotName of usedSlots) {
    if (hasOwn(config, slotName)) {
      assertStringArray(config[slotName], `config.${slotName}`);
    }
  }

  for (let patternIndex = 0; patternIndex < config.patterns.length; patternIndex += 1) {
    const pattern = config.patterns[patternIndex];
    const location = `config.patterns[${patternIndex}]`;
    const patternSlots = new Set(pattern.slots);

    for (const key of Object.keys(pattern)) {
      if (!PATTERN_KEYS.has(key) && !patternSlots.has(key)) {
        throw new TypeError(`${location} contains unsupported property "${key}".`);
      }
    }

    for (const slotName of patternSlots) {
      if (hasOwn(pattern, slotName)) {
        assertStringArray(pattern[slotName], `${location}.${slotName}`);
      } else if (!hasOwn(config, slotName)) {
        throw new TypeError(`${location} has no values for slot "${slotName}".`);
      }
    }
  }

  for (const [slotName, mutationNames] of Object.entries(config.mutations)) {
    if (!usedSlots.has(slotName)) {
      throw new TypeError(`config.mutations contains unused slot "${slotName}".`);
    }
    assertStringArray(mutationNames, `config.mutations.${slotName}`, MUTATION_MODES);
  }

  return clone(config);
}

function normalizeConfig(config) {
  return validateConfig(config);
}

function checkedMultiply(left, right, location) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    throw new RangeError(`${location} requires non-negative safe integers.`);
  }
  if (right !== 0 && left > Math.floor(Number.MAX_SAFE_INTEGER / right)) {
    throw new RangeError(`${location} exceeds the safe integer range.`);
  }
  return left * right;
}

function checkedAdd(left, right, location) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    throw new RangeError(`${location} requires non-negative safe integers.`);
  }
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new RangeError(`${location} exceeds the safe integer range.`);
  }
  return left + right;
}

function resolvePatternList(pattern, slotName, config) {
  return hasOwn(pattern, slotName) ? pattern[slotName] : config[slotName];
}

function mutationFor(slotName, config) {
  return hasOwn(config.mutations, slotName) ? config.mutations[slotName] : ['none'];
}

function applyMutation(value, mutationName) {
  if (!value || mutationName === 'none') {
    return value;
  }
  if (mutationName === 'double-last') {
    return `${value}${value.slice(-1)}`;
  }
  if (mutationName === 'drop-vowel') {
    return value.replace(/[aeiou]/gi, '');
  }
  throw new TypeError(`Unsupported mutation "${mutationName}".`);
}

function applyCapitalization(value, mode) {
  if (!value || mode === 'none') {
    return value;
  }
  switch (mode) {
    case 'title':
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    case 'upper':
      return value.toUpperCase();
    case 'lower':
      return value.toLowerCase();
    default:
      throw new TypeError(`Unsupported capitalization mode "${mode}".`);
  }
}

function buildCandidateModel(config) {
  const normalized = normalizeConfig(config);
  let rawCount = 0;
  const patterns = normalized.patterns.map((pattern, patternIndex) => {
    let slotSpace = 1;
    const slots = pattern.slots.map((slotName) => {
      const values = resolvePatternList(pattern, slotName, normalized);
      const mutations = mutationFor(slotName, normalized);
      const choiceCount = checkedMultiply(
        values.length,
        mutations.length,
        `Candidate choices for pattern ${patternIndex}, slot "${slotName}"`
      );
      slotSpace = checkedMultiply(
        slotSpace,
        choiceCount,
        `Candidate space for pattern ${patternIndex}`
      );
      return { slotName, values, mutations, choiceCount };
    });
    const size = checkedMultiply(
      slotSpace,
      normalized.capitalization.length,
      `Candidate space for pattern ${patternIndex}`
    );
    const offset = rawCount;
    rawCount = checkedAdd(rawCount, size, 'Total candidate space');
    return { pattern, slots, slotSpace, offset, size };
  });

  if (rawCount > MAX_RAW_CANDIDATES) {
    throw new RangeError(
      `Raw candidate space ${rawCount} exceeds the maximum of ${MAX_RAW_CANDIDATES}. Split it into smaller jobs.`
    );
  }

  return { config: normalized, patterns, rawCount };
}

function assertIndex(index, total, name) {
  if (typeof index !== 'number') {
    throw new TypeError(`${name} must be a number.`);
  }
  if (!Number.isSafeInteger(index)) {
    throw new RangeError(`${name} must be a safe integer.`);
  }
  if (index < 0 || index >= total) {
    throw new RangeError(`${name} must be between 0 and ${total - 1}.`);
  }
}

function patternEntryForRawIndex(model, candidateIndex) {
  assertIndex(candidateIndex, model.rawCount, 'candidateIndex');
  for (const entry of model.patterns) {
    if (candidateIndex >= entry.offset && candidateIndex < entry.offset + entry.size) {
      return entry;
    }
  }
  throw new RangeError('candidateIndex is outside the candidate space.');
}

function generateCandidateFromModel(model, candidateIndex) {
  const entry = patternEntryForRawIndex(model, candidateIndex);
  const localIndex = candidateIndex - entry.offset;
  const capitalizationIndex = Math.floor(localIndex / entry.slotSpace);
  const capitalization = model.config.capitalization[capitalizationIndex];
  let slotIndex = localIndex % entry.slotSpace;
  let candidate = '';

  for (const slot of entry.slots) {
    const choiceIndex = slotIndex % slot.choiceCount;
    slotIndex = Math.floor(slotIndex / slot.choiceCount);
    const mutationIndex = Math.floor(choiceIndex / slot.values.length);
    const valueIndex = choiceIndex % slot.values.length;
    candidate += applyCapitalization(
      applyMutation(slot.values[valueIndex], slot.mutations[mutationIndex]),
      capitalization
    );
  }

  return candidate;
}

function calculateCandidateSpace(config) {
  return buildCandidateModel(config).rawCount;
}

function patternForIndex(config, candidateIndex) {
  const entry = patternEntryForRawIndex(buildCandidateModel(config), candidateIndex);
  return { pattern: entry.pattern, offset: entry.offset, total: entry.size };
}

function generateCandidate(config, candidateIndex) {
  return generateCandidateFromModel(buildCandidateModel(config), candidateIndex);
}

function createCandidateResolver(config) {
  const model = buildCandidateModel(config);
  return (candidateIndex) => generateCandidateFromModel(model, candidateIndex);
}

function compileCandidatePlan(config) {
  const model = buildCandidateModel(config);
  const firstRawIndices = new Uint32Array(model.rawCount);
  const seen = new Set();
  let uniqueCount = 0;

  for (let rawIndex = 0; rawIndex < model.rawCount; rawIndex += 1) {
    const candidate = generateCandidateFromModel(model, rawIndex);
    const normalizedCandidate = candidate.normalize('NFKC');
    if (!seen.has(normalizedCandidate)) {
      seen.add(normalizedCandidate);
      firstRawIndices[uniqueCount] = rawIndex;
      uniqueCount += 1;
    }
  }

  const plan = {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    rawCount: model.rawCount,
    uniqueCount,
    duplicateCount: model.rawCount - uniqueCount,
    rawIndices: firstRawIndices.slice(0, uniqueCount)
  };
  planModelCache.set(plan, { sourceConfig: config, model });
  return plan;
}

function assertCandidatePlan(plan, expectedRawCount) {
  assertRecord(plan, 'plan');
  if (plan.schemaVersion !== SCHEMA_VERSION) {
    throw new RangeError(`plan.schemaVersion must be ${SCHEMA_VERSION}.`);
  }
  if (plan.generatorVersion !== GENERATOR_VERSION) {
    throw new RangeError(`plan.generatorVersion must be ${GENERATOR_VERSION}.`);
  }
  if (!(plan.rawIndices instanceof Uint32Array)) {
    throw new TypeError('plan.rawIndices must be a Uint32Array.');
  }
  for (const [name, value] of [
    ['plan.rawCount', plan.rawCount],
    ['plan.uniqueCount', plan.uniqueCount],
    ['plan.duplicateCount', plan.duplicateCount]
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
  }
  if (plan.rawCount !== expectedRawCount) {
    throw new RangeError('plan.rawCount does not match the supplied configuration.');
  }
  if (plan.uniqueCount !== plan.rawIndices.length) {
    throw new RangeError('plan.uniqueCount does not match plan.rawIndices.length.');
  }
  if (plan.duplicateCount !== plan.rawCount - plan.uniqueCount) {
    throw new RangeError('plan.duplicateCount is inconsistent with the plan counts.');
  }
}

function candidateForUniqueIndex(config, plan, uniqueIndex) {
  let cached = plan && typeof plan === 'object' ? planModelCache.get(plan) : null;
  if (!cached || cached.sourceConfig !== config) {
    const model = buildCandidateModel(config);
    assertCandidatePlan(plan, model.rawCount);
    cached = { sourceConfig: config, model };
    planModelCache.set(plan, cached);
  } else {
    assertCandidatePlan(plan, cached.model.rawCount);
  }

  assertIndex(uniqueIndex, plan.uniqueCount, 'uniqueIndex');
  const rawIndex = plan.rawIndices[uniqueIndex];
  if (rawIndex >= plan.rawCount) {
    throw new RangeError('plan.rawIndices contains an index outside the raw candidate space.');
  }
  return generateCandidateFromModel(cached.model, rawIndex);
}

function getDefaultPatternConfig() {
  return clone(DEFAULT_CONFIG);
}

module.exports = {
  SCHEMA_VERSION,
  GENERATOR_VERSION,
  MAX_RAW_CANDIDATES,
  DEFAULT_CONFIG,
  calculateCandidateSpace,
  candidateForUniqueIndex,
  compileCandidatePlan,
  createCandidateResolver,
  generateCandidate,
  getDefaultPatternConfig,
  normalizeConfig,
  patternForIndex,
  validateConfig
};
