const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { SetupController } = require('../server/setupController');
const { ensureDemoWallet } = require('../server/recovery/walletVerifier');
const { loadStoredJob } = require('../server/recovery/jobStore');
const { candidateForUniqueIndex } = require('../server/recovery/candidateGenerator');
const { revealPassword } = require('../server/reveal');

async function waitForFound(controller) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = controller.getStatus();
    if (status.state === 'found') return status;
    if (status.state === 'failed' || status.state === 'exhausted') {
      throw new Error(`Mask recovery ended with ${status.state}: ${status.errorCode}`);
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for a mask recovery match.');
}

test('v3 masks recover a mixed-case nonword password, reuse an overlapping job, and reveal its new index', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethereum-mask-recovery-test-'));
  const runtimeDir = path.join(root, 'runtime');
  const walletPath = path.join(root, 'synthetic-wallet.json');
  const password = 'qZxrr-_8pA!';
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) await controller.shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  await ensureDemoWallet(walletPath, { password, scrypt: { N: 1024, r: 8, p: 1 } });
  const originalWallet = fs.readFileSync(walletPath);
  const createController = () => {
    const controller = new SetupController({ runtimeDir, workerSetting: '1' });
    controllers.push(controller);
    return controller;
  };
  const input = (masks) => ({
    mode: 'REAL', walletPath, coverageAcknowledged: true,
    rules: { searchMode: 'mask', masks, minLength: 11, maxLength: 11 }
  });

  const first = createController();
  const narrow = input(['qZxrr-_?dpA!']);
  const preview = first.preview(narrow);
  assert.equal(preview.candidateCountExact, '10');
  assert.equal(fs.existsSync(runtimeDir), false, 'preview does not create runtime state');
  const ready = await first.configure(narrow);
  assert.equal(first.job.config.schemaVersion, 3);
  assert.equal(ready.uniqueCandidateCount, 10);
  assert.equal(first.job.candidatePlan.rawIndices, null);
  await first.start();
  const found = await waitForFound(first);
  const firstJobId = found.jobId;
  assert.equal(found.totalVerified, 9);
  assert.equal(found.reusedCandidateCount, 0);
  assert.equal(first.engine.matchedUniqueIndex, 8);
  assert.equal(await revealPassword({ runtimeDir, jobId: firstJobId }), password);
  assert.doesNotMatch(JSON.stringify(found), /qZxrr-_8pA!/);
  await first.shutdown();

  // The broad alternative changes the matching candidate's index from 8 to 24.
  // The second alternative overlaps completely and must not add duplicates.
  const second = createController();
  const broad = input(['qZxrr-_?xpA!', 'qZxrr-_?dpA!']);
  assert.equal(second.preview(broad).candidateCountExact, '95');
  const secondReady = await second.configure(broad);
  assert.notEqual(secondReady.jobId, firstJobId);
  await second.start();
  const reused = await waitForFound(second);
  assert.equal(reused.totalVerified, 16, 'only printable characters before 0 require new verification');
  assert.equal(reused.reusedCandidateCount, 9, 'digits 0 through 8, including the match, reuse durable outcomes');
  assert.equal(second.engine.matchedUniqueIndex, 24);
  assert.equal(reused.searchedCandidateCount, 25);
  assert.equal(reused.uniqueCandidateCount, 95);
  assert.doesNotMatch(JSON.stringify(reused), /qZxrr-_8pA!/);
  const stored = loadStoredJob({ runtimeDir, jobId: reused.jobId });
  assert.equal(stored.config.schemaVersion, 3);
  assert.equal(stored.checkpoint.matchedUniqueIndex, 24);
  assert.equal(candidateForUniqueIndex(stored.config, stored.candidatePlan, 24), password);
  assert.doesNotMatch(fs.readFileSync(stored.paths.checkpointPath, 'utf8'), /qZxrr-_8pA!/);

  const terminal = spawnSync(process.execPath, [
    path.resolve(__dirname, '../server/reveal.js'),
    '--job', reused.jobId, '--runtime-dir', runtimeDir
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.equal(terminal.stdout, password);
  await second.shutdown();

  const restored = createController();
  const status = await restored.restore();
  assert.equal(status.state, 'found');
  assert.equal(status.jobId, reused.jobId);
  assert.equal(status.totalVerified, 16);
  assert.equal(status.reusedCandidateCount, 9);
  assert.equal(await revealPassword({ runtimeDir, jobId: status.jobId }), password);
  assert.deepEqual(fs.readFileSync(walletPath), originalWallet, 'synthetic source wallet is unchanged');
});
