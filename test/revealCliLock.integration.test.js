const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { parseServerOptions, startServer } = require('../server/index');
const {
  loadStoredJob,
  prepareJob,
  releaseJobLock
} = require('../server/recovery/jobStore');
const { RecoveryEngine } = require('../server/recovery/recoveryEngine');
const { parseRevealOptions, revealPassword } = require('../server/reveal');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/low-cost-v3.json');

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ethereum-recovery-reveal-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function candidateConfig(candidates = ['Alpha1!', 'wrong-password']) {
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

function makeInputs(t, candidates) {
  const root = makeTempDirectory(t);
  const runtimeDir = path.join(root, 'runtime');
  const walletPath = path.join(root, 'wallet.json');
  const patternsPath = path.join(root, 'patterns.json');
  fs.copyFileSync(FIXTURE_PATH, walletPath);
  fs.chmodSync(walletPath, 0o600);
  fs.writeFileSync(patternsPath, `${JSON.stringify(candidateConfig(candidates))}\n`, { mode: 0o600 });
  return { root, runtimeDir, walletPath, patternsPath };
}

async function waitForState(engine, expectedState, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (engine.state === expectedState) return;
    if (engine.state === 'failed') throw new Error(`Recovery failed: ${engine.errorCode}`);
    await delay(10);
  }
  throw new Error(`Timed out waiting for state ${expectedState}; current state ${engine.state}`);
}

async function withTimeout(promise, message, timeoutMs = 10_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('found result survives reload and terminal reveal prints only the reverified password', async (t) => {
  const inputs = makeInputs(t);
  const job = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  await engine.start();
  await waitForState(engine, 'found');
  await engine.shutdown();

  const reloaded = loadStoredJob({ runtimeDir: inputs.runtimeDir, jobId: job.jobId });
  assert.equal(reloaded.checkpoint.state, 'found');
  assert.equal(reloaded.checkpoint.matchedUniqueIndex, 0);
  assert.equal(await revealPassword({
    jobId: job.jobId,
    runtimeDir: inputs.runtimeDir,
    walletPath: inputs.walletPath
  }), 'Alpha1!');

  const result = spawnSync(process.execPath, [
    'server/reveal.js',
    '--job', job.jobId,
    '--runtime-dir', inputs.runtimeDir,
    '--wallet', inputs.walletPath
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'Alpha1!');

  const checkpointText = fs.readFileSync(job.paths.checkpointPath, 'utf8');
  assert.doesNotMatch(checkpointText, /Alpha1!/);
  assert.equal(fs.existsSync(path.join(job.paths.jobDir, 'result.json')), false);
});

test('reveal rejects an exact-wallet fingerprint mismatch even when wallet contents parse', async (t) => {
  const inputs = makeInputs(t);
  const job = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir
  });
  const engine = new RecoveryEngine(job, { workerSetting: '1' });
  await engine.start();
  await waitForState(engine, 'found');
  await engine.shutdown();

  const changedWalletPath = path.join(inputs.root, 'changed-wallet.json');
  fs.writeFileSync(
    changedWalletPath,
    `${fs.readFileSync(inputs.walletPath, 'utf8')}\n`,
    { mode: 0o600 }
  );
  await assert.rejects(
    revealPassword({
      jobId: job.jobId,
      runtimeDir: inputs.runtimeDir,
      walletPath: changedWalletPath
    }),
    /WALLET_FINGERPRINT_MISMATCH/
  );
});

test('server and reveal CLI parsing keep mode fixed at process startup', () => {
  const demo = parseServerOptions(['--workers', '1', '--port', '3001'], 'DEMO');
  assert.equal(demo.mode, 'DEMO');
  assert.equal(demo.walletPath, undefined);
  assert.throws(
    () => parseServerOptions(['--mode', 'REAL'], 'DEMO'),
    /Unknown option|mode/i
  );
  assert.throws(
    () => parseServerOptions(['--wallet', '/tmp/wallet.json'], 'DEMO'),
    /DEMO_EXTERNAL_INPUT_NOT_ALLOWED/
  );
  assert.throws(
    () => parseServerOptions(['--wallet', 'relative-wallet.json'], 'REAL'),
    /REAL_WALLET_ABSOLUTE_PATH_REQUIRED/
  );

  const real = parseServerOptions([
    '--wallet', '/tmp/wallet.json',
    '--patterns', '/tmp/patterns.json',
    '--workers', '4',
    '--fresh'
  ], 'REAL');
  assert.equal(real.mode, 'REAL');
  assert.equal(real.workerSetting, '4');
  assert.equal(real.fresh, true);

  assert.deepEqual(parseRevealOptions([
    '--job', 'a'.repeat(64),
    '--wallet', '/tmp/wallet.json',
    '--runtime-dir', '/tmp/runtime'
  ]), {
    jobId: 'a'.repeat(64),
    walletPath: '/tmp/wallet.json',
    runtimeDir: '/tmp/runtime'
  });
  assert.throws(() => parseRevealOptions([]), /JOB_ID_REQUIRED/);
  assert.throws(
    () => parseRevealOptions(['--job', 'a'.repeat(64), '--wallet', 'relative.json']),
    /REVEAL_WALLET_ABSOLUTE_PATH_REQUIRED/
  );

  const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.match(packageJson.scripts.start, /RECOVERY_MODE=DEMO/);
  assert.match(packageJson.scripts.real, /RECOVERY_MODE=REAL/);
});

