// The guided search is indexed by disjoint layouts and segment lengths. Only word
// pairs are deduplicated in memory; numeric and symbol products stay lazy.
const SHIFT_SYMBOLS = '!@#$%^&*()_+{}|:"<>?~';
const MAX_GUIDED_CANDIDATES = Number.MAX_SAFE_INTEGER;
const MAX_WORDS = 200;
const STYLE_NAMES = new Set(['title', 'lower', 'upper', 'none']);
const LAYOUT_NAMES = new Set(['suffix', 'between', 'split']);
const RULE_KEYS = new Set([
  'word1', 'word2', 'minLength', 'maxLength', 'minDigits', 'maxDigits',
  'minSymbols', 'maxSymbols', 'symbols', 'caseStyles', 'layouts',
  'digitMode', 'symbolMode'
]);

function getGuidedDefaults() {
  return {
    word1: [], word2: [], minLength: 8, maxLength: 24,
    minDigits: 2, maxDigits: 2, minSymbols: 2, maxSymbols: 4,
    symbols: SHIFT_SYMBOLS, caseStyles: ['title', 'lower'],
    layouts: ['suffix', 'between', 'split'],
    digitMode: 'repeated', symbolMode: 'repeated'
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isGuidedConfig(config) {
  return isRecord(config) && Object.prototype.hasOwnProperty.call(config, 'guided');
}

function integer(value, key, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function words(value, key, allowEmpty = false) {
  const entries = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  if (!Array.isArray(entries) || (!allowEmpty && entries.length === 0)) {
    throw new TypeError(`${key} needs at least one word.`);
  }
  if (entries.length > 2000) throw new TypeError(`${key} accepts up to ${MAX_WORDS} distinct words.`);
  const unique = new Set();
  for (const word of entries) {
    if (typeof word !== 'string' || !/^[A-Za-z]{1,32}$/.test(word)) {
      throw new TypeError(`${key} must contain English keyboard letters only, 1–32 letters per word.`);
    }
    unique.add(word);
  }
  if (unique.size > MAX_WORDS) throw new TypeError(`${key} accepts up to ${MAX_WORDS} distinct words.`);
  return [...unique];
}

function selection(value, key, options) {
  if (!Array.isArray(value) || value.length === 0
      || value.some((entry) => !options.has(entry))) {
    throw new TypeError(`${key} needs at least one supported choice.`);
  }
  return [...new Set(value)];
}

function normalizeRules(input) {
  if (!isRecord(input)) throw new TypeError('Search settings must be an object.');
  for (const key of Object.keys(input)) {
    if (!RULE_KEYS.has(key)) throw new TypeError('Unsupported search setting.');
  }
  const rules = { ...getGuidedDefaults(), ...input };
  rules.word1 = words(rules.word1, 'First words');
  rules.word2 = words(rules.word2, 'Second words', true);
  if (!rules.word2.length) rules.word2 = [...rules.word1];
  for (const [minKey, maxKey, min, max] of [
    ['minLength', 'maxLength', 2, 64],
    ['minDigits', 'maxDigits', 0, 12],
    ['minSymbols', 'maxSymbols', 0, 12]
  ]) {
    integer(rules[minKey], minKey, min, max);
    integer(rules[maxKey], maxKey, min, max);
    if (rules[minKey] > rules[maxKey]) throw new TypeError(`${minKey} cannot exceed ${maxKey}.`);
  }
  if (typeof rules.symbols !== 'string'
      || [...rules.symbols].some((symbol) => !SHIFT_SYMBOLS.includes(symbol))) {
    throw new TypeError('Symbols must come from the shifted US English keyboard keys.');
  }
  rules.symbols = [...new Set(rules.symbols)].join('');
  if (rules.maxSymbols > 0 && !rules.symbols.length) throw new TypeError('Choose at least one symbol.');
  rules.caseStyles = selection(rules.caseStyles, 'caseStyles', STYLE_NAMES);
  rules.layouts = selection(rules.layouts, 'layouts', LAYOUT_NAMES);
  for (const key of ['digitMode', 'symbolMode']) {
    if (!['repeated', 'all'].includes(rules[key])) throw new TypeError(`${key} must be repeated or all.`);
  }
  return rules;
}

function buildGuidedConfig(input) {
  return { schemaVersion: 2, guided: normalizeRules(input) };
}

function validateGuidedConfig(config) {
  if (!isRecord(config) || config.schemaVersion !== 2
      || Object.keys(config).some((key) => !['schemaVersion', 'guided'].includes(key))) {
    throw new TypeError('Guided configuration must use schemaVersion 2 and guided settings.');
  }
  return buildGuidedConfig(config.guided);
}

function styleWord(word, style) {
  if (style === 'none') return word;
  if (style === 'upper') return word.toUpperCase();
  if (style === 'lower') return word.toLowerCase();
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

function wordGroups(rules, concatenate) {
  const seen = new Set();
  const groups = new Map();
  for (const style of rules.caseStyles) {
    const firstWords = [...new Set(rules.word1.map((word) => styleWord(word, style)))];
    const secondWords = [...new Set(rules.word2.map((word) => styleWord(word, style)))];
    for (const second of secondWords) {
      for (const first of firstWords) {
        const key = concatenate ? first + second : `${first}\0${second}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const length = first.length + second.length;
        if (length + rules.minDigits + rules.minSymbols > rules.maxLength
            || length + rules.maxDigits + rules.maxSymbols < rules.minLength) continue;
        if (!groups.has(length)) groups.set(length, []);
        groups.get(length).push(concatenate ? key : [first, second]);
      }
    }
  }
  return groups;
}

function segmentCount(length, alphabet, mode) {
  if (length === 0) return 1n;
  return mode === 'repeated' ? BigInt(alphabet.length) : BigInt(alphabet.length) ** BigInt(length);
}

function buildGuidedModel(config) {
  const normalized = validateGuidedConfig(config);
  const rules = normalized.guided;
  const joined = rules.layouts.includes('suffix') ? wordGroups(rules, true) : null;
  const separated = rules.layouts.some((layout) => layout !== 'suffix') ? wordGroups(rules, false) : null;
  const blocks = [];
  let total = 0n;
  for (const layout of rules.layouts) {
    const groups = layout === 'suffix' ? joined : separated;
    for (let digitLength = rules.minDigits; digitLength <= rules.maxDigits; digitLength += 1) {
      if (layout === 'between' && digitLength < 1) continue;
      if (layout === 'split' && digitLength < 2) continue;
      const splits = layout === 'split'
        ? Array.from({ length: digitLength - 1 }, (_, index) => index + 1)
        : [layout === 'between' ? digitLength : 0];
      for (const digitsA of splits) {
        const digitsB = digitLength - digitsA;
        const countA = segmentCount(digitsA, '0123456789', rules.digitMode);
        const countB = segmentCount(digitsB, '0123456789', rules.digitMode);
        for (let symbolLength = rules.minSymbols; symbolLength <= rules.maxSymbols; symbolLength += 1) {
          const countSymbols = segmentCount(symbolLength, rules.symbols, rules.symbolMode);
          for (const [wordLength, pairs] of groups) {
            const length = wordLength + digitLength + symbolLength;
            if (length < rules.minLength || length > rules.maxLength) continue;
            const size = BigInt(pairs.length) * countA * countB * countSymbols;
            if (total + size > BigInt(MAX_GUIDED_CANDIDATES)) {
              throw new RangeError('Search exceeds the exact counting limit (9 quadrillion candidates). Narrow the words, lengths, symbols, or segment choices.');
            }
            blocks.push({
              layout, pairs, digitsA, digitsB, symbolLength,
              countA: Number(countA), countB: Number(countB),
              offset: Number(total), size: Number(size)
            });
            total += size;
          }
        }
      }
    }
  }
  if (total === 0n) throw new RangeError('No passwords satisfy these settings. Widen the length range or adjust the digit, symbol, or layout choices.');
  return { config: normalized, blocks, rawCount: Number(total) };
}

function segmentAt(index, length, alphabet, mode) {
  if (!length) return '';
  if (mode === 'repeated') return alphabet[index].repeat(length);
  let value = '';
  for (let position = 0; position < length; position += 1) {
    value = alphabet[index % alphabet.length] + value;
    index = Math.floor(index / alphabet.length);
  }
  return value;
}

function guidedEntryForIndex(model, index) {
  if (typeof index !== 'number') throw new TypeError('candidateIndex must be a number.');
  if (!Number.isSafeInteger(index) || index < 0 || index >= model.rawCount) {
    throw new RangeError(`candidateIndex must be between 0 and ${model.rawCount - 1}.`);
  }
  let low = 0;
  let high = model.blocks.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const block = model.blocks[middle];
    if (index < block.offset) high = middle - 1;
    else if (index >= block.offset + block.size) low = middle + 1;
    else return block;
  }
  throw new RangeError('candidateIndex is outside the candidate space.');
}

function guidedCandidateFromModel(model, index) {
  const block = guidedEntryForIndex(model, index);
  const rules = model.config.guided;
  let local = index - block.offset;
  const pair = block.pairs[local % block.pairs.length];
  local = Math.floor(local / block.pairs.length);
  const digitsA = segmentAt(local % block.countA, block.digitsA, '0123456789', rules.digitMode);
  local = Math.floor(local / block.countA);
  const digitsB = segmentAt(local % block.countB, block.digitsB, '0123456789', rules.digitMode);
  local = Math.floor(local / block.countB);
  const symbols = segmentAt(local, block.symbolLength, rules.symbols, rules.symbolMode);
  return block.layout === 'suffix'
    ? pair + digitsB + symbols
    : pair[0] + digitsA + pair[1] + digitsB + symbols;
}

function summarizeGuidedConfig(config) {
  const model = buildGuidedModel(config);
  return {
    rawCandidateCount: model.rawCount,
    uniqueCandidateCount: model.rawCount,
    duplicatesRemoved: 0,
    lazy: true,
    word1Count: model.config.guided.word1.length,
    word2Count: model.config.guided.word2.length,
    minLength: model.config.guided.minLength,
    maxLength: model.config.guided.maxLength,
    layouts: [...model.config.guided.layouts],
    message: 'Exact count for your selected words and rules; this does not search every English word or every keyboard arrangement.'
  };
}

module.exports = {
  SHIFT_SYMBOLS, MAX_GUIDED_CANDIDATES, MAX_WORDS,
  getGuidedDefaults, isGuidedConfig, buildGuidedConfig, validateGuidedConfig,
  buildGuidedModel, guidedCandidateFromModel, guidedEntryForIndex, summarizeGuidedConfig
};
