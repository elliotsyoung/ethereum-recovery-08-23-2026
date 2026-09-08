const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertPrivateFile,
  atomicWritePrivate,
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  readBoundedDescriptor,
  resolveRuntimeDir
} = require('../server/runtime');
const { initializeConfig } = require('../server/configInit');
const {
  archiveCheckpoint,
  defaultCheckpoint,
  loadCheckpoint,
  saveCheckpoint
} = require('../server/recovery/checkpoint');
const {
  loadStoredJob,
  prepareJob
} = require('../server/recovery/jobStore');
const { candidateForUniqueIndex } = require('../server/recovery/candidateGenerator');

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/low-cost-v3.json');

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ethereum-recovery-persistence-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function statMode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function minimalConfig(values = ['Alpha1!', 'Alpha1!', 'Wrong']) {
  return {
    schemaVersion: 2,
    patterns: [{
      name: 'candidate',
      slots: ['candidate'],
      candidate: values
    }],
    capitalization: ['none'],
    mutations: {}
  };
}

function createRealInputs(t, config = minimalConfig()) {
  const root = makeTempDirectory(t);
  const runtimeDir = path.join(root, 'runtime');
  const walletPath = path.join(root, 'wallet.json');
  const patternsPath = path.join(root, 'patterns.json');
  fs.copyFileSync(FIXTURE_PATH, walletPath);
  fs.chmodSync(walletPath, 0o600);
  fs.writeFileSync(patternsPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return { root, runtimeDir, walletPath, patternsPath };
}

test('private runtime helpers enforce owner-only directories and atomic files', (t) => {
  const root = makeTempDirectory(t);
  const runtimeDir = ensurePrivateDirectory(path.join(root, 'nested', 'runtime'));
  const jsonPath = path.join(runtimeDir, 'state.json');
  const binaryPath = path.join(runtimeDir, 'index.bin');

  atomicWritePrivateJson(jsonPath, { state: 'ready' });
  atomicWritePrivate(binaryPath, Buffer.from([0, 1, 2, 3]));

  assert.equal(statMode(runtimeDir), 0o700);
  assert.equal(statMode(jsonPath), 0o600);
  assert.equal(statMode(binaryPath), 0o600);
  assert.doesNotThrow(() => assertPrivateFile(jsonPath));
  assert.deepEqual(fs.readdirSync(runtimeDir).sort(), ['index.bin', 'state.json']);

  fs.chmodSync(jsonPath, 0o640);
  assert.throws(() => assertPrivateFile(jsonPath), /PERMISSIONS_MUST_BE_PRIVATE/);

  fs.chmodSync(jsonPath, 0o600);
  const symlinkPath = path.join(runtimeDir, 'state-link.json');
  fs.symlinkSync(jsonPath, symlinkPath);
  assert.throws(() => assertPrivateFile(symlinkPath), /MUST_BE_REGULAR_FILE/);

  const descriptor = fs.openSync(binaryPath, 'r');
  try {
    assert.deepEqual(readBoundedDescriptor(descriptor, 2), Buffer.from([0, 1, 2]));
  } finally {
    fs.closeSync(descriptor);
  }

  const insecureDirectory = path.join(root, 'existing-insecure-directory');
  fs.mkdirSync(insecureDirectory, { mode: 0o755 });
  assert.throws(
    () => ensurePrivateDirectory(insecureDirectory),
    /PERMISSIONS_MUST_BE_PRIVATE/
  );
  assert.equal(statMode(insecureDirectory), 0o755);
});

test('an environment-only runtime override is honored by every null-default caller', (t) => {
  const root = makeTempDirectory(t);
  const runtimeDir = path.join(root, 'environment-runtime');
  const previous = process.env.RECOVERY_DATA_DIR;
  process.env.RECOVERY_DATA_DIR = runtimeDir;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.RECOVERY_DATA_DIR;
    } else {
      process.env.RECOVERY_DATA_DIR = previous;
    }
  });

  assert.equal(resolveRuntimeDir(null), runtimeDir);
  const configPath = initializeConfig();
  assert.equal(configPath, path.join(runtimeDir, 'patterns.json'));
  assert.equal(statMode(runtimeDir), 0o700);
  assert.equal(statMode(configPath), 0o600);
});

test('checkpoints are job-bound, fail closed, and archive without deletion', (t) => {
  const root = makeTempDirectory(t);
  const checkpointPath = path.join(root, 'job', 'checkpoint.json');
  const jobId = 'a'.repeat(64);
  const checkpoint = {
    ...defaultCheckpoint(jobId),
    state: 'paused',
    nextCandidateIndex: 2,
    totalVerified: 3,
    activeElapsedMs: 1234,
    lastCheckpointAt: Date.now()
  };

  saveCheckpoint(checkpointPath, checkpoint);
  assert.equal(statMode(checkpointPath), 0o600);
  assert.deepEqual(loadCheckpoint(checkpointPath, jobId), checkpoint);
  assert.throws(
    () => loadCheckpoint(checkpointPath, 'b'.repeat(64)),
    /CHECKPOINT_JOB_MISMATCH/
  );

  const archivedPath = archiveCheckpoint(checkpointPath);
  assert.equal(fs.existsSync(checkpointPath), false);
  assert.equal(fs.existsSync(archivedPath), true);
  assert.equal(statMode(archivedPath), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(archivedPath, 'utf8')), checkpoint);

  fs.writeFileSync(checkpointPath, '{not json', { mode: 0o600 });
  assert.throws(() => loadCheckpoint(checkpointPath, jobId), /CHECKPOINT_CORRUPT/);
});

