const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const {
  MEMORY_HEADROOM_BYTES,
  allowedWorkerCounts,
  benchmarkWidth,
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

test('benchmark workers wait after warmup for the shared timing barrier', async (t) => {
  const worker = new Worker(path.resolve(__dirname, '../server/recovery/benchmarkWorker.js'), {
    workerData: {
      verificationContext: fixtureContext(),
      warmupCandidates: ['wrong-warmup'],
      candidates: ['wrong-measurement']
    }
  });
  t.after(() => worker.terminate());
  const messages = [];
  worker.on('message', (message) => messages.push(message));
  const [ready] = await once(worker, 'message');
  assert.deepEqual(ready, { type: 'ready' });
  await delay(20);
  assert.equal(messages.length, 1);
  worker.postMessage({ type: 'start' });
  const [complete] = await once(worker, 'message');
  assert.deepEqual(complete, { type: 'complete', checks: 1, badMatches: 0 });
  const [code] = await once(worker, 'exit');
  assert.equal(code, 0);
});

test('benchmark rejects invalid widths before creating a worker pool', async () => {
  await assert.rejects(benchmarkWidth(fixtureContext(), 0), /BENCHMARK_OPTIONS_INVALID/);
  await assert.rejects(benchmarkWidth(fixtureContext(), 5), /BENCHMARK_OPTIONS_INVALID/);
});
