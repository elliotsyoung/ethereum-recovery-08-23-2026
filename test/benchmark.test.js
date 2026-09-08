const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MEMORY_HEADROOM_BYTES,
  allowedWorkerCounts,
  estimatedMemoryPerWorker,
  runBenchmark
} = require('../server/recovery/benchmark');
const { validateKeystore } = require('../server/recovery/walletVerifier');

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/low-cost-v3.json');

function fixtureContext() {
  return validateKeystore(fs.readFileSync(FIXTURE_PATH, 'utf8')).verificationContext;
}

test('the worker ceiling accounts for the complete scrypt allocation plus headroom', () => {
  const context = fixtureContext();
  const estimate = estimatedMemoryPerWorker(context);
  assert.equal(estimate, (128 * 8 * (1024 + 1 + 2)) + MEMORY_HEADROOM_BYTES);

  const memory = allowedWorkerCounts(context, [1, 2, 4]);
  assert.deepEqual(memory.allowed, [1, 2, 4]);
  assert.equal(memory.perWorker, estimate);
  assert.ok(4 * estimate <= memory.budget);
});

test('benchmark widths run sequentially through clean worker exits and select a measured width', async () => {
  const result = await runBenchmark({
    verificationContext: fixtureContext(),
    workerCounts: [1, 2, 4]
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.measurements.map(({ workerCount }) => workerCount), [1, 2, 4]);
  assert.deepEqual(result.measurements.map(({ checks }) => checks), [3, 6, 12]);
  assert.ok([1, 2, 4].includes(result.selectedWorkerCount));
  assert.ok(result.guessesPerSecond > 0);
  assert.equal(result.guessesPerHour, result.guessesPerSecond * 3600);
});