test('REAL jobs persist only protected snapshots and reload deterministic index maps', async (t) => {
  const inputs = createRealInputs(t);
  const first = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });

  assert.equal(first.candidatePlan.rawCount, 3);
  assert.equal(first.candidatePlan.uniqueCount, 2);
  assert.equal(first.candidatePlan.duplicateCount, 1);
  assert.equal(first.checkpoint.state, 'ready');
  assert.equal(statMode(inputs.runtimeDir), 0o700);
  assert.equal(statMode(first.paths.jobDir), 0o700);
  for (const filePath of [
    first.paths.manifestPath,
    first.paths.configPath,
    first.paths.indexMapPath,
    first.paths.checkpointPath
  ]) {
    assert.equal(statMode(filePath), 0o600, filePath);
  }

  const manifestText = fs.readFileSync(first.paths.manifestPath, 'utf8');
  const indexBytes = fs.readFileSync(first.paths.indexMapPath);
  assert.doesNotMatch(manifestText, /Alpha1!|Wrong/);
  assert.equal(indexBytes.includes(Buffer.from('Alpha1!')), false);

  const loaded = loadStoredJob({ runtimeDir: inputs.runtimeDir, jobId: first.jobId });
  assert.equal(candidateForUniqueIndex(loaded.config, loaded.candidatePlan, 0), 'Alpha1!');
  assert.equal(candidateForUniqueIndex(loaded.config, loaded.candidatePlan, 1), 'Wrong');

  const second = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });
  assert.equal(second.jobId, first.jobId);
  assert.deepEqual(Array.from(second.candidatePlan.rawIndices), [0, 2]);
});

test('wallet and configuration fingerprints isolate checkpoints', async (t) => {
  const inputs = createRealInputs(t);
  const first = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });
  saveCheckpoint(first.paths.checkpointPath, {
    ...first.checkpoint,
    state: 'paused',
    nextCandidateIndex: 1,
    totalVerified: 1,
    lastCheckpointAt: Date.now()
  });

  const secondWalletPath = path.join(inputs.root, 'same-wallet-different-bytes.json');
  fs.writeFileSync(
    secondWalletPath,
    `${fs.readFileSync(inputs.walletPath, 'utf8')}\n`,
    { mode: 0o600 }
  );
  const walletChanged = await prepareJob({
    mode: 'REAL',
    walletPath: secondWalletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });
  assert.notEqual(walletChanged.jobId, first.jobId);
  assert.equal(walletChanged.checkpoint.state, 'ready');
  assert.equal(walletChanged.checkpoint.nextCandidateIndex, 0);

  const secondPatternsPath = path.join(inputs.root, 'patterns-2.json');
  fs.writeFileSync(
    secondPatternsPath,
    `${JSON.stringify(minimalConfig(['Alpha1!', 'Different']))}\n`,
    { mode: 0o600 }
  );
  const configChanged = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: secondPatternsPath,
    runtimeDir: inputs.runtimeDir
  });
  assert.notEqual(configChanged.jobId, first.jobId);
  assert.equal(configChanged.checkpoint.state, 'ready');
});

test('--fresh semantics archive a compatible checkpoint and start ready', async (t) => {
  const inputs = createRealInputs(t);
  const first = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });
  saveCheckpoint(first.paths.checkpointPath, {
    ...first.checkpoint,
    state: 'paused',
    nextCandidateIndex: 1,
    totalVerified: 1,
    lastCheckpointAt: Date.now()
  });

  const fresh = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir,
    fresh: true
  });
  assert.equal(fresh.jobId, first.jobId);
  assert.equal(fresh.checkpoint.state, 'ready');
  assert.equal(fresh.checkpoint.nextCandidateIndex, 0);

  const archived = fs.readdirSync(first.paths.jobDir)
    .filter((name) => /^checkpoint\..+\.json$/.test(name));
  assert.equal(archived.length, 1);
  assert.equal(statMode(path.join(first.paths.jobDir, archived[0])), 0o600);
});

test('an immutable configuration snapshot is verified before an existing job resumes', async (t) => {
  const inputs = createRealInputs(t);
  const first = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });

  fs.writeFileSync(
    first.paths.configPath,
    `${JSON.stringify(minimalConfig(['Tampered']))}\n`,
    { mode: 0o600 }
  );

  await assert.rejects(
    prepareJob({
      mode: 'REAL',
      walletPath: inputs.walletPath,
      patternsPath: inputs.patternsPath,
      runtimeDir: inputs.runtimeDir
    }),
    /JOB_CONFIG_HASH_MISMATCH/
  );
});
