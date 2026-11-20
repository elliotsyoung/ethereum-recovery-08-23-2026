// A mask is a union of finite character products. The decision trie counts the
// union exactly (including overlapping alternatives), without enumerating it.
// Counts stay BigInt through preview; executable plans retain safe integer indexes.
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const ALL = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).join('');
const SYMBOLS = [...ALL].filter((character) => !/[A-Za-z0-9]/.test(character)).join('');
const ALPHABETS = Object.freeze({ l: LOWER, u: UPPER, a: LOWER + UPPER, d: DIGITS, s: SYMBOLS, x: ALL });
const MAX_ALTERNATIVES = 64;
const MAX_PRODUCTS = 4096;
const MAX_TRIE_NODES = 100_000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const INPUT_KEYS = new Set(['searchMode', 'masks', 'mask', 'minLength', 'maxLength']);

function normalizeMaskRules(input) {
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) throw new TypeError('Unsupported mask search setting.');
  }
  if (input.masks !== undefined && input.mask !== undefined) throw new TypeError('Supply masks or mask, not both.');
  const minLength = input.minLength ?? 11;
  const maxLength = input.maxLength ?? 64;
  for (const value of [minLength, maxLength]) {
    if (!Number.isSafeInteger(value) || value < 11 || value > 64) {
      throw new TypeError('Password lengths must be whole numbers from 11 to 64.');
    }
  }
  if (minLength > maxLength) throw new TypeError('minLength cannot exceed maxLength.');
  let masks = input.masks ?? input.mask ?? [];
  if (typeof masks === 'string') masks = masks.split(/\r?\n/).filter((entry) => entry.length > 0);
  if (!Array.isArray(masks) || masks.length > MAX_ALTERNATIVES
      || masks.some((entry) => typeof entry !== 'string' || !entry.length || entry.length > 1024 || /[^\x20-\x7e]/.test(entry))) {
    throw new TypeError(`Supply up to ${MAX_ALTERNATIVES} masks using English letters, digits and ASCII punctuation or spaces; non-ASCII characters are unsupported.`);
  }
  masks = [...new Set(masks)];
  // Validate syntax before saving any configuration, including masks which do
  // not intersect the selected length range.
  for (const mask of masks) parseMask(mask);
  return { searchMode: 'mask', masks, minLength, maxLength };
}

function parseMask(mask) {
  const tokens = [];
  for (let index = 0; index < mask.length; index += 1) {
    let alphabet = mask[index];
    let min = 1;
    let max = 1;
    let variable = false;
    if (mask[index] === '?') {
      const code = mask[++index];
      if (code === '?') alphabet = '?';
      else if (Object.hasOwn(ALPHABETS, code)) {
        alphabet = ALPHABETS[code];
        variable = true;
      } else throw new TypeError('Unknown mask token. Use ?l, ?u, ?a, ?d, ?s, ?x, or ?? for a literal question mark.');
      if (variable && mask[index + 1] === '{') {
        const repeat = /^\{(\d+)(?:,(\d+))?\}/.exec(mask.slice(index + 1));
        if (!repeat) throw new TypeError('Mask repetition must be {n} or {min,max}.');
        min = Number(repeat[1]);
        max = Number(repeat[2] ?? repeat[1]);
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max > 64 || min > max) {
          throw new TypeError('Mask repetitions must range from 0 to 64, with min no greater than max.');
        }
        index += repeat[0].length;
      }
    }
    tokens.push({ alphabet, min, max });
  }
  return tokens;
}

function productsForMask(mask, rules, addProduct) {
  const tokens = parseMask(mask);
  const minRemaining = Array(tokens.length + 1).fill(0);
  const maxRemaining = Array(tokens.length + 1).fill(0);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    minRemaining[index] = minRemaining[index + 1] + tokens[index].min;
    maxRemaining[index] = maxRemaining[index + 1] + tokens[index].max;
  }
  const walk = (index, product) => {
    if (product.length + minRemaining[index] > rules.maxLength
        || product.length + maxRemaining[index] < rules.minLength) return;
    if (index === tokens.length) {
      addProduct(product);
      return;
    }
    const token = tokens[index];
    for (let count = token.min; count <= token.max; count += 1) {
      if (product.length + count > rules.maxLength) break;
      walk(index + 1, [...product, ...Array(count).fill(token.alphabet)]);
    }
  };
  walk(0, []);
}

