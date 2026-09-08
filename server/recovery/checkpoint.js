const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  APP_SCHEMA_VERSION,
  atomicWritePrivateJson,
  fsyncDirectory,
  readJsonFile
} = require('../runtime');

const JOB_ID_PATTERN = /^[a-f0-9]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const CHECKPOINT_STATES = new Set([
  'ready',
  'running',
  'paused',
  'interrupted',
  'stopped',
  'exhausted',
  'found',
  'failed'
]);

function defaultCheckpoint(jobId) {
  if (!JOB_ID_PATTERN.test(String(jobId || ''))) {
    throw new Error('CHECKPOINT_JOB_INVALID');
  }
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    jobId,
    state: 'ready',
    nextCandidateIndex: 0,
    totalVerified: 0,
    activeElapsedMs: 0,
    startedAt: null,
    lastCheckpointAt: null,
    matchedUniqueIndex: null,
    errorCode: null
  };
}

function validateCheckpoint(value, expectedJobId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CHECKPOINT_INVALID');
  }
  if (value.schemaVersion !== APP_SCHEMA_VERSION) {
    throw new Error('CHECKPOINT_SCHEMA_MISMATCH');
  }
  if (value.jobId !== expectedJobId) {
    throw new Error('CHECKPOINT_JOB_MISMATCH');
  }
  if (!CHECKPOINT_STATES.has(value.state)) {
    throw new Error('CHECKPOINT_STATE_INVALID');
  }
  for (const key of ['nextCandidateIndex', 'totalVerified', 'activeElapsedMs']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error('CHECKPOINT_COUNTER_INVALID');
    }
  }
  if (value.matchedUniqueIndex !== null
      && (!Number.isSafeInteger(value.matchedUniqueIndex) || value.matchedUniqueIndex < 0)) {
    throw new Error('CHECKPOINT_MATCH_INDEX_INVALID');
  }
  for (const key of ['startedAt', 'lastCheckpointAt']) {
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) {
      throw new Error('CHECKPOINT_TIMESTAMP_INVALID');
    }
  }
  if (value.errorCode !== null
      && (typeof value.errorCode !== 'string' || !ERROR_CODE_PATTERN.test(value.errorCode))) {
    throw new Error('CHECKPOINT_ERROR_CODE_INVALID');
  }
  if (value.state === 'found' && value.matchedUniqueIndex === null) {
    throw new Error('CHECKPOINT_MATCH_INDEX_MISSING');
  }
  if (value.state !== 'found' && value.matchedUniqueIndex !== null) {
    throw new Error('CHECKPOINT_MATCH_STATE_INVALID');
  }
  if (value.state === 'failed' && value.errorCode === null) {
    throw new Error('CHECKPOINT_ERROR_CODE_MISSING');
  }
  if (value.state !== 'failed' && value.errorCode !== null) {
    throw new Error('CHECKPOINT_ERROR_STATE_INVALID');
  }
  return { ...defaultCheckpoint(expectedJobId), ...value };
}

function saveCheckpoint(filePath, checkpoint) {
  const validated = validateCheckpoint(checkpoint, checkpoint.jobId);
  atomicWritePrivateJson(filePath, validated);
  return validated;
}

function loadCheckpoint(filePath, jobId) {
  if (!fs.existsSync(filePath)) {
    return defaultCheckpoint(jobId);
  }
  let parsed;
  try {
    parsed = readJsonFile(filePath, {
      privateFile: true,
      label: 'CHECKPOINT'
    });
  } catch {
    throw new Error('CHECKPOINT_CORRUPT');
  }
  return validateCheckpoint(parsed, jobId);
}

function archiveCheckpoint(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  // Reject symlinks and insecure files before moving anything.
  readJsonFile(filePath, { privateFile: true, label: 'CHECKPOINT' });
  const parsed = path.parse(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nonce = crypto.randomBytes(6).toString('hex');
  const archivedPath = path.join(parsed.dir, `${parsed.name}.${stamp}.${nonce}${parsed.ext}`);
  fs.linkSync(filePath, archivedPath);
  fs.chmodSync(archivedPath, 0o600);
  fs.unlinkSync(filePath);
  fsyncDirectory(parsed.dir);
  return archivedPath;
}

module.exports = {
  CHECKPOINT_STATES,
  archiveCheckpoint,
  defaultCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  validateCheckpoint
};
