const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
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

test('out-of-order work advances only the contiguous frontier and crash replay never skips', async (t) => {
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

  assert.deepEqual(replayWorkers.map((worker) => worker.messages[0].index), [0, 1]);
  replayEngine._onWorkerMessage(replayWorkers[1], { type: 'result', index: 1, matched: false });
  assert.equal(replayEngine.nextCandidateIndex, 0);
  replayEngine._onWorkerMessage(replayWorkers[0], { type: 'result', index: 0, matched: false });
  assert.equal(replayEngine.nextCandidateIndex, 2);
  assert.deepEqual(
    replayWorkers.flatMap((worker) => worker.messages.map(({ index }) => index)).sort((a, b) => a - b),
    [0, 1, 2, 3]
  );

  const stopped = await replayEngine.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(loadCheckpoint(replayJob.paths.checkpointPath, replayJob.jobId).nextCandidateIndex, 2);
});
