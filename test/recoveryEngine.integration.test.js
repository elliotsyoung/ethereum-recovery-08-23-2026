const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { loadCheckpoint, saveCheckpoint } = require('../server/recovery/checkpoint');
const { prepareJob } = require('../server/recovery/jobStore');
const {
  RecoveryEngine,
  RecoveryStateError
} = require('../server/recovery/recoveryEngine');

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/low-cost-v3.json');

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ethereum-recovery-engine-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function candidateConfig(candidates) {
  return {
    schemaVersion: 2,
    patterns: [{
      name: 'candidate',
      slots: ['candidate'],
      candidate: candidates
    }],
    capitalization: ['none'],
    mutations: {}
  };
}

async function makeJob(t, candidates) {
  const root = makeTempDirectory(t);
  const runtimeDir = path.join(root, 'runtime');
  const walletPath = path.join(root, 'wallet.json');
  const patternsPath = path.join(root, 'patterns.json');
  fs.copyFileSync(FIXTURE_PATH, walletPath);
  fs.chmodSync(walletPath, 0o600);
  fs.writeFileSync(patternsPath, `${JSON.stringify(candidateConfig(candidates))}\n`, { mode: 0o600 });
  const job = await prepareJob({
    mode: 'REAL',
    walletPath,
    patternsPath,
    runtimeDir
  });
  return { job, patternsPath, root, runtimeDir, walletPath };
}

