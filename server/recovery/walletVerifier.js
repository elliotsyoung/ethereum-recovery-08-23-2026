const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Wallet, encryptKeystoreJson, keccak256 } = require('ethers');
const { atomicCreatePrivate, readBoundedDescriptor } = require('../runtime');

const DEFAULT_DEMO_WALLET_PATH = path.resolve(__dirname, '../../wallet/demo-keystore.json');
const DEMO_PASSWORD = 'DemoPass123!';
const MAX_KEYSTORE_BYTES = 1024 * 1024;
const SCRYPT_MEMORY_CUSHION_BYTES = 64 * 1024 * 1024;
const contextCache = new WeakMap();

class KeystoreValidationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'KeystoreValidationError';
    this.code = 'INVALID_KEYSTORE';
  }
}

function invalidKeystore(message, cause) {
  return new KeystoreValidationError(message, cause ? { cause } : undefined);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseKeystore(input) {
  if (isPlainObject(input)) {
    return input;
  }
  if (typeof input !== 'string') {
    throw invalidKeystore('Keystore must be a JSON object or JSON string.');
  }

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw invalidKeystore('Keystore contains invalid JSON.', error);
  }
  if (!isPlainObject(parsed)) {
    throw invalidKeystore('Keystore JSON must contain an object.');
  }
  return parsed;
}

function requireObject(value, fieldName) {
  if (!isPlainObject(value)) {
    throw invalidKeystore(`Keystore field ${fieldName} must be an object.`);
  }
  return value;
}

function requireBareHex(value, fieldName, byteLength = null) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw invalidKeystore(`Keystore field ${fieldName} must be non-empty, even-length hexadecimal without a 0x prefix.`);
  }
  if (byteLength !== null && value.length !== byteLength * 2) {
    throw invalidKeystore(`Keystore field ${fieldName} must contain exactly ${byteLength} bytes.`);
  }
  return value.toLowerCase();
}

function requirePositiveSafeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidKeystore(`Keystore field ${fieldName} must be a positive safe integer.`);
  }
  return value;
}

function calculateScryptMemoryBytes(context) {
  const N = requirePositiveSafeInteger(context.N, 'crypto.kdfparams.n');
  const r = requirePositiveSafeInteger(context.r, 'crypto.kdfparams.r');
  const p = requirePositiveSafeInteger(context.p, 'crypto.kdfparams.p');
  const memoryBytes = 128n * BigInt(r) * (BigInt(N) + BigInt(p) + 2n);
  if (memoryBytes > BigInt(Number.MAX_SAFE_INTEGER - SCRYPT_MEMORY_CUSHION_BYTES)) {
    throw invalidKeystore('Keystore scrypt parameters require an unsupported amount of memory.');
  }
  return Number(memoryBytes);
}

function validateVerificationContext(input) {
  if (!isPlainObject(input)) {
    throw invalidKeystore('Verification context must be an object.');
  }

  const N = requirePositiveSafeInteger(input.N, 'crypto.kdfparams.n');
  const nBigInt = BigInt(N);
  if (N <= 1 || (nBigInt & (nBigInt - 1n)) !== 0n) {
    throw invalidKeystore('Keystore field crypto.kdfparams.n must be a power of two greater than one.');
  }
  const r = requirePositiveSafeInteger(input.r, 'crypto.kdfparams.r');
  const p = requirePositiveSafeInteger(input.p, 'crypto.kdfparams.p');
  if ((r <= 3 && Math.log2(N) >= 16 * r)
      || BigInt(r) * BigInt(p) >= (1n << 30n)) {
    throw invalidKeystore('Keystore scrypt work factors are outside the supported bounds.');
  }
  if (input.dklen !== 32) {
    throw invalidKeystore('Keystore field crypto.kdfparams.dklen must equal 32.');
  }

  const context = {
    N,
    r,
    p,
    dklen: 32,
    salt: requireBareHex(input.salt, 'crypto.kdfparams.salt'),
    ciphertext: requireBareHex(input.ciphertext, 'crypto.ciphertext', 32),
    mac: requireBareHex(input.mac, 'crypto.mac', 32)
  };
  calculateScryptMemoryBytes(context);
  return context;
}

function cryptoSectionFor(keystore) {
  const hasLowercase = Object.prototype.hasOwnProperty.call(keystore, 'crypto');
  const hasUppercase = Object.prototype.hasOwnProperty.call(keystore, 'Crypto');
  if (hasLowercase === hasUppercase) {
    throw invalidKeystore('Keystore must contain exactly one crypto section.');
  }
  return requireObject(hasLowercase ? keystore.crypto : keystore.Crypto, 'crypto');
}

