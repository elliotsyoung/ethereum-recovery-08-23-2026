const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { SetupController } = require('../server/setupController');
const { loadStoredJob, prepareJob, releaseJobLock } = require('../server/recovery/jobStore');
const { buildGuidedConfig } = require('../server/recovery/guidedConfig');
const { revealPassword } = require('../server/reveal');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethereum-recovery-setup-test-'));
  const runtimeDir = path.join(root, 'runtime');
  const walletPath = path.join(root, 'wallet.json');
  fs.copyFileSync(path.join(__dirname, 'fixtures/low-cost-v3.json'), walletPath);
  fs.chmodSync(walletPath, 0o600);
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) await controller.shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  const rules = {
    word1: ['Al'], word2: ['pha'], caseStyles: ['none'], layouts: ['suffix'],
    minLength: 7, maxLength: 7, minDigits: 1, maxDigits: 1,
    minSymbols: 1, maxSymbols: 1, symbols: '!'
  };
  return {
    root, runtimeDir, walletPath, rules,
    input: { mode: 'REAL', walletPath, rules },
    controller(options = {}) {
      const controller = new SetupController({ runtimeDir, workerSetting: '1', ...options });
      controllers.push(controller);
      return controller;
    }
  };
}

async function waitForState(controller, state) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = controller.getStatus();
    if (status.state === state) return status;
    if (status.state === 'failed') throw new Error(`Recovery failed: ${status.errorCode}`);
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${state}`);
}

test('guided setup previews without filesystem work and gives actionable validation errors', (t) => {
  const inputs = fixture(t);
  const controller = inputs.controller();
  assert.equal(controller.getStatus().state, 'setup');
  assert.equal(controller.getSetup().savedJobAvailable, false);
  const preview = controller.preview(inputs.input);
  assert.equal(preview.uniqueCandidateCount, 10);
  assert.equal(fs.existsSync(inputs.runtimeDir), false);
  assert.throws(() => controller.preview({ ...inputs.input, rules: { ...inputs.rules, minLength: 12 } }),
    { code: 'RULES_INVALID' });
  assert.throws(() => controller.preview({ ...inputs.input, walletPath: 'relative.json' }),
    { code: 'WALLET_PATH_INVALID' });
});

test('guided real recovery supports pause, stop, restart, restore, find, and verified reveal', async (t) => {
  const inputs = fixture(t);
  const first = inputs.controller();
  const ready = await first.configure(inputs.input);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.uniqueCandidateCount, 10);
  assert.equal(ready.benchmark.selectedWorkerCount, 1);
  assert.equal(first.getSetup().savedJobAvailable, true);
  const { jobId, paths } = first.job;
  assert.equal(fs.statSync(first.savedPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.indexMapPath).size, 0);
  assert.equal(first.job.candidatePlan.rawIndices, null);

  await first.start();
  await assert.rejects(first.configure(inputs.input), { code: 'SEARCH_ACTIVE' });
  const paused = await first.pause();
  assert.equal(paused.state, 'paused');
  assert.equal(loadStoredJob({ runtimeDir: inputs.runtimeDir, jobId }).checkpoint.state, 'paused');
  await first.resume();
  const stopped = await first.stop();
  assert.equal(stopped.state, 'stopped');
  await first.start();
  await first.shutdown();
  const interrupted = loadStoredJob({ runtimeDir: inputs.runtimeDir, jobId });
  assert.equal(interrupted.checkpoint.state, 'interrupted');

  const second = inputs.controller();
  const restored = await second.restore();
  assert.equal(restored.jobId, jobId);
  assert.equal(restored.state, 'interrupted');
  assert.equal(restored.nextCandidateIndex, interrupted.checkpoint.nextCandidateIndex);
  await second.resume();
  const found = await waitForState(second, 'found');
  assert.equal(found.jobId, jobId);
  assert.equal(found.matchFound, true);
  assert.equal(found.searchedCandidateCount, 2);
  assert.equal(found.remainingCandidateCount, 8);
  assert.equal(found.estimatedSecondsRemaining, 0);
  assert.doesNotMatch(JSON.stringify(found), /Alpha1!/);
  assert.doesNotMatch(fs.readFileSync(paths.checkpointPath, 'utf8'), /Alpha1!/);
  assert.equal(await revealPassword({ jobId, runtimeDir: inputs.runtimeDir }), 'Alpha1!');
  await second.shutdown();

  const third = inputs.controller();
  const persistedFound = await third.restore();
  assert.equal(persistedFound.state, 'found');
  assert.equal(persistedFound.jobId, jobId);
  assert.equal(await revealPassword({ jobId, runtimeDir: inputs.runtimeDir }), 'Alpha1!');
});

test('missing saved setup and simultaneous requests leave the controller usable', async (t) => {
  const inputs = fixture(t);
  const controller = inputs.controller();
  await assert.rejects(controller.restore(), { code: 'SAVED_SETUP_NOT_FOUND' });
  assert.equal(controller.getStatus().state, 'setup');
  const configuring = controller.configure(inputs.input);
  assert.equal(controller.getStatus().state, 'preparing');
  await assert.rejects(controller.configure(inputs.input), { code: 'OPERATION_IN_PROGRESS' });
  assert.throws(() => controller.start(), { code: 'OPERATION_IN_PROGRESS' });
  const prepared = await configuring;
  assert.equal(prepared.state, 'ready');
  assert.equal(prepared.errorCode, null);
  assert.equal(controller.getSetup().busy, false);
});

test('a saved-setup write failure releases the prepared job lock', async (t) => {
  const inputs = fixture(t);
  const controller = inputs.controller();
  const originalRename = fs.renameSync;
  fs.renameSync = function failSavedSetupWrite(source, destination) {
    if (destination === controller.savedPath) throw new Error('INJECTED_STORAGE_FAILURE');
    return originalRename.call(this, source, destination);
  };
  try {
    await assert.rejects(controller.configure(inputs.input), { code: 'INJECTED_STORAGE_FAILURE' });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(controller.engine, null);
  assert.equal(controller.job, null);
  const reacquired = await prepareJob({
    mode: 'REAL', walletPath: inputs.walletPath, runtimeDir: inputs.runtimeDir,
    config: buildGuidedConfig(inputs.rules), acquireLock: true
  });
  await releaseJobLock(reacquired.lock);
  assert.equal((await controller.configure(inputs.input)).state, 'ready');
});

test('shutdown during preparation cleans up and refuses subsequent operations', async (t) => {
  const inputs = fixture(t);
  const controller = inputs.controller();
  const configuring = controller.configure(inputs.input);
  const closing = controller.shutdown();
  await assert.rejects(configuring, { code: 'SHUTDOWN_IN_PROGRESS' });
  await closing;
  assert.equal(controller.engine, null);
  assert.equal(controller.job, null);
  await assert.rejects(controller.restore(), { code: 'SHUTDOWN_IN_PROGRESS' });
});

test('trillion-candidate guided plans persist compactly and reject snapshot or marker tampering', async (t) => {
  const inputs = fixture(t);
  const config = buildGuidedConfig({
    ...inputs.rules, minLength: 18, maxLength: 18,
    minDigits: 12, maxDigits: 12, digitMode: 'all'
  });
  const job = await prepareJob({
    mode: 'REAL', walletPath: inputs.walletPath, runtimeDir: inputs.runtimeDir, config
  });
  assert.equal(job.candidatePlan.uniqueCount, 1_000_000_000_000);
  assert.equal(fs.statSync(job.paths.indexMapPath).size, 0);
  const stored = () => loadStoredJob({ runtimeDir: inputs.runtimeDir, jobId: job.jobId });
  assert.equal(stored().candidatePlan.uniqueCount, 1_000_000_000_000);
  const originalConfig = fs.readFileSync(job.paths.configPath);
  fs.writeFileSync(job.paths.configPath, JSON.stringify({
    ...config, guided: { ...config.guided, word1: ['Ox'] }
  }));
  assert.throws(stored, /JOB_CONFIG_HASH_MISMATCH/);
  fs.writeFileSync(job.paths.configPath, originalConfig);

  fs.writeFileSync(job.paths.indexMapPath, 'x');
  assert.throws(stored, /CANDIDATE_INDEX_MAP/);
  fs.writeFileSync(job.paths.indexMapPath, '');
  assert.equal(stored().candidatePlan.rawIndices, null);

  const manifest = JSON.parse(fs.readFileSync(job.paths.manifestPath, 'utf8'));
  delete manifest.planKind;
  fs.writeFileSync(job.paths.manifestPath, JSON.stringify(manifest));
  assert.throws(stored, /JOB_RAW_COUNT_INVALID|CANDIDATE_INDEX_MAP_INVALID/);
});

test('editing restores normalized settings and restart archives progress without changing job identity', async (t) => {
  const inputs = fixture(t);
  const controller = inputs.controller();
  assert.throws(() => controller.currentSetup(), { code: 'SETUP_REQUIRED' });
  const ready = await controller.configure(inputs.input);
  const selection = controller.currentSetup();
  assert.equal(selection.walletPath, inputs.walletPath);
  assert.deepEqual(selection.rules.word1, ['Al']);
  selection.rules.word1.push('Changed');
  assert.deepEqual(controller.currentSetup().rules.word1, ['Al']);
  await controller.start();
  await assert.rejects(controller.restart(), { code: 'SEARCH_ACTIVE' });
  await waitForState(controller, 'found');
  const restarted = await controller.restart();
  assert.equal(restarted.jobId, ready.jobId);
  assert.equal(restarted.state, 'ready');
  assert.equal(restarted.nextCandidateIndex, 0);
  assert.equal(restarted.totalVerified, 0);
  const archives = fs.readdirSync(controller.job.paths.jobDir).filter((name) => /^checkpoint\..+\.json$/.test(name));
  assert.equal(archives.length, 1);
  const archived = JSON.parse(fs.readFileSync(path.join(controller.job.paths.jobDir, archives[0]), 'utf8'));
  assert.equal(archived.state, 'found');
});

test('fresh is consumed once and restore keeps the saved worker setting unless explicitly overridden', async (t) => {
  const inputs = fixture(t);
  const first = inputs.controller({ fresh: true });
  await first.configure(inputs.input);
  await first.start();
  await waitForState(first, 'found');
  assert.equal((await first.restore()).state, 'found');
  await first.shutdown();
  const second = inputs.controller({ workerSetting: 'auto', workerSettingExplicit: false });
  await second.restore();
  assert.equal(second.engine.workerSetting, '1');
  assert.equal(second.getStatus().benchmark.selectedWorkerCount, 1);
});

test('constructor checkpoint failures release the job lock and invalid saved values are rejected', async (t) => {
  const inputs = fixture(t);
  const first = inputs.controller();
  await first.configure(inputs.input);
  const { paths, jobId } = first.job;
  await first.shutdown();
  const checkpoint = JSON.parse(fs.readFileSync(paths.checkpointPath, 'utf8'));
  fs.writeFileSync(paths.checkpointPath, JSON.stringify({ ...checkpoint, state: 'running', startedAt: Date.now() }));
  const second = inputs.controller();
  const originalRename = fs.renameSync;
  fs.renameSync = function failConstructorCheckpoint(source, destination) {
    if (destination === paths.checkpointPath) throw new Error('INJECTED_CONSTRUCTOR_FAILURE');
    return originalRename.call(this, source, destination);
  };
  try {
    await assert.rejects(second.restore(), { code: 'INJECTED_CONSTRUCTOR_FAILURE' });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(second.job, null);
  assert.equal(second.engine, null);
  assert.equal((await second.restore()).jobId, jobId);
  await second.shutdown();
  fs.writeFileSync(second.savedPath, 'null');
  await assert.rejects(inputs.controller().restore(), { code: 'SAVED_SETUP_INVALID' });
});
