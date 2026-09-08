const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  APP_SCHEMA_VERSION,
  assertPrivateDirectory,
  assertPrivateFile,
  atomicCreatePrivate,
  atomicWritePrivate,
  atomicWritePrivateJson,
  canonicalJson,
  ensurePrivateDirectory,
  readJsonFile,
  readPrivateFile,
  resolveRuntimeDir,
  sha256Hex
} = require('../runtime');
const {
  GENERATOR_VERSION,
  MAX_RAW_CANDIDATES,
  SCHEMA_VERSION,
  calculateCandidateSpace,
  compileCandidatePlan,
  validateConfig
} = require('./candidateGenerator');
const {
  archiveCheckpoint,
  loadCheckpoint,
  saveCheckpoint
} = require('./checkpoint');
const { ensureDemoWallet, preflightKeystore } = require('./walletVerifier');

const EXAMPLE_PATTERNS_PATH = path.resolve(__dirname, '../../data/patterns.example.json');
const JOB_ID_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function killLockProcessGroup(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
    }
  }
}

function waitForLockProcessExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('JOB_LOCK_RELEASE_FAILED'));
    }, timeoutMs);
    timeout.unref();
    child.once('exit', onExit);
  });
}

function assertJobLockOwned(lock) {
  if (!lock) return;
  if (lock.lost || lock.child.exitCode !== null || lock.child.signalCode !== null) {
    throw new Error('JOB_LOCK_LOST');
  }
  try {
    process.kill(lock.child.pid, 0);
  } catch {
    lock.lost = true;
    killLockProcessGroup(lock.child);
    throw new Error('JOB_LOCK_LOST');
  }
}

function encodeRawIndices(rawIndices) {
  const buffer = Buffer.allocUnsafe(rawIndices.length * 4);
  rawIndices.forEach((rawIndex, index) => buffer.writeUInt32LE(rawIndex, index * 4));
  return buffer;
}

function decodeRawIndices(buffer) {
  if (buffer.length % 4 !== 0) {
    throw new Error('CANDIDATE_INDEX_MAP_INVALID');
  }
  const rawIndices = new Uint32Array(buffer.length / 4);
  for (let index = 0; index < rawIndices.length; index += 1) {
    rawIndices[index] = buffer.readUInt32LE(index * 4);
  }
  return rawIndices;
}

function jobPaths(runtimeDir, jobId, { create = true } = {}) {
  const jobsDir = path.join(runtimeDir, 'jobs');
  const jobDir = path.join(jobsDir, jobId);
  if (create) {
    ensurePrivateDirectory(jobsDir);
    ensurePrivateDirectory(jobDir);
  }
  return {
    runtimeDir,
    jobDir,
    manifestPath: path.join(jobDir, 'manifest.json'),
    configPath: path.join(jobDir, 'patterns.json'),
    indexMapPath: path.join(jobDir, 'candidate-index.bin'),
    checkpointPath: path.join(jobDir, 'checkpoint.json'),
    benchmarkPath: path.join(jobDir, 'benchmark.json'),
    lockPath: path.join(jobDir, 'recovery.lock')
  };
}

async function acquireJobLock(paths) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/lockf')) {
    throw new Error('JOB_LOCK_UNAVAILABLE');
  }
  try {
    atomicCreatePrivate(paths.lockPath, '');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = assertPrivateFile(paths.lockPath, {
    maxBytes: 0,
    label: 'JOB_LOCK'
  });
  const holderPath = path.resolve(__dirname, 'lockHolder.js');

  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/lockf', [
      '-k',
      '-t', '0',
      paths.lockPath,
      process.execPath,
      holderPath
    ], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      killLockProcessGroup(child);
      reject(new Error('JOB_LOCK_FAILED'));
    }, 5_000);
    timeout.unref();

    child.once('message', (message) => {
      if (settled) return;
      if (message?.type !== 'locked') {
        settled = true;
        clearTimeout(timeout);
        killLockProcessGroup(child);
        reject(new Error('JOB_LOCK_FAILED'));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const lock = {
        child,
        dev: stat.dev,
        ino: stat.ino,
        lockPath: paths.lockPath,
        lost: false,
        onLost: null,
        released: false,
        releasing: false
      };
      child.once('exit', () => {
        if (!lock.releasing && !lock.released) {
          killLockProcessGroup(child);
          lock.lost = true;
          if (typeof lock.onLost === 'function') lock.onLost();
        }
      });
      resolve(lock);
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killLockProcessGroup(child);
      reject(new Error('JOB_LOCK_FAILED'));
    });
    child.once('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killLockProcessGroup(child);
      reject(new Error('JOB_ALREADY_RUNNING'));
    });
  });
}