test('a live per-job lock rejects a second recovery process and can be reacquired', async (t) => {
  const inputs = makeInputs(t, ['wrong-password']);
  const locked = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir,
    acquireLock: true
  });
  let heldLock = locked.lock;
  t.after(async () => {
    if (heldLock && !heldLock.released) await releaseJobLock(heldLock);
  });
  assert.equal(fs.statSync(locked.paths.lockPath).mode & 0o777, 0o600);

  await assert.rejects(
    prepareJob({
      mode: 'REAL',
      walletPath: inputs.walletPath,
      patternsPath: inputs.patternsPath,
      runtimeDir: inputs.runtimeDir,
      acquireLock: true
    }),
    /JOB_ALREADY_RUNNING/
  );

  await releaseJobLock(heldLock);
  assert.equal(fs.existsSync(locked.paths.lockPath), true);
  const reacquired = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir,
    acquireLock: true
  });
  heldLock = reacquired.lock;
  assert.equal(fs.existsSync(reacquired.paths.lockPath), true);
  await releaseJobLock(heldLock);
  assert.equal(fs.existsSync(reacquired.paths.lockPath), true);
});

test('lock release terminates its detached helper even if the lock path changed', async (t) => {
  const inputs = makeInputs(t, ['wrong-password']);
  const locked = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir,
    acquireLock: true
  });
  fs.renameSync(locked.paths.lockPath, `${locked.paths.lockPath}.changed`);

  await assert.rejects(releaseJobLock(locked.lock), /JOB_LOCK_CHANGED/);
  assert.equal(locked.lock.released, true);
  assert.notEqual(locked.lock.child.exitCode, null);
  assert.equal(locked.lock.child.connected, false);
});

test('the server fails closed if its kernel lock holder exits', async (t) => {
  const candidates = Array.from({ length: 2_000 }, (_, index) => `wrong-${index}`);
  const inputs = makeInputs(t, candidates);
  let lockLossNotifications = 0;
  const runtime = await startServer({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir,
    workerSetting: '1',
    fresh: false,
    port: 0
  }, {
    onLockLost: () => {
      lockLossNotifications += 1;
    }
  });
  t.after(async () => {
    try {
      await runtime.shutdown();
    } catch {
      // This test deliberately destroys the owned lock.
    }
  });

  await runtime.engine.start();
  const durableCheckpoint = fs.readFileSync(runtime.job.paths.checkpointPath, 'utf8');
  assert.equal(JSON.parse(durableCheckpoint).state, 'running');
  const closed = once(runtime.server, 'close');
  assert.equal(runtime.job.lock.child.kill('SIGKILL'), true);
  await withTimeout(closed, 'Timed out waiting for lock-loss shutdown', 5_000);

  assert.equal(lockLossNotifications, 1);
  assert.equal(runtime.job.lock.lost, true);
  assert.equal(runtime.engine.shuttingDown, true);
  assert.equal(runtime.server.listening, false);
  assert.notEqual(runtime.engine.state, 'running');
  await assert.rejects(runtime.shutdown(), /JOB_LOCK_LOST/);
  assert.equal(fs.readFileSync(runtime.job.paths.checkpointPath, 'utf8'), durableCheckpoint);

  const reacquired = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir,
    acquireLock: true
  });
  assert.equal(reacquired.checkpoint.state, 'running');
  const restartedEngine = new RecoveryEngine(reacquired, { workerSetting: '1' });
  assert.equal(restartedEngine.state, 'interrupted');
  assert.equal(loadStoredJob({
    runtimeDir: inputs.runtimeDir,
    jobId: reacquired.jobId
  }).checkpoint.state, 'interrupted');
  await restartedEngine.shutdown();
  await releaseJobLock(reacquired.lock);
});

test('foreground SIGINT checkpoints before releasing the detached kernel lock', async (t) => {
  const candidates = Array.from({ length: 2_000 }, (_, index) => `signal-wrong-${index}`);
  const inputs = makeInputs(t, candidates);
  const port = await reservePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [
    'server/index.js',
    '--wallet', inputs.walletPath,
    '--patterns', inputs.patternsPath,
    '--runtime-dir', inputs.runtimeDir,
    '--workers', '1',
    '--port', String(port)
  ], {
    cwd: PROJECT_ROOT,
    detached: true,
    env: { ...process.env, RECOVERY_MODE: 'REAL' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The child may have exited between the check and cleanup.
      }
    }
  });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  await withTimeout(new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      reject(new Error(`Server exited before ready (${code ?? signal})`));
    };
    const inspect = () => {
      if (stdout.includes('Dashboard:')) {
        child.stdout.off('data', inspect);
        child.off('exit', onExit);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.once('exit', onExit);
  }), 'Timed out waiting for server startup');

  const origin = `http://127.0.0.1:${port}`;
  const sessionResponse = await fetch(`${origin}/api/session`);
  assert.equal(sessionResponse.status, 200);
  const { token } = await sessionResponse.json();
  const startResponse = await fetch(`${origin}/api/recovery/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-recovery-session': token
    },
    body: '{}'
  });
  assert.equal(startResponse.status, 200);
  assert.equal((await startResponse.json()).status.state, 'running');

  const exited = once(child, 'exit');
  process.kill(-child.pid, 'SIGINT');
  const [code, signal] = await withTimeout(exited, 'Timed out waiting for graceful SIGINT');
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stderr, '');
  assert.doesNotMatch(stdout, /JOB_LOCK_LOST/);

  const jobId = stdout.match(/^Job: ([a-f0-9]{64})$/m)?.[1];
  assert.ok(jobId);
  const stored = loadStoredJob({ runtimeDir: inputs.runtimeDir, jobId });
  assert.equal(stored.checkpoint.state, 'interrupted');

  const reacquired = await prepareJob({
    mode: 'REAL',
    walletPath: inputs.walletPath,
    patternsPath: inputs.patternsPath,
    runtimeDir: inputs.runtimeDir,
    acquireLock: true
  });
  await releaseJobLock(reacquired.lock);
});