function validateKeystore(input) {
  const keystore = parseKeystore(input);
  if (keystore.version !== 3) {
    throw invalidKeystore('Only version 3 keystores are supported.');
  }
  if (typeof keystore.id !== 'string'
      || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(keystore.id)) {
    throw invalidKeystore('Keystore field id must be a UUID.');
  }

  const bareAddress = requireBareHex(keystore.address, 'address', 20);
  const cryptoSection = cryptoSectionFor(keystore);
  if (cryptoSection.cipher !== 'aes-128-ctr') {
    throw invalidKeystore('Only the aes-128-ctr cipher is supported.');
  }
  if (cryptoSection.kdf !== 'scrypt') {
    throw invalidKeystore('Only the scrypt KDF is supported.');
  }

  const cipherparams = requireObject(cryptoSection.cipherparams, 'crypto.cipherparams');
  requireBareHex(cipherparams.iv, 'crypto.cipherparams.iv', 16);
  const kdfparams = requireObject(cryptoSection.kdfparams, 'crypto.kdfparams');
  const verificationContext = validateVerificationContext({
    N: kdfparams.n,
    r: kdfparams.r,
    p: kdfparams.p,
    dklen: kdfparams.dklen,
    salt: kdfparams.salt,
    ciphertext: cryptoSection.ciphertext,
    mac: cryptoSection.mac
  });

  return {
    keystore,
    address: `0x${bareAddress}`,
    verificationContext
  };
}

function createVerificationContext(input) {
  if (isPlainObject(input)
      && Object.prototype.hasOwnProperty.call(input, 'N')
      && Object.prototype.hasOwnProperty.call(input, 'ciphertext')) {
    return validateVerificationContext(input);
  }
  return validateKeystore(input).verificationContext;
}

function inspectSecureKeystoreFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || !path.isAbsolute(filePath)) {
    throw invalidKeystore('Keystore path must be an absolute path.');
  }

  let initialStat;
  try {
    initialStat = fs.lstatSync(filePath);
  } catch (error) {
    throw invalidKeystore('Keystore file cannot be accessed.', error);
  }
  if (initialStat.isSymbolicLink()) {
    throw invalidKeystore('Keystore path must not be a symbolic link.');
  }
  if (!initialStat.isFile()) {
    throw invalidKeystore('Keystore path must refer to a regular file.');
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && initialStat.uid !== currentUid) {
    throw invalidKeystore('Keystore file must be owned by the current user.');
  }
  if ((initialStat.mode & 0o400) === 0) {
    throw invalidKeystore('Keystore file must be readable by its owner.');
  }
  if ((initialStat.mode & 0o077) !== 0) {
    throw invalidKeystore('Keystore file must not grant permissions to group or other users.');
  }
  if (initialStat.size > MAX_KEYSTORE_BYTES) {
    throw invalidKeystore('Keystore file exceeds the 1 MiB size limit.');
  }

  return initialStat;
}

function readSecureKeystoreBytes(filePath) {
  const initialStat = inspectSecureKeystoreFile(filePath);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()
        || openedStat.dev !== initialStat.dev
        || openedStat.ino !== initialStat.ino) {
      throw invalidKeystore('Keystore file changed during validation.');
    }
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (currentUid !== null && openedStat.uid !== currentUid) {
      throw invalidKeystore('Keystore file must be owned by the current user.');
    }
    if ((openedStat.mode & 0o400) === 0 || (openedStat.mode & 0o077) !== 0) {
      throw invalidKeystore('Keystore file permissions changed during validation.');
    }
    if (openedStat.size > MAX_KEYSTORE_BYTES) {
      throw invalidKeystore('Keystore file exceeds the 1 MiB size limit.');
    }
    const bytes = readBoundedDescriptor(descriptor, MAX_KEYSTORE_BYTES);
    if (bytes.length > MAX_KEYSTORE_BYTES) {
      throw invalidKeystore('Keystore file exceeds the 1 MiB size limit.');
    }
    return bytes;
  } catch (error) {
    if (error instanceof KeystoreValidationError) {
      throw error;
    }
    throw invalidKeystore('Keystore file could not be read safely.', error);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function preflightKeystore(filePath) {
  const bytes = readSecureKeystoreBytes(filePath);
  const rawJson = bytes.toString('utf8');
  const validated = validateKeystore(rawJson);
  const walletHash = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    path: filePath,
    filePath,
    keystore: validated.keystore,
    parsedKeystore: validated.keystore,
    rawJson,
    walletHash,
    address: validated.address,
    verificationContext: validated.verificationContext
  };
}

function compiledContext(input) {
  if (isPlainObject(input) && contextCache.has(input)) {
    return contextCache.get(input);
  }

  const context = createVerificationContext(input);
  const compiled = {
    context,
    salt: Buffer.from(context.salt, 'hex'),
    ciphertext: Buffer.from(context.ciphertext, 'hex'),
    expectedMac: Buffer.from(context.mac, 'hex'),
    maxmem: calculateScryptMemoryBytes(context) + SCRYPT_MEMORY_CUSHION_BYTES
  };
  if (isPlainObject(input)) {
    contextCache.set(input, compiled);
  }
  return compiled;
}