async function releaseJobLock(lock) {
  if (!lock || lock.released) return;
  if (lock.lost || lock.child.exitCode !== null || lock.child.signalCode !== null) {
    killLockProcessGroup(lock.child);
    lock.released = true;
    throw new Error('JOB_LOCK_LOST');
  }
  let releaseError = null;
  try {
    const current = assertPrivateFile(lock.lockPath, {
      maxBytes: 0,
      label: 'JOB_LOCK'
    });
    if (current.dev !== lock.dev || current.ino !== lock.ino) {
      releaseError = new Error('JOB_LOCK_CHANGED');
    }
  } catch {
    releaseError = new Error('JOB_LOCK_CHANGED');
  }

  lock.releasing = true;
  const exited = waitForLockProcessExit(lock.child);
  const sendError = await new Promise((resolve) => {
    try {
      lock.child.send({ type: 'release' }, (error) => resolve(error || null));
    } catch (error) {
      resolve(error);
    }
  });
  if (sendError) {
    releaseError ||= new Error('JOB_LOCK_RELEASE_FAILED');
    killLockProcessGroup(lock.child);
  }
  try {
    await exited;
  } catch {
    releaseError ||= new Error('JOB_LOCK_RELEASE_FAILED');
    killLockProcessGroup(lock.child);
    try {
      await waitForLockProcessExit(lock.child, 1_000);
    } catch {
      // SIGKILL should be definitive; preserve the release failure if it is not.
    }
  }
  lock.released = true;
  if (releaseError) {
    throw releaseError;
  }
}

function readPatternConfig({ mode, patternsPath, config, runtimeDir }) {
  if (config) {
    return validateConfig(config);
  }
  if (mode === 'DEMO') {
    return validateConfig(readJsonFile(EXAMPLE_PATTERNS_PATH, { label: 'DEMO_PATTERNS' }));
  }
  const target = patternsPath || path.join(runtimeDir, 'patterns.json');
  if (!path.isAbsolute(target)) {
    throw new Error('PATTERNS_PATH_MUST_BE_ABSOLUTE');
  }
  assertPrivateFile(target, { label: 'PATTERNS_FILE' });
  return validateConfig(readJsonFile(target, { privateFile: true, label: 'PATTERNS_FILE' }));
}

function jobIdentity({ mode, walletHash, configHash }) {
  return {
    mode,
    walletHash,
    configHash,
    schemaVersion: APP_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION
  };
}

function calculateJobId(identity) {
  return sha256Hex(canonicalJson(identity));
}