function buildMaskModel(config, { preview = false } = {}) {
  const rules = config.guided;
  const masks = rules.masks.length ? rules.masks : [`?x{${rules.minLength},${rules.maxLength}}`];
  const productsByLength = new Map();
  const productKeys = new Set();
  let expansions = 0;
  for (const mask of masks) {
    productsForMask(mask, rules, (product) => {
      expansions += 1;
      if (expansions > MAX_PRODUCTS) throw new RangeError('These variable-length masks need too many structural alternatives. Split the masks into smaller jobs; completed checks are reused across jobs.');
      const key = JSON.stringify(product);
      if (productKeys.has(key)) return;
      productKeys.add(key);
      if (!productsByLength.has(product.length)) productsByLength.set(product.length, []);
      productsByLength.get(product.length).push(product);
    });
  }
  let nodeCount = 0;
  let exactCount = 0n;
  const blocks = [];
  const terminal = { count: 1n, edges: [] };
  for (const length of [...productsByLength.keys()].sort((a, b) => a - b)) {
    const products = productsByLength.get(length);
    const cache = new Map();
    const build = (position, active) => {
      if (position === length) return terminal;
      const key = `${position}:${active.join(',')}`;
      if (cache.has(key)) return cache.get(key);
      nodeCount += 1;
      if (nodeCount > MAX_TRIE_NODES) throw new RangeError('The overlap between these masks is too complex to index. Split alternatives into separate jobs; completed checks are reused across jobs.');
      const node = { count: 0n, edges: [] };
      cache.set(key, node);
      for (const character of ALL) {
        const next = active.filter((id) => products[id][position].includes(character));
        if (!next.length) continue;
        const child = build(position + 1, next);
        node.edges.push({ character, child });
        node.count += child.count;
      }
      return node;
    };
    const root = build(0, products.map((_, index) => index));
    blocks.push({ layout: 'mask', length, root, offset: Number(exactCount), size: Number(root.count), exactCount: root.count });
    exactCount += root.count;
  }
  if (exactCount === 0n) throw new RangeError('No passwords satisfy these masks and lengths. Widen the length range or correct the masks.');
  if (!preview && exactCount > MAX_SAFE) throw new RangeError('Search exceeds the exact counting limit for an executable job (9 quadrillion candidates). Preview still shows its exact size. Add only confirmed information or divide it into explicit smaller hypotheses.');
  return { kind: 'mask', config, blocks, exactCount, rawCount: exactCount <= MAX_SAFE ? Number(exactCount) : null, nodeCount };
}

function maskCandidateFromModel(model, index) {
  if (typeof index !== 'number') throw new TypeError('candidateIndex must be a number.');
  if (!Number.isSafeInteger(index) || index < 0 || model.rawCount === null || index >= model.rawCount) {
    throw new RangeError(`candidateIndex must be between 0 and ${model.rawCount - 1}.`);
  }
  const block = model.blocks.find((entry) => index >= entry.offset && index < entry.offset + entry.size);
  let rank = BigInt(index - block.offset);
  let node = block.root;
  let candidate = '';
  while (node.edges.length) {
    for (const edge of node.edges) {
      if (rank >= edge.child.count) rank -= edge.child.count;
      else {
        candidate += edge.character;
        node = edge.child;
        break;
      }
    }
  }
  return candidate;
}

function summarizeMaskModel(model) {
  const rules = model.config.guided;
  return {
    rawCandidateCount: model.rawCount, uniqueCandidateCount: model.rawCount,
    candidateCountExact: model.exactCount.toString(), runnable: model.rawCount !== null,
    duplicatesRemoved: 0, lazy: true, searchMode: 'mask',
    minLength: rules.minLength, maxLength: rules.maxLength,
    maskCount: rules.masks.length,
    perLength: model.blocks.map((block) => ({ length: block.length, candidateCountExact: block.exactCount.toString() })),
    message: rules.masks.length
      ? 'Exact unique count across all mask alternatives. Literal characters, capitalization, and positions are required; spelling and rhymes are never assumed.'
      : 'All English letters in both cases, digits and ASCII punctuation and spaces in every position within your selected length range. No word, spelling, rhyme, or placement assumptions.',
    coverageWarnings: [
      `Only lengths ${rules.minLength}–${rules.maxLength} are included. The supported maximum is 64; non-ASCII characters are outside this search.`,
      ...(rules.masks.length ? ['Mask literals and character types exclude every alternative not represented by a mask. Use ?x wherever memory is uncertain, or add a broader mask as another alternative.'] : [])
    ]
  };
}

module.exports = { ALPHABETS, normalizeMaskRules, buildMaskModel, maskCandidateFromModel, summarizeMaskModel };