function normalizeCandidate(candidate) {
  if (typeof candidate !== 'string') {
    throw new TypeError('Candidate password must be a string.');
  }
  return candidate.normalize('NFKC');
}

function verifyCandidate(contextOrKeystore, candidate) {
  const compiled = compiledContext(contextOrKeystore);
  const password = Buffer.from(normalizeCandidate(candidate), 'utf8');
  const derivedKey = crypto.scryptSync(password, compiled.salt, compiled.context.dklen, {
    N: compiled.context.N,
    r: compiled.context.r,
    p: compiled.context.p,
    maxmem: compiled.maxmem
  });
  const computedMacHex = keccak256(Buffer.concat([
    derivedKey.subarray(16, 32),
    compiled.ciphertext
  ]));
  const computedMac = Buffer.from(computedMacHex.slice(2), 'hex');
  return crypto.timingSafeEqual(computedMac, compiled.expectedMac);
}

function isIncorrectPasswordError(error) {
  return Boolean(error
    && error.code === 'INVALID_ARGUMENT'
    && error.argument === 'password'
    && (error.shortMessage === 'incorrect password' || /incorrect password/i.test(error.message || '')));
}

function isAddressMismatchError(error) {
  return Boolean(error
    && error.code === 'INVALID_ARGUMENT'
    && error.argument === 'address'
    && /address\/privateKey mismatch/i.test(error.shortMessage || error.message || ''));
}

async function confirmCandidate(keystoreOrRawJson, candidate, expectedAddress = null) {
  let source = keystoreOrRawJson;
  if (isPlainObject(source) && typeof source.rawJson === 'string') {
    source = source.rawJson;
  }
  const validated = validateKeystore(source);
  const rawJson = typeof source === 'string' ? source : JSON.stringify(validated.keystore);
  const normalizedCandidate = normalizeCandidate(candidate);

  let wallet;
  try {
    wallet = await Wallet.fromEncryptedJson(rawJson, normalizedCandidate);
  } catch (error) {
    if (isIncorrectPasswordError(error)) {
      return false;
    }
    if (isAddressMismatchError(error)) {
      throw invalidKeystore('Decrypted wallet address does not match the keystore address.', error);
    }
    throw error;
  }

  const requiredAddress = expectedAddress === null ? validated.address : expectedAddress;
  if (typeof requiredAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(requiredAddress)) {
    throw invalidKeystore('Expected wallet address must be a 20-byte 0x-prefixed hexadecimal value.');
  }
  if (wallet.address.toLowerCase() !== requiredAddress.toLowerCase()) {
    throw invalidKeystore('Decrypted wallet address does not match the keystore address.');
  }
  return true;
}

async function ensureDemoWallet(walletPath = DEFAULT_DEMO_WALLET_PATH, options = {}) {
  if (typeof walletPath !== 'string' || !path.isAbsolute(walletPath)) {
    throw invalidKeystore('Demo wallet path must be an absolute path.');
  }
  fs.mkdirSync(path.dirname(walletPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(walletPath)) {
    const wallet = options.wallet || Wallet.createRandom();
    const encryptionOptions = options.scrypt ? { scrypt: options.scrypt } : undefined;
    const encrypted = await encryptKeystoreJson({
      address: wallet.address,
      privateKey: wallet.privateKey
    }, options.password || DEMO_PASSWORD, encryptionOptions);
    try {
      atomicCreatePrivate(walletPath, encrypted);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      walletPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const stat = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || (currentUid !== null && stat.uid !== currentUid)) {
      throw invalidKeystore('Demo wallet must be a regular file owned by the current user.');
    }
    fs.fchmodSync(descriptor, 0o600);
  } catch (error) {
    if (error instanceof KeystoreValidationError) throw error;
    throw invalidKeystore('Demo wallet could not be secured.', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  preflightKeystore(walletPath);
  return walletPath;
}

function readKeystoreFile(filePath = DEFAULT_DEMO_WALLET_PATH) {
  return preflightKeystore(filePath).keystore;
}

module.exports = {
  DEFAULT_DEMO_WALLET_PATH,
  KeystoreValidationError,
  MAX_KEYSTORE_BYTES,
  calculateScryptMemoryBytes,
  confirmCandidate,
  createVerificationContext,
  ensureDemoWallet,
  parseKeystore,
  preflightKeystore,
  readKeystoreFile,
  normalizeCandidate,
  validateKeystore,
  validateVerificationContext,
  verifyCandidate
};
