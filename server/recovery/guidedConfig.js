// The guided search is indexed by disjoint layouts and segment lengths. Only word
// pairs are deduplicated in memory; numeric and symbol products stay lazy.
const SHIFT_SYMBOLS = '!@#$%^&*()_+{}|:"<>?~';
const NUMBER_ROW_SYMBOLS = '!@#$%^&*()';
const ASCII_SYMBOLS = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32))
  .filter((character) => !/[A-Za-z0-9]/.test(character)).join('');
const { normalizeMaskRules, buildMaskModel, maskCandidateFromModel, summarizeMaskModel } = require('./maskSearch');
const MAX_GUIDED_CANDIDATES = Number.MAX_SAFE_INTEGER;
const MAX_WORDS = 200;
const MAX_WORD_LETTERS = 32;
const MAX_DIGIT_VALUE = 999_999_999_999; // 12 digits, the digit-count ceiling.
const STYLE_NAMES = new Set(['title', 'lower', 'upper', 'none']);
const LAYOUT_NAMES = new Set(['suffix', 'between', 'split']);
const RULE_KEYS = new Set([
  'word1', 'word2', 'minLength', 'maxLength', 'minDigits', 'maxDigits',
  'minSymbols', 'maxSymbols', 'symbols', 'caseStyles', 'layouts',
  'digitMode', 'symbolMode',
  // Additional constraints that shrink the search space. Each defaults to a
  // no-op, so an unset value never narrows coverage on its own.
  'word1MinLen', 'word1MaxLen', 'word2MinLen', 'word2MaxLen',
  'digitMin', 'digitMax', 'requireDistinctWords', 'sharedEnding'
]);