function assertSafeCount(value, label, maximum = MAX_RAW_CANDIDATES) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label}_INVALID`);
  }
}

function validateManifest(manifest, expectedJobId = null) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('JOB_MANIFEST_INVALID');
  }
  if (manifest.schemaVersion !== APP_SCHEMA_VERSION
      || manifest.generatorVersion !== GENERATOR_VERSION
      || !['DEMO', 'REAL'].includes(manifest.mode)
      || !JOB_ID_PATTERN.test(String(manifest.jobId || ''))
      || !SHA256_PATTERN.test(String(manifest.walletHash || ''))
      || !SHA256_PATTERN.test(String(manifest.configHash || ''))
      || !SHA256_PATTERN.test(String(manifest.indexMapHash || ''))) {
    throw new Error('JOB_MANIFEST_INVALID');
  }
  if (expectedJobId !== null && manifest.jobId !== expectedJobId) {
    throw new Error('JOB_MANIFEST_MISMATCH');
  }
  if (calculateJobId(jobIdentity(manifest)) !== manifest.jobId) {
    throw new Error('JOB_MANIFEST_ID_MISMATCH');
  }
  if (typeof manifest.walletPath !== 'string' || !path.isAbsolute(manifest.walletPath)
      || typeof manifest.walletAddress !== 'string'
      || !/^0x[0-9a-f]{40}$/i.test(manifest.walletAddress)
      || manifest.cipher !== 'aes-128-ctr'
      || manifest.kdf?.name !== 'scrypt') {
    throw new Error('JOB_MANIFEST_INVALID');
  }
  for (const field of ['N', 'r', 'p']) {
    if (!Number.isSafeInteger(manifest.kdf[field]) || manifest.kdf[field] <= 0) {
      throw new Error('JOB_MANIFEST_INVALID');
    }
  }
  if (manifest.kdf.dklen !== 32) {
    throw new Error('JOB_MANIFEST_INVALID');
  }
  assertSafeCount(manifest.rawCandidateCount, 'JOB_RAW_COUNT');
  assertSafeCount(manifest.uniqueCandidateCount, 'JOB_UNIQUE_COUNT');
  assertSafeCount(manifest.duplicatesRemoved, 'JOB_DUPLICATE_COUNT');
  if (manifest.uniqueCandidateCount > manifest.rawCandidateCount
      || manifest.duplicatesRemoved !== manifest.rawCandidateCount - manifest.uniqueCandidateCount
      || typeof manifest.createdAt !== 'string'
      || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('JOB_MANIFEST_INVALID');
  }
  return manifest;
}

function validateExistingManifest(manifest, expected) {
  validateManifest(manifest, expected.jobId);
  for (const field of [
    'schemaVersion',
    'jobId',
    'mode',
    'walletHash',
    'configHash',
    'generatorVersion'
  ]) {
    if (manifest[field] !== expected[field]) {
      throw new Error('JOB_MANIFEST_MISMATCH');
    }
  }
  if (manifest.walletAddress.toLowerCase() !== expected.walletAddress.toLowerCase()
      || manifest.cipher !== expected.cipher
      || manifest.kdf.name !== expected.kdf.name
      || manifest.kdf.N !== expected.kdf.N
      || manifest.kdf.r !== expected.kdf.r
      || manifest.kdf.p !== expected.kdf.p
      || manifest.kdf.dklen !== expected.kdf.dklen) {
    throw new Error('JOB_MANIFEST_WALLET_MISMATCH');
  }
}

function loadCandidatePlan(paths, manifest, config) {
  if (manifest.rawCandidateCount === 0
      || manifest.uniqueCandidateCount === 0
      || calculateCandidateSpace(config) !== manifest.rawCandidateCount) {
    throw new Error('CANDIDATE_INDEX_MAP_INVALID');
  }
  const expectedBytes = manifest.uniqueCandidateCount * 4;
  assertPrivateFile(paths.indexMapPath, {
    maxBytes: expectedBytes,
    label: 'CANDIDATE_INDEX_MAP'
  });
  const encodedIndices = readPrivateFile(paths.indexMapPath, {
    maxBytes: expectedBytes,
    label: 'CANDIDATE_INDEX_MAP'
  });
  if (encodedIndices.length !== expectedBytes) {
    throw new Error('CANDIDATE_INDEX_MAP_LENGTH_MISMATCH');
  }
  if (sha256Hex(encodedIndices) !== manifest.indexMapHash) {
    throw new Error('CANDIDATE_INDEX_MAP_HASH_MISMATCH');
  }
  const rawIndices = decodeRawIndices(encodedIndices);
  if (rawIndices[0] !== 0) {
    throw new Error('CANDIDATE_INDEX_MAP_INVALID');
  }
  let previous = -1;
  for (const rawIndex of rawIndices) {
    if (rawIndex <= previous || rawIndex >= manifest.rawCandidateCount) {
      throw new Error('CANDIDATE_INDEX_MAP_INVALID');
    }
    previous = rawIndex;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: manifest.generatorVersion,
    rawCount: manifest.rawCandidateCount,
    uniqueCount: manifest.uniqueCandidateCount,
    duplicateCount: manifest.duplicatesRemoved,
    rawIndices
  };
}

function loadConfigSnapshot(paths, manifest) {
  const config = validateConfig(readJsonFile(paths.configPath, {
    privateFile: true,
    label: 'JOB_CONFIG'
  }));
  if (sha256Hex(canonicalJson(config)) !== manifest.configHash) {
    throw new Error('JOB_CONFIG_HASH_MISMATCH');
  }
  return config;
}

function loadOrCreateCheckpoint(paths, jobId, fresh, uniqueCount) {
  if (fresh) {
    if (fs.existsSync(paths.checkpointPath)) {
      validateCheckpointForPlan(
        loadCheckpoint(paths.checkpointPath, jobId),
        uniqueCount
      );
      archiveCheckpoint(paths.checkpointPath);
    }
  }
  if (!fs.existsSync(paths.checkpointPath)) {
    return saveCheckpoint(paths.checkpointPath, {
      schemaVersion: APP_SCHEMA_VERSION,
      jobId,
      state: 'ready',
      nextCandidateIndex: 0,
      totalVerified: 0,
      activeElapsedMs: 0,
      startedAt: null,
      lastCheckpointAt: Date.now(),
      matchedUniqueIndex: null,
      errorCode: null
    });
  }
  return loadCheckpoint(paths.checkpointPath, jobId);
}

function validateCheckpointForPlan(checkpoint, uniqueCount) {
  if (checkpoint.nextCandidateIndex > uniqueCount
      || checkpoint.totalVerified < checkpoint.nextCandidateIndex
      || (checkpoint.matchedUniqueIndex !== null
        && checkpoint.matchedUniqueIndex >= uniqueCount)) {
    throw new Error('CHECKPOINT_INDEX_OUT_OF_RANGE');
  }
  if (checkpoint.state === 'ready'
      && (checkpoint.nextCandidateIndex !== 0
        || checkpoint.totalVerified !== 0
        || checkpoint.activeElapsedMs !== 0
        || checkpoint.startedAt !== null)) {
    throw new Error('CHECKPOINT_READY_STATE_INVALID');
  }
  if (checkpoint.state === 'exhausted' && checkpoint.nextCandidateIndex !== uniqueCount) {
    throw new Error('CHECKPOINT_EXHAUSTED_STATE_INVALID');
  }
  if (checkpoint.state === 'found'
      && checkpoint.nextCandidateIndex > checkpoint.matchedUniqueIndex) {
    throw new Error('CHECKPOINT_FOUND_STATE_INVALID');
  }
  return checkpoint;
}

async function prepareJob({
  mode = 'DEMO',
  walletPath = null,
  patternsPath = null,
  runtimeDir: runtimeInput = null,
  fresh = false,
  config = null,
  acquireLock = false
} = {}) {
  const normalizedMode = String(mode).toUpperCase();
  if (!['DEMO', 'REAL'].includes(normalizedMode)) {
    throw new Error('MODE_INVALID');
  }
  const runtimeDir = ensurePrivateDirectory(resolveRuntimeDir(runtimeInput));
  let resolvedWalletPath;
  if (normalizedMode === 'DEMO') {
    const demoDirectory = ensurePrivateDirectory(path.join(runtimeDir, 'demo'));
    resolvedWalletPath = await ensureDemoWallet(
      path.join(demoDirectory, 'demo-keystore.json'),
      { scrypt: { N: 1024, r: 8, p: 1 } }
    );
  } else {
    if (!walletPath || !path.isAbsolute(walletPath)) {
      throw new Error('REAL_WALLET_ABSOLUTE_PATH_REQUIRED');
    }
    resolvedWalletPath = path.resolve(walletPath);
  }

  const wallet = preflightKeystore(resolvedWalletPath);
  const suppliedConfig = readPatternConfig({
    mode: normalizedMode,
    patternsPath,
    config,
    runtimeDir
  });
  const configHash = sha256Hex(canonicalJson(suppliedConfig));
  const identity = jobIdentity({
    mode: normalizedMode,
    walletHash: wallet.walletHash,
    configHash
  });
  const jobId = calculateJobId(identity);
  const paths = jobPaths(runtimeDir, jobId);
  const precompiledPlan = fs.existsSync(paths.manifestPath)
    ? null
    : compileCandidatePlan(suppliedConfig);
  const lock = acquireLock ? await acquireJobLock(paths) : null;
  let manifest;
  let patternConfig;
  let candidatePlan;
  try {
    if (fs.existsSync(paths.manifestPath)) {
      manifest = readJsonFile(paths.manifestPath, {
        privateFile: true,
        label: 'JOB_MANIFEST'
      });
      validateExistingManifest(manifest, {
        ...identity,
        jobId,
        walletAddress: wallet.address,
        cipher: 'aes-128-ctr',
        kdf: {
          name: 'scrypt',
          N: wallet.verificationContext.N,
          r: wallet.verificationContext.r,
          p: wallet.verificationContext.p,
          dklen: wallet.verificationContext.dklen
        }
      });
      patternConfig = loadConfigSnapshot(paths, manifest);
      if (canonicalJson(patternConfig) !== canonicalJson(suppliedConfig)) {
        throw new Error('JOB_CONFIG_MISMATCH');
      }
      candidatePlan = loadCandidatePlan(paths, manifest, patternConfig);
    } else {
      patternConfig = suppliedConfig;
      candidatePlan = precompiledPlan || compileCandidatePlan(patternConfig);
      const encodedIndices = encodeRawIndices(candidatePlan.rawIndices);
      manifest = {
        ...identity,
        jobId,
        walletPath: wallet.path,
        walletAddress: wallet.address,
        cipher: 'aes-128-ctr',
        kdf: {
          name: 'scrypt',
          N: wallet.verificationContext.N,
          r: wallet.verificationContext.r,
          p: wallet.verificationContext.p,
          dklen: wallet.verificationContext.dklen
        },
        rawCandidateCount: candidatePlan.rawCount,
        uniqueCandidateCount: candidatePlan.uniqueCount,
        duplicatesRemoved: candidatePlan.duplicateCount,
        indexMapHash: sha256Hex(encodedIndices),
        createdAt: new Date().toISOString()
      };
      assertJobLockOwned(lock);
      atomicWritePrivateJson(paths.configPath, patternConfig);
      assertJobLockOwned(lock);
      atomicWritePrivate(paths.indexMapPath, encodedIndices);
      assertJobLockOwned(lock);
      atomicWritePrivateJson(paths.manifestPath, manifest);
    }

    assertJobLockOwned(lock);
    const checkpoint = validateCheckpointForPlan(
      loadOrCreateCheckpoint(paths, jobId, fresh, candidatePlan.uniqueCount),
      candidatePlan.uniqueCount
    );

    assertJobLockOwned(lock);

    return {
      mode: normalizedMode,
      jobId,
      runtimeDir,
      paths,
      manifest,
      config: patternConfig,
      candidatePlan,
      wallet,
      checkpoint,
      lock
    };
  } catch (error) {
    if (lock && !lock.released) {
      try {
        await releaseJobLock(lock);
      } catch {
        // Preserve the preparation failure; a lost kernel lock needs no release.
      }
    }
    throw error;
  }
}

function loadStoredJob({ runtimeDir: runtimeInput = null, jobId }) {
  if (!JOB_ID_PATTERN.test(String(jobId || ''))) {
    throw new Error('JOB_ID_INVALID');
  }
  const runtimeDir = assertPrivateDirectory(resolveRuntimeDir(runtimeInput), {
    label: 'RUNTIME_DIRECTORY'
  });
  const paths = jobPaths(runtimeDir, jobId, { create: false });
  assertPrivateDirectory(path.dirname(paths.jobDir), { label: 'JOBS_DIRECTORY' });
  assertPrivateDirectory(paths.jobDir, { label: 'JOB_DIRECTORY' });
  const manifest = validateManifest(readJsonFile(paths.manifestPath, {
    privateFile: true,
    label: 'JOB_MANIFEST'
  }), jobId);
  const config = loadConfigSnapshot(paths, manifest);
  const candidatePlan = loadCandidatePlan(paths, manifest, config);
  const checkpoint = validateCheckpointForPlan(
    loadCheckpoint(paths.checkpointPath, jobId),
    candidatePlan.uniqueCount
  );
  return {
    mode: manifest.mode,
    jobId,
    runtimeDir,
    paths,
    manifest,
    config,
    candidatePlan,
    checkpoint
  };
}

module.exports = {
  EXAMPLE_PATTERNS_PATH,
  JOB_ID_PATTERN,
  acquireJobLock,
  calculateJobId,
  decodeRawIndices,
  encodeRawIndices,
  jobIdentity,
  jobPaths,
  loadStoredJob,
  prepareJob,
  releaseJobLock,
  validateCheckpointForPlan,
  validateManifest
};
