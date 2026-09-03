const DEFAULT_CONFIG = {
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeConfig(config) {
  const safeConfig = config && typeof config === 'object' ? config : {};
  const patterns = Array.isArray(safeConfig.patterns) && safeConfig.patterns.length > 0
    ? safeConfig.patterns
    : DEFAULT_CONFIG.patterns;

  return {
    ...DEFAULT_CONFIG,
    ...safeConfig,
    patterns: patterns.map((pattern) => ({
      ...pattern,
      slots: Array.isArray(pattern.slots) && pattern.slots.length > 0 ? pattern.slots : ['word1', 'word2', 'number', 'suffix']
    }))
  };
}

function product(values) {
  return values.reduce((total, next) => total * next, 1);
}

function resolvePatternList(pattern, slotName, config) {
  if (Array.isArray(pattern[slotName])) {
    return pattern[slotName];
  }
  if (Array.isArray(config[slotName])) {
    return config[slotName];
  }
  return [];
}

function mutationFor(slotName, config) {
  const options = config.mutations && config.mutations[slotName];
  return Array.isArray(options) && options.length > 0 ? options : ['none'];
}

function applyMutation(value, mutationName) {
  if (!value || mutationName === 'none' || mutationName === undefined) {
    return value;
  }
  if (mutationName === 'double-last') {
    return `${value}${value.slice(-1)}`;
  }
  if (mutationName === 'drop-vowel') {
    return value.replace(/[aeiou]/gi, '');
  }
  return value;
}

function applyCapitalization(value, mode) {
  if (!value) {
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
      return value;
  }
}

function getPatternSpace(pattern, config) {
  const space = pattern.slots.reduce((total, slotName) => {
    const values = resolvePatternList(pattern, slotName, config);
    const mutations = mutationFor(slotName, config);
    return total * Math.max(values.length, 1) * Math.max(mutations.length, 1);
  }, 1);
  const variations = Array.isArray(config.capitalization) ? config.capitalization.length : 1;
  return space * Math.max(variations, 1);
}

function calculateCandidateSpace(config) {
  const normalized = normalizeConfig(config);
  return normalized.patterns.reduce((total, pattern) => total + getPatternSpace(pattern, normalized), 0);
}

function patternForIndex(config, candidateIndex) {
  const normalized = normalizeConfig(config);
  let offset = 0;
  for (const pattern of normalized.patterns) {
    const size = getPatternSpace(pattern, normalized);
    if (candidateIndex >= offset && candidateIndex < offset + size) {
      return { pattern, offset, total: size };
    }
    offset += size;
  }
  const lastPattern = normalized.patterns[normalized.patterns.length - 1];
  return { pattern: lastPattern, offset: Math.max(offset - getPatternSpace(lastPattern, normalized), 0), total: getPatternSpace(lastPattern, normalized) };
}

function generateCandidate(config, candidateIndex) {
  const normalized = normalizeConfig(config);
  const { pattern, offset } = patternForIndex(normalized, candidateIndex);
  const localIndex = candidateIndex - offset;
  const capitalizationCount = Math.max(Array.isArray(normalized.capitalization) ? normalized.capitalization.length : 0, 1);
  const capitalizationIndex = Math.floor(localIndex / (pattern.slots.reduce((total, slotName) => {
    const values = resolvePatternList(pattern, slotName, normalized);
    return total * Math.max(values.length, 1) * Math.max(mutationFor(slotName, normalized).length, 1);
  }, 1))) % capitalizationCount;
  const capitalization = normalized.capitalization?.[capitalizationIndex] || 'none';
  let slotIndex = localIndex % Math.max(pattern.slots.reduce((total, slotName) => {
    const values = resolvePatternList(pattern, slotName, normalized);
    return total * Math.max(values.length, 1) * Math.max(mutationFor(slotName, normalized).length, 1);
  }, 1), 1);
  const slotValues = pattern.slots.map((slotName) => {
    const baseValues = resolvePatternList(pattern, slotName, normalized);
    const options = baseValues.length > 0 ? baseValues : [''];
    const mutationSet = mutationFor(slotName, normalized);
    const values = [];
    for (const mutationName of mutationSet) {
      for (const value of options) {
        values.push(applyCapitalization(applyMutation(String(value), mutationName), capitalization));
      }
    }
    const choiceCount = values.length || 1;
    const choice = slotIndex % choiceCount;
    slotIndex = Math.floor(slotIndex / choiceCount);
    return [values[choice] || ''];
  });

  return slotValues.map((values) => values[0]).join('');
}

function getDefaultPatternConfig() {
  return clone(DEFAULT_CONFIG);
}

module.exports = {
  DEFAULT_CONFIG,
  calculateCandidateSpace,
  generateCandidate,
  getDefaultPatternConfig,
  patternForIndex,
  normalizeConfig
};