async function waitForState(engine, expectedState, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = engine.getStatus();
    if (status.state === expectedState) return status;
    if (status.state === 'failed') {
      throw new Error(`Recovery failed while waiting for ${expectedState}: ${status.errorCode}`);
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for recovery state ${expectedState}; current state ${engine.state}`);
}

function assertStateError(code = 'INVALID_STATE_TRANSITION') {
  return (error) => {
    assert.ok(error instanceof RecoveryStateError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 409);
    return true;
  };
}

class FakeWorker {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.terminated = false;
  }

  postMessage(message) {
    this.messages.push(structuredClone(message));
  }

  removeAllListeners() {}

  async terminate() {
    this.terminated = true;
    return 0;
  }
}

function installFakeWorkers(engine, count = 2) {
  const workers = Array.from({ length: count }, (_, index) => new FakeWorker(`worker-${index}`));
  engine._spawnWorkers = function spawnFakeWorkers() {
    if (!this.workers.length) this.workers.push(...workers);
  };
  return workers;
}

test('a real worker deterministically finds the known password at unique index zero', async (t) => {
  const { job } = await makeJob(t, ['Alpha1!', 'wrong-password']);
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  t.after(() => engine.shutdown());

  const started = await engine.start();
  assert.equal(started.state, 'running');
  const found = await waitForState(engine, 'found');

  assert.equal(found.matchFound, true);
  assert.equal(found.nextCandidateIndex, 0);
  assert.equal(found.totalVerified, 1);
  assert.equal(found.activeWorkers, 0);
  assert.equal(found.errorCode, null);
  assert.equal(engine.matchedUniqueIndex, 0);

  const checkpoint = loadCheckpoint(job.paths.checkpointPath, job.jobId);
  assert.equal(checkpoint.state, 'found');
  assert.equal(checkpoint.matchedUniqueIndex, 0);
  assert.doesNotMatch(fs.readFileSync(job.paths.checkpointPath, 'utf8'), /Alpha1!/);
});

test('a real worker reaches exhausted only after every unique candidate is contiguous', async (t) => {
  const { job } = await makeJob(t, ['wrong-0', 'wrong-1', 'wrong-2']);
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  t.after(() => engine.shutdown());

  await engine.start();
  const exhausted = await waitForState(engine, 'exhausted');

  assert.equal(exhausted.matchFound, false);
  assert.equal(exhausted.nextCandidateIndex, 3);
  assert.equal(exhausted.totalVerified, 3);
  assert.equal(exhausted.completionPercent, 100);
  assert.equal(exhausted.activeWorkers, 0);
  const checkpoint = loadCheckpoint(job.paths.checkpointPath, job.jobId);
  assert.equal(checkpoint.state, 'exhausted');
  assert.equal(checkpoint.nextCandidateIndex, 3);

  await assert.rejects(engine.start(), assertStateError());
  await assert.rejects(engine.resume(), assertStateError());
  await assert.rejects(engine.stop(), assertStateError());
});

test('an unexpected verifier worker exit durably fails and clears the pool', async (t) => {
  const candidates = Array.from({ length: 2_000 }, (_, index) => `worker-failure-${index}`);
  const { job } = await makeJob(t, candidates);
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  t.after(() => engine.shutdown());

  await engine.start();
  assert.equal(engine.workers.length, 1);
  await engine.workers[0].terminate();
  const failed = await waitForState(engine, 'failed');

  assert.equal(failed.errorCode, 'WORKER_EXITED');
  assert.equal(failed.activeWorkers, 0);
  assert.equal(engine.workers.length, 0);
  const checkpoint = loadCheckpoint(job.paths.checkpointPath, job.jobId);
  assert.equal(checkpoint.state, 'failed');
  assert.equal(checkpoint.errorCode, 'WORKER_EXITED');
});

test('a post-rename found-checkpoint error never overwrites the recovered index', async (t) => {
  const { job } = await makeJob(t, ['Alpha1!', 'wrong-password']);
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  const [worker] = installFakeWorkers(engine, 1);
  t.after(() => engine.shutdown());

  await engine.start();
  const originalChmod = fs.chmodSync;
  let injected = false;
  fs.chmodSync = function failAfterFoundRename(filePath, mode) {
    if (!injected && path.resolve(filePath) === path.resolve(job.paths.checkpointPath)) {
      injected = true;
      throw new Error('injected post-rename failure');
    }
    return originalChmod.call(this, filePath, mode);
  };
  try {
    engine._onWorkerMessage(worker, { type: 'result', index: 0, matched: true });
    await waitForState(engine, 'found');
  } finally {
    fs.chmodSync = originalChmod;
  }

  assert.equal(injected, true);
  const checkpoint = loadCheckpoint(job.paths.checkpointPath, job.jobId);
  assert.equal(checkpoint.state, 'found');
  assert.equal(checkpoint.matchedUniqueIndex, 0);
  assert.equal(engine.matchedUniqueIndex, 0);
  assert.equal(engine.errorCode, null);
});

test('pause, resume, and stop acknowledge only after durable state transitions', async (t) => {
  const candidates = Array.from({ length: 200 }, (_, index) => `definitely-wrong-${index}`);
  const { job } = await makeJob(t, candidates);
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  t.after(() => engine.shutdown());

  await assert.rejects(engine.pause(), assertStateError());
  await assert.rejects(engine.resume(), assertStateError());
  await assert.rejects(engine.stop(), assertStateError());

  await engine.start();
  const paused = await engine.pause();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.activeWorkers, 0);
  assert.equal(loadCheckpoint(job.paths.checkpointPath, job.jobId).state, 'paused');
  await assert.rejects(engine.start(), assertStateError());

  const resumed = await engine.resume();
  assert.equal(resumed.state, 'running');
  const stopped = await engine.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.activeWorkers, 0);
  assert.equal(loadCheckpoint(job.paths.checkpointPath, job.jobId).state, 'stopped');
  await assert.rejects(engine.resume(), assertStateError());
  await assert.rejects(engine.stop(), assertStateError());
});

test('constructing from a durable running checkpoint converts it to interrupted', async (t) => {
  const inputs = await makeJob(t, ['wrong-0', 'wrong-1']);
  const now = Date.now();
  saveCheckpoint(inputs.job.paths.checkpointPath, {
    ...inputs.job.checkpoint,
    state: 'running',
    startedAt: now - 100,
    lastCheckpointAt: now
  });

  const restartedJob = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });
  assert.equal(restartedJob.checkpoint.state, 'running');
  const engine = new RecoveryEngine(restartedJob, { workerSetting: '1' });
  t.after(() => engine.shutdown());

  assert.equal(engine.getStatus().state, 'interrupted');
  const checkpoint = loadCheckpoint(restartedJob.paths.checkpointPath, restartedJob.jobId);
  assert.equal(checkpoint.state, 'interrupted');
  assert.equal(checkpoint.nextCandidateIndex, 0);
});

test('out-of-order work advances the contiguous frontier and crash replay reuses recorded results', async (t) => {
  const inputs = await makeJob(t, ['wrong-0', 'wrong-1', 'wrong-2', 'wrong-3']);
  const firstEngine = new RecoveryEngine(inputs.job, { workerSetting: '2' });
  const firstWorkers = installFakeWorkers(firstEngine);

  await firstEngine.start();
  assert.deepEqual(firstWorkers.map((worker) => worker.messages[0].index), [0, 1]);
  firstEngine._onWorkerMessage(firstWorkers[1], { type: 'result', index: 1, matched: false });
  assert.equal(firstEngine.nextCandidateIndex, 0);
  assert.deepEqual(firstWorkers[1].messages.map(({ index }) => index), [1, 2]);

  await firstEngine.shutdown();
  const crashCheckpoint = loadCheckpoint(inputs.job.paths.checkpointPath, inputs.job.jobId);
  assert.equal(crashCheckpoint.state, 'interrupted');
  assert.equal(crashCheckpoint.nextCandidateIndex, 0);
  assert.equal(crashCheckpoint.totalVerified, 1);

  const replayJob = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });
  const replayEngine = new RecoveryEngine(replayJob, { workerSetting: '2' });
  const replayWorkers = installFakeWorkers(replayEngine);
  t.after(() => replayEngine.shutdown());
  await replayEngine.resume();

  assert.deepEqual(replayWorkers.map((worker) => worker.messages[0].index), [0, 2]);
  assert.equal(replayEngine.getStatus().reusedCandidateCount, 1);
  replayEngine._onWorkerMessage(replayWorkers[1], { type: 'result', index: 2, matched: false });
  assert.equal(replayEngine.nextCandidateIndex, 0);
  replayEngine._onWorkerMessage(replayWorkers[0], { type: 'result', index: 0, matched: false });
  assert.equal(replayEngine.nextCandidateIndex, 3);
  assert.deepEqual(
    replayWorkers.flatMap((worker) => worker.messages.map(({ index }) => index)).sort((a, b) => a - b),
    [0, 2, 3]
  );

  const stopped = await replayEngine.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(loadCheckpoint(replayJob.paths.checkpointPath, replayJob.jobId).nextCandidateIndex, 3);
});

test('live status separates checked attempts from restart-safe coverage and estimates from current speed', async (t) => {
  const { job } = await makeJob(t, ['wrong-0', 'wrong-1', 'wrong-2', 'wrong-3']);
  const engine = new RecoveryEngine(job, { workerSetting: '2' });
  const workers = installFakeWorkers(engine);
  t.after(() => engine.shutdown());
  engine.benchmark = { guessesPerSecond: 10 };

  const ready = engine.getStatus();
  assert.equal(ready.remainingCandidateCount, 4);
  assert.equal(ready.estimateSource, 'benchmark');
  assert.equal(ready.estimatedSecondsRemaining, 0.4);
  await engine.start();
  engine.segmentStartedAt = performance.now() - 1000;
  engine._onWorkerMessage(workers[1], { type: 'result', index: 1, matched: false });
  const outOfOrder = engine.getStatus();
  assert.equal(outOfOrder.totalVerified, 1);
  assert.equal(outOfOrder.searchedCandidateCount, 0);
  assert.equal(outOfOrder.uncommittedVerifiedCount, 1);
  assert.equal(outOfOrder.remainingCandidateCount, 4);
  assert.equal(outOfOrder.estimateSource, 'live');
  assert.ok(outOfOrder.estimateRate > 0 && outOfOrder.estimateRate <= 1);
  assert.equal(outOfOrder.estimatedTotalSeconds,
    outOfOrder.activeElapsedMs / 1000 + outOfOrder.estimatedSecondsRemaining);

  engine._onWorkerMessage(workers[0], { type: 'result', index: 0, matched: false });
  const contiguous = engine.getStatus();
  assert.equal(contiguous.searchedCandidateCount, 2);
  assert.equal(contiguous.remainingCandidateCount, 2);
  assert.equal(contiguous.completionPercent, 50);
  assert.equal(contiguous.uncommittedVerifiedCount, 0);
  const paused = await engine.pause();
  assert.equal(paused.guessesPerSecond, 0);
  assert.equal(paused.estimateSource, 'average');
  assert.ok(paused.estimatedSecondsRemaining > 0);
});

test('a stalled search does not replace zero observed speed with an optimistic benchmark ETA', async (t) => {
  const { job } = await makeJob(t, ['wrong-0', 'wrong-1']);
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  installFakeWorkers(engine, 1);
  t.after(() => engine.shutdown());
  engine.benchmark = { guessesPerSecond: 500 };
  await engine.start();
  engine.segmentStartedAt = performance.now() - 31_000;
  const stalled = engine.getStatus();
  assert.equal(stalled.guessesPerSecond, 0);
  assert.equal(stalled.estimateSource, 'live');
  assert.equal(stalled.estimateRate, 0);
  assert.equal(stalled.estimatedSecondsRemaining, null);
  assert.equal(stalled.estimatedTotalSeconds, null);
});

test('active runtime uses a monotonic clock and excludes paused time', async (t) => {
  const { job } = await makeJob(t, ['wrong-0', 'wrong-1']);
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  installFakeWorkers(engine, 1);
  t.after(() => engine.shutdown());
  await engine.start();
  engine.segmentStartedAt = performance.now() - 1000;
  const originalNow = Date.now;
  Date.now = () => originalNow() + 86_400_000;
  try {
    const status = engine.getStatus();
    assert.ok(status.activeElapsedMs >= 1000 && status.activeElapsedMs < 2000);
  } finally {
    Date.now = originalNow;
  }
  const paused = await engine.pause();
  await delay(20);
  assert.equal(engine.getStatus().activeElapsedMs, paused.activeElapsedMs);
});

test('a found candidate beyond the frontier does not claim untested candidates were searched', async (t) => {
  const { job } = await makeJob(t, ['wrong-0', 'Alpha1!', 'wrong-2', 'wrong-3']);
  const engine = new RecoveryEngine(job, { workerSetting: '2' });
  const workers = installFakeWorkers(engine);
  t.after(() => engine.shutdown());
  await engine.start();
  engine._onWorkerMessage(workers[1], { type: 'result', index: 1, matched: true });
  const found = await waitForState(engine, 'found');
  assert.equal(found.totalVerified, 1);
  assert.equal(found.searchedCandidateCount, 1);
  assert.equal(found.remainingCandidateCount, 3);
  assert.equal(found.completionPercent, 25);
  assert.equal(found.estimatedSecondsRemaining, 0);
});

async function siblingJob(inputs, candidates, options = {}) {
  return prepareJob({
    mode: 'REAL', walletPath: inputs.walletPath, runtimeDir: inputs.runtimeDir,
    config: candidateConfig(candidates), ...options
  });
}

test('overlapping jobs reuse exact candidates despite different indexes and filters', async (t) => {
  const inputs = await makeJob(t, ['wrong-a', 'wrong-b']);
  const first = new RecoveryEngine(inputs.job, { workerSetting: '1' });
  await first.start();
  await waitForState(first, 'exhausted');
  await first.shutdown();

  const nextJob = await siblingJob(inputs, ['wrong-b', 'wrong-c', 'wrong-a']);
  const second = new RecoveryEngine(nextJob, { workerSetting: '1' });
  t.after(() => second.shutdown());
  await second.start();
  const status = await waitForState(second, 'exhausted');
  assert.notEqual(nextJob.jobId, inputs.job.jobId);
  assert.equal(status.totalVerified, 1);
  assert.equal(status.reusedCandidateCount, 2);
  assert.equal(status.searchedCandidateCount, 3);
  const restored = await siblingJob(inputs, ['wrong-b', 'wrong-c', 'wrong-a']);
  assert.equal(restored.checkpoint.reusedCandidateCount, 2);
});

test('concurrent jobs wait for shared candidate verification instead of testing it twice', async (t) => {
  const inputs = await makeJob(t, ['wrong-a', 'wrong-b']);
  const sibling = await siblingJob(inputs, ['wrong-a', 'wrong-c']);
  const first = new RecoveryEngine(inputs.job, { workerSetting: '1' });
  const second = new RecoveryEngine(sibling, { workerSetting: '1' });
  const [workerA] = installFakeWorkers(first, 1);
  const [workerB] = installFakeWorkers(second, 1);
  t.after(async () => { await first.shutdown(); await second.shutdown(); });
  await first.start();
  await second.start();
  assert.equal(workerA.messages.length, 1);
  assert.equal(workerB.messages.length, 0);
  assert.equal(second.nextCandidateIndex, 0);
  first._onWorkerMessage(workerA, { type: 'result', index: 0, matched: false });
  second._schedule();
  assert.deepEqual(workerB.messages.map(({ index }) => index), [1]);
  assert.equal(second.getStatus().reusedCandidateCount, 1);
  second._onWorkerMessage(workerB, { type: 'result', index: 1, matched: false });
  assert.equal(second.state, 'exhausted');
  assert.equal(second.totalVerified, 1);
});

test('a stored match is reused across jobs and still independently confirmed', async (t) => {
  const inputs = await makeJob(t, ['Alpha1!']);
  const first = new RecoveryEngine(inputs.job, { workerSetting: '1' });
  await first.start();
  await waitForState(first, 'found');
  await first.shutdown();
  const nextJob = await siblingJob(inputs, ['wrong-a', 'Alpha1!']);
  const second = new RecoveryEngine(nextJob, { workerSetting: '1' });
  t.after(() => second.shutdown());
  await second.start();
  const found = await waitForState(second, 'found');
  assert.equal(found.reusedCandidateCount, 1);
  assert.equal(found.totalVerified, 1);
  assert.equal(second.matchedUniqueIndex, 1);
  assert.equal(loadCheckpoint(nextJob.paths.checkpointPath, nextJob.jobId).state, 'found');
});

test('archived pre-ledger checkpoints migrate only proven contiguous coverage', async (t) => {
  const inputs = await makeJob(t, ['wrong-a', 'wrong-b', 'wrong-c']);
  saveCheckpoint(inputs.job.paths.checkpointPath, {
    ...inputs.job.checkpoint, state: 'paused', nextCandidateIndex: 1,
    totalVerified: 2, startedAt: Date.now(), lastCheckpointAt: Date.now()
  });
  await siblingJob(inputs, ['wrong-a', 'wrong-b', 'wrong-c'], { fresh: true });
  const nextJob = await siblingJob(inputs, ['wrong-a', 'wrong-c']);
  const engine = new RecoveryEngine(nextJob, { workerSetting: '1' });
  const [worker] = installFakeWorkers(engine, 1);
  t.after(() => engine.shutdown());
  await engine.start();
  assert.equal(engine.getStatus().historyImport.importedCandidateCount, 1);
  assert.equal(engine.getStatus().reusedCandidateCount, 1);
  assert.deepEqual(worker.messages.map(({ index }) => index), [1]);
  engine._onWorkerMessage(worker, { type: 'result', index: 1, matched: false });
  assert.equal(engine.state, 'exhausted');
});

test('ledger commit failure stops the job before it advances coverage', async (t) => {
  const { job } = await makeJob(t, ['wrong-a']);
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  const [worker] = installFakeWorkers(engine, 1);
  t.after(() => engine.shutdown());
  await engine.start();
  engine.ledger.complete = () => { throw new Error('injected'); };
  engine._onWorkerMessage(worker, { type: 'result', index: 0, matched: false });
  assert.equal(engine.state, 'failed');
  assert.equal(engine.errorCode, 'SEARCH_HISTORY_WRITE_FAILED');
  assert.equal(engine.nextCandidateIndex, 0);
  assert.equal(loadCheckpoint(job.paths.checkpointPath, job.jobId).nextCandidateIndex, 0);
});

test('shutdown during migration retains its partial cursor and resumes the remaining history', async (t) => {
  const inputs = await makeJob(t, Array.from({ length: 1000 }, (_, index) => `wrong-${index}`));
  saveCheckpoint(inputs.job.paths.checkpointPath, {
    ...inputs.job.checkpoint, state: 'paused', nextCandidateIndex: 1000,
    totalVerified: 1000, startedAt: Date.now(), lastCheckpointAt: Date.now()
  });
  const oldJob = await siblingJob(inputs, Array.from({ length: 1000 }, (_, index) => `wrong-${index}`));
  const engine = new RecoveryEngine(oldJob, { workerSetting: '1' });
  const initialization = assert.rejects(engine.initialize(), /SHUTDOWN_IN_PROGRESS/);
  await engine.shutdown();
  await initialization;
  assert.equal(engine.historyImported, false);
  assert.equal(engine.historyImport.completed, false);
  const replacement = new RecoveryEngine(oldJob, { workerSetting: '1' });
  t.after(() => replacement.shutdown());
  assert.equal(replacement.ledger.importedThrough(oldJob.jobId), 512);
  await replacement._ensureHistoryImported();
  assert.equal(replacement.ledger.importedThrough(oldJob.jobId), 1000);
  assert.equal(replacement.historyImport.importedCandidateCount, 488);
  assert.equal(replacement.historyImported, true);
});

test('inconsistent archived checkpoints never import false coverage over a recorded match', async (t) => {
  const inputs = await makeJob(t, ['wrong-a', 'wrong-b']);
  saveCheckpoint(inputs.job.paths.checkpointPath, {
    ...inputs.job.checkpoint, state: 'exhausted', nextCandidateIndex: 2,
    totalVerified: 2, startedAt: Date.now(), lastCheckpointAt: Date.now()
  });
  saveCheckpoint(path.join(inputs.job.paths.jobDir, 'checkpoint.previous.json'), {
    ...inputs.job.checkpoint, state: 'found', matchedUniqueIndex: 0,
    totalVerified: 1, startedAt: Date.now(), lastCheckpointAt: Date.now()
  });
  const nextJob = await siblingJob(inputs, ['wrong-a', 'wrong-c']);
  const engine = new RecoveryEngine(nextJob, { workerSetting: '1' });
  const [worker] = installFakeWorkers(engine, 1);
  t.after(() => engine.shutdown());
  await engine.start();
  assert.equal(engine.historyImport.skippedJobCount, 1);
  assert.equal(engine.historyImport.importedCandidateCount, 0);
  assert.equal(engine.reusedCandidateCount, 0);
  assert.deepEqual(worker.messages.map(({ index }) => index), [0]);
});
