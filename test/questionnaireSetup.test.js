const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SetupController } = require('../server/setupController');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-questionnaire-'));
  const walletPath = path.join(root, 'wallet.json');
  fs.copyFileSync(path.join(__dirname, 'fixtures/low-cost-v3.json'), walletPath);
  fs.chmodSync(walletPath, 0o600);
  const controller = new SetupController({ runtimeDir: path.join(root, 'runtime'), workerSetting: '1' });
  t.after(async () => {
    await controller.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { controller, walletPath };
}

test('unknown questionnaire previews exact huge space with no wallet, inferred filters or disk writes', (t) => {
  const { controller } = fixture(t);
  const input = { mode: 'REAL', walletPath: '', rules: { searchMode: 'mask', masks: [], minLength: 11, maxLength: 12 } };
  const original = structuredClone(input);
  const preview = controller.preview(input);
  assert.equal(preview.candidateCountExact, (95n ** 11n + 95n ** 12n).toString());
  assert.equal(preview.runnable, false);
  assert.equal(preview.uniqueCandidateCount, null);
  assert.equal(preview.estimate.source, 'illustrative');
  assert.equal(preview.estimate.seconds, null);
  assert.equal(preview.estimate.scenarios.length, 3);
  assert.ok(preview.questions.some((question) => question.id === 'positions'));
  assert.ok(preview.questions.some((question) => question.id === 'length'));
  assert.ok(preview.coverage.some((line) => /Rhyming and correct spelling are not assumed/.test(line)));
  assert.deepEqual(input, original);
  assert.equal(fs.existsSync(controller.runtimeDir), false);
});

test('questionnaire requires deliberate coverage review and never clamps an oversized search', async (t) => {
  const { controller, walletPath } = fixture(t);
  const input = { mode: 'REAL', walletPath, rules: { searchMode: 'mask', masks: ['MisSpellt??!?d'], minLength: 12, maxLength: 12 } };
  assert.equal(controller.preview(input).uniqueCandidateCount, 10);
  await assert.rejects(controller.configure(input), { code: 'COVERAGE_REVIEW_REQUIRED' });
  assert.equal(controller.job, null);
  const huge = { ...input, coverageAcknowledged: true, rules: { searchMode: 'mask', masks: [], minLength: 11, maxLength: 64 } };
  await assert.rejects(controller.configure(huge), { code: 'SEARCH_TOO_LARGE' });
  assert.equal(controller.job, null);
  assert.equal(fs.existsSync(controller.runtimeDir), false);
  await assert.rejects(controller.configure({ ...input, coverageAcknowledged: true, rules: { ...input.rules, minLength: 10 } }), { code: 'RULES_INVALID' });
});

test('wallet measurement is available before job creation and invalidated by wallet replacement', async (t) => {
  const { controller, walletPath } = fixture(t);
  const measurement = await controller.measure({ mode: 'REAL', walletPath });
  assert.ok(measurement.guessesPerSecond > 0);
  assert.equal(measurement.selectedWorkerCount, 1);
  assert.equal(controller.job, null);
  assert.equal(fs.existsSync(controller.runtimeDir), false);
  const input = { mode: 'REAL', walletPath, rules: { searchMode: 'mask', masks: ['WrongPhrase?d'], minLength: 12, maxLength: 12 } };
  const preview = controller.preview(input);
  assert.equal(preview.estimate.source, 'measured');
  assert.equal(preview.estimate.seconds, 10 / measurement.guessesPerSecond);
  assert.equal(preview.estimate.includesReuse, false);
  assert.equal(controller.preview({ ...input, walletPath: path.join(path.dirname(walletPath), 'other.json') }).estimate.source, 'illustrative');
  const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  wallet.id = '00000000-0000-4000-8000-000000000000';
  fs.writeFileSync(walletPath, JSON.stringify(wallet));
  assert.equal(controller.preview(input).estimate.source, 'illustrative');
});

test('v3 configuration prepares, restores identical indexes, and reuses pre-job calibration', async (t) => {
  const { controller, walletPath } = fixture(t);
  const measurement = await controller.measure({ mode: 'REAL', walletPath });
  const input = { mode: 'REAL', walletPath, coverageAcknowledged: true,
    rules: { searchMode: 'mask', masks: ['WrongPhrase?d'], minLength: 12, maxLength: 12 } };
  const ready = await controller.configure(input);
  assert.equal(ready.uniqueCandidateCount, 10);
  assert.equal(ready.benchmark.guessesPerSecond, measurement.guessesPerSecond);
  assert.deepEqual(controller.currentSetup().rules, input.rules);
  const restored = await controller.restore();
  assert.equal(restored.jobId, ready.jobId);
  assert.equal(restored.uniqueCandidateCount, 10);
  assert.equal(restored.state, 'ready');
});
