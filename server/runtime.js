const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_SCHEMA_VERSION = 2;
const DEFAULT_RUNTIME_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Ethereum Recovery');
const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;

function resolveRuntimeDir(input) {
  const selected = input ?? process.env.RECOVERY_DATA_DIR ?? DEFAULT_RUNTIME_DIR;
  if (typeof selected !== 'string' || selected.length === 0) {
    throw new Error('RUNTIME_DIRECTORY_PATH_INVALID');
  }
  return path.resolve(selected);
}

function ensurePrivateDirectory(directoryPath) {
  const resolved = path.resolve(directoryPath);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('RUNTIME_DIRECTORY_INVALID');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('RUNTIME_DIRECTORY_OWNER_INVALID');
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error('RUNTIME_DIRECTORY_PERMISSIONS_MUST_BE_PRIVATE');
  }
  return resolved;
}

function assertPrivateDirectory(directoryPath, { label = 'PRIVATE_DIRECTORY' } = {}) {
  const resolved = path.resolve(directoryPath);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label}_MUST_BE_DIRECTORY`);
  }
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700) {
    throw new Error(`${label}_PERMISSIONS_MUST_BE_PRIVATE`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label}_MUST_BE_OWNED_BY_CURRENT_USER`);
  }
  return resolved;
}

function fsyncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateFile(filePath, { maxBytes = MAX_PRIVATE_FILE_BYTES, label = 'PRIVATE_FILE' } = {}) {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${label}_PATH_MUST_BE_ABSOLUTE`);
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${label}_NOT_FOUND`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label}_MUST_BE_REGULAR_FILE`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`${label}_TOO_LARGE`);
  }
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
    throw new Error(`${label}_PERMISSIONS_MUST_BE_PRIVATE`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label}_MUST_BE_OWNED_BY_CURRENT_USER`);
  }
  return stat;
}

function readBoundedDescriptor(descriptor, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error('READ_LIMIT_INVALID');
  }
  const chunks = [];
  const limit = maxBytes + 1;
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total));
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

function readPrivateFile(filePath, { maxBytes = MAX_PRIVATE_FILE_BYTES, label = 'PRIVATE_FILE' } = {}) {
  const initialStat = assertPrivateFile(filePath, { maxBytes, label });
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()
        || openedStat.dev !== initialStat.dev
        || openedStat.ino !== initialStat.ino
        || openedStat.size > maxBytes
        || (openedStat.mode & 0o077) !== 0
        || (openedStat.mode & 0o400) === 0
        || (typeof process.getuid === 'function' && openedStat.uid !== process.getuid())) {
      throw new Error(`${label}_CHANGED_DURING_READ`);
    }
    const contents = readBoundedDescriptor(descriptor, maxBytes);
    if (contents.length > maxBytes) {
      throw new Error(`${label}_TOO_LARGE`);
    }
    return contents;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function atomicWritePrivate(filePath, contents) {
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  const randomPart = crypto.randomBytes(8).toString('hex');
  const temporaryPath = `${resolved}.${process.pid}.${randomPart}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, resolved);
    fs.chmodSync(resolved, 0o600);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temp file may not have been created or may already have been renamed.
    }
    throw error;
  }
}

function atomicWritePrivateJson(filePath, value) {
  atomicWritePrivate(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicCreatePrivate(filePath, contents) {
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  const randomPart = crypto.randomBytes(8).toString('hex');
  const temporaryPath = `${resolved}.${process.pid}.${randomPart}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, resolved);
    fs.chmodSync(resolved, 0o600);
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temp file may not exist or may already have been unlinked.
    }
    throw error;
  }
}

function readJsonFile(filePath, { maxBytes = MAX_PRIVATE_FILE_BYTES, privateFile = false, label = 'JSON_FILE' } = {}) {
  let contents;
  if (privateFile) {
    contents = readPrivateFile(filePath, { maxBytes, label }).toString('utf8');
  } else {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`${label}_INVALID`);
    }
    contents = fs.readFileSync(filePath, 'utf8');
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label}_INVALID_JSON`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
  APP_SCHEMA_VERSION,
  DEFAULT_RUNTIME_DIR,
  MAX_PRIVATE_FILE_BYTES,
  assertPrivateDirectory,
  assertPrivateFile,
  atomicCreatePrivate,
  atomicWritePrivate,
  atomicWritePrivateJson,
  canonicalJson,
  ensurePrivateDirectory,
  fsyncDirectory,
  readBoundedDescriptor,
  readPrivateFile,
  readJsonFile,
  resolveRuntimeDir,
  sha256Hex
};