function getGuidedDefaults() {
  return {
    word1: [], word2: [], minLength: 11, maxLength: 20,
    minDigits: 2, maxDigits: 2, minSymbols: 2, maxSymbols: 2,
    symbols: NUMBER_ROW_SYMBOLS, caseStyles: ['title'],
    layouts: ['suffix'],
    digitMode: 'all', symbolMode: 'all',
    word1MinLen: 1, word1MaxLen: MAX_WORD_LETTERS,
    word2MinLen: 1, word2MaxLen: MAX_WORD_LETTERS,
    digitMin: 0, digitMax: null,
    requireDistinctWords: false, sharedEnding: 0
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

function boolean(value, key) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${key} must be true or false.`);
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

function normalizeRules(input, version = 2) {
  if (!isRecord(input)) throw new TypeError('Search settings must be an object.');
  for (const key of Object.keys(input)) {
    if (!RULE_KEYS.has(key)) throw new TypeError('Unsupported search setting.');
  }
  const rules = { ...(version === 3 ? getFragmentDefaults() : getGuidedDefaults()), ...input };
  rules.word1 = words(rules.word1, 'First words');
  rules.word2 = words(rules.word2, 'Second words', true);
  if (!rules.word2.length) rules.word2 = [...rules.word1];
  for (const [minKey, maxKey, min, max] of [
    ['minLength', 'maxLength', version === 3 ? 11 : 2, 64],
    ['minDigits', 'maxDigits', 0, 12],
    ['minSymbols', 'maxSymbols', 0, 12],
    ['word1MinLen', 'word1MaxLen', 1, MAX_WORD_LETTERS],
    ['word2MinLen', 'word2MaxLen', 1, MAX_WORD_LETTERS]
  ]) {
    integer(rules[minKey], minKey, min, max);
    integer(rules[maxKey], maxKey, min, max);
    if (rules[minKey] > rules[maxKey]) throw new TypeError(`${minKey} cannot exceed ${maxKey}.`);
  }
  integer(rules.digitMin, 'digitMin', 0, MAX_DIGIT_VALUE);
  if (rules.digitMax === null || rules.digitMax === undefined) {
    rules.digitMax = null;
  } else {
    integer(rules.digitMax, 'digitMax', 0, MAX_DIGIT_VALUE);
    if (rules.digitMin > rules.digitMax) throw new TypeError('digitMin cannot exceed digitMax.');
  }
  boolean(rules.requireDistinctWords, 'requireDistinctWords');
  integer(rules.sharedEnding, 'sharedEnding', 0, MAX_WORD_LETTERS);
  if (version === 3 && rules.sharedEnding !== 0) {
    throw new TypeError('Shared endings and rhymes are not reliable search constraints. Use an explicit remembered mask instead.');
  }
  const allowedSymbols = version === 3 ? ASCII_SYMBOLS : SHIFT_SYMBOLS;
  if (typeof rules.symbols !== 'string'
      || [...rules.symbols].some((symbol) => !allowedSymbols.includes(symbol))) {
    throw new TypeError(version === 3 ? 'Symbols must be ASCII keyboard punctuation or spaces.' : 'Symbols must come from the shifted US English keyboard keys.');
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

function getFragmentDefaults() {
  return {
    ...getGuidedDefaults(), maxLength: 64,
    minDigits: 0, maxDigits: 12, minSymbols: 0, maxSymbols: 12,
    symbols: ASCII_SYMBOLS, caseStyles: ['title', 'lower', 'upper', 'none'],
    layouts: ['suffix', 'between', 'split']
  };
}

function getQuestionnaireDefaults() {
  return { searchMode: 'mask', masks: [], minLength: 11, maxLength: 64 };
}

function buildQuestionnaireConfig(input) {
  if (!isRecord(input)) throw new TypeError('Search settings must be an object.');
  if (input.searchMode === 'mask') {
    return { schemaVersion: 3, guided: normalizeMaskRules(input) };
  }
  if (input.searchMode !== 'fragments') throw new TypeError('Choose mask or fragments searchMode.');
  const { searchMode, ...settings } = input;
  const rules = normalizeRules(settings, 3);
  delete rules.sharedEnding;
  return { schemaVersion: 3, guided: { searchMode, ...rules } };
}

function validateGuidedConfig(config) {
  if (!isRecord(config) || ![2, 3].includes(config.schemaVersion)
      || Object.keys(config).some((key) => !['schemaVersion', 'guided'].includes(key))) {
    throw new TypeError('Guided configuration must use schemaVersion 2 or 3 and guided settings.');
  }
  return config.schemaVersion === 3 ? buildQuestionnaireConfig(config.guided) : buildGuidedConfig(config.guided);
}

function styleWord(word, style) {
  if (style === 'none') return word;
  if (style === 'upper') return word.toUpperCase();
  if (style === 'lower') return word.toLowerCase();
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

function pairAllowed(first, second, rules) {
  if (rules.requireDistinctWords && first.toLowerCase() === second.toLowerCase()) return false;
  if (rules.sharedEnding > 0) {
    const tail = rules.sharedEnding;
    if (first.length < tail || second.length < tail) return false;
    if (first.slice(-tail).toLowerCase() !== second.slice(-tail).toLowerCase()) return false;
    // A shared ending is only a rhyme when the words start differently.
    if (first[0].toLowerCase() === second[0].toLowerCase()) return false;
  }
  return true;
}

function wordGroups(rules, concatenate) {
  const seen = new Set();
  const groups = new Map();
  for (const style of rules.caseStyles) {
    const firstWords = [...new Set(rules.word1.map((word) => styleWord(word, style)))]
      .filter((word) => word.length >= rules.word1MinLen && word.length <= rules.word1MaxLen);
    const secondWords = [...new Set(rules.word2.map((word) => styleWord(word, style)))]
      .filter((word) => word.length >= rules.word2MinLen && word.length <= rules.word2MaxLen);
    for (const second of secondWords) {
      for (const first of firstWords) {
        if (!pairAllowed(first, second, rules)) continue;
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

// A contiguous run of digits, optionally bounded to an integer value range.
// Returns the number of allowed values and the string at each local index.
function digitGroup(length, mode, digitMin, digitMax) {
  if (length === 0) return { length: 0, count: 1, mode: 'all', start: 0 };
  const maxForLength = 10 ** length - 1;
  const high = digitMax === null ? maxForLength : Math.min(digitMax, maxForLength);
  const low = Math.max(0, digitMin);
  if (mode === 'all') {
    return { length, count: high >= low ? high - low + 1 : 0, mode: 'all', start: low };
  }
  // Repeated mode emits one digit repeated across the run (00, 777, ...).
  const repunit = Number('1'.repeat(length));
  const digits = [];
  for (let digit = 0; digit <= 9; digit += 1) {
    const value = digit * repunit;
    if (value >= low && value <= high) digits.push(digit);
  }
  return { length, count: digits.length, mode: 'repeated', digits };
}

function digitSegmentAt(group, index) {
  if (group.length === 0) return '';
  if (group.mode === 'all') return String(group.start + index).padStart(group.length, '0');
  return String(group.digits[index]).repeat(group.length);
}

function symbolCount(length, alphabet, mode) {
  if (length === 0) return 1n;
  return mode === 'repeated' ? BigInt(alphabet.length) : BigInt(alphabet.length) ** BigInt(length);
}

function buildGuidedModel(config, { preview = false } = {}) {
  const normalized = validateGuidedConfig(config);
  const rules = normalized.guided;
  if (rules.searchMode === 'mask') return buildMaskModel(normalized, { preview });
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
        const groupA = digitGroup(digitsA, rules.digitMode, rules.digitMin, rules.digitMax);
        const groupB = digitGroup(digitsB, rules.digitMode, rules.digitMin, rules.digitMax);
        if (groupA.count === 0 || groupB.count === 0) continue;
        for (let symbolLength = rules.minSymbols; symbolLength <= rules.maxSymbols; symbolLength += 1) {
          const countSymbols = symbolCount(symbolLength, rules.symbols, rules.symbolMode);
          for (const [wordLength, pairs] of groups) {
            const length = wordLength + digitLength + symbolLength;
            if (length < rules.minLength || length > rules.maxLength) continue;
            const size = BigInt(pairs.length) * BigInt(groupA.count) * BigInt(groupB.count) * countSymbols;
            if (!preview && total + size > BigInt(MAX_GUIDED_CANDIDATES)) {
              throw new RangeError('Search exceeds the exact counting limit (9 quadrillion candidates). Narrow the words, lengths, symbols, or segment choices.');
            }
            blocks.push({
              layout, pairs, groupA, groupB, symbolLength,
              offset: Number(total), size: Number(size)
            });
            total += size;
          }
        }
      }
    }
  }
  if (total === 0n) throw new RangeError('No passwords satisfy these settings. Widen the length range or adjust the digit, symbol, word-length, or layout choices.');
  return { config: normalized, blocks, rawCount: total <= BigInt(MAX_GUIDED_CANDIDATES) ? Number(total) : null, exactCount: total };
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
  if (model.kind === 'mask') return maskCandidateFromModel(model, index);
  const block = guidedEntryForIndex(model, index);
  const rules = model.config.guided;
  let local = index - block.offset;
  const pair = block.pairs[local % block.pairs.length];
  local = Math.floor(local / block.pairs.length);
  const digitsA = digitSegmentAt(block.groupA, local % block.groupA.count);
  local = Math.floor(local / block.groupA.count);
  const digitsB = digitSegmentAt(block.groupB, local % block.groupB.count);
  local = Math.floor(local / block.groupB.count);
  const symbols = segmentAt(local, block.symbolLength, rules.symbols, rules.symbolMode);
  return block.layout === 'suffix'
    ? pair + digitsB + symbols
    : pair[0] + digitsA + pair[1] + digitsB + symbols;
}

function summarizeGuidedConfig(config) {
  const model = buildGuidedModel(config, { preview: true });
  if (model.kind === 'mask') return summarizeMaskModel(model);
  return {
    rawCandidateCount: model.rawCount,
    uniqueCandidateCount: model.rawCount,
    duplicatesRemoved: 0,
    candidateCountExact: model.exactCount.toString(),
    runnable: model.rawCount !== null,
    lazy: true,
    searchMode: 'fragments',
    word1Count: model.config.guided.word1.length,
    word2Count: model.config.guided.word2.length,
    minLength: model.config.guided.minLength,
    maxLength: model.config.guided.maxLength,
    layouts: [...model.config.guided.layouts],
    message: 'Exact count for your supplied letter fragments and selected rules. This targeted search does not cover other fragments, arbitrary capitalization, or other keyboard arrangements.',
    coverageWarnings: [
      'Only supplied fragments, the selected capitalization styles, and the selected layouts are covered. Symbols are trailing in these layouts. Use masks when fragment boundaries or placement are uncertain.',
      ...(model.config.guided.sharedEnding > 0 ? ['This restored legacy search still requires shared endings. That constraint is not inferred or enabled in new searches; remove it by creating a new mask or fragment search.'] : [])
    ]
  };
}

module.exports = {
  SHIFT_SYMBOLS, NUMBER_ROW_SYMBOLS, ASCII_SYMBOLS, MAX_GUIDED_CANDIDATES, MAX_WORDS,
  getGuidedDefaults, isGuidedConfig, buildGuidedConfig, validateGuidedConfig,
  getQuestionnaireDefaults, getFragmentDefaults, buildQuestionnaireConfig,
  buildGuidedModel, guidedCandidateFromModel, guidedEntryForIndex, summarizeGuidedConfig
};
