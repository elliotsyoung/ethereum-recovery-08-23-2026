const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { calculateScryptMemoryBytes } = require('./walletVerifier');

const WORKER_CHOICES = [1, 2, 4];
const MEMORY_HEADROOM_BYTES = 64 * 1024 * 1024;

function estimatedMemoryPerWorker(verificationContext) {
  const scryptBytes = calculateScryptMemoryBytes(verificationContext);
  if (!Number.isSafeInteger(scryptBytes)
      || scryptBytes <= 0
      || scryptBytes > Number.MAX_SAFE_INTEGER - MEMORY_HEADROOM_BYTES) {
    throw new Error('BENCHMARK_MEMORY_ESTIMATE_INVALID');
  }
  return scryptBytes + MEMORY_HEADROOM_BYTES;
}

function allowedWorkerCounts(verificationContext, requestedCounts = WORKER_CHOICES) {
  const perWorker = estimatedMemoryPerWorker(verificationContext);
  const budget = Math.floor(os.totalmem() * 0.5);
  const allowed = requestedCounts.filter((count) => (
    Number.isSafeInteger(count)
      && count >= 1
      && count <= 4
      && count * perWorker <= budget
  ));
  if (!allowed.length) {
    throw new Error('INSUFFICIENT_MEMORY_FOR_SCRYPT');
  }
  return { allowed, budget, perWorker };
}

function randomCandidate() {
  return `benchmark-${crypto.randomBytes(32).toString('base64url')}`;
}

function runWorker(verificationContext, candidates) {
  const workerPath = path.resolve(__dirname, 'benchmarkWorker.js');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        verificationContext,
        warmupCandidates: [randomCandidate()],
        candidates
      }
    });
    let settled = false;
    let completion = null;
    const fail = () => {
      if (settled) return;
      settled = true;
      Promise.resolve(worker.terminate())
        .catch(() => undefined)
        .finally(() => reject(new Error('BENCHMARK_WORKER_FAILED')));
    };
    worker.once('message', (message) => {
      if (message?.type === 'complete') {
        completion = message;
      } else {
        fail();
      }
    });
    worker.once('error', fail);
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 && completion) {
        resolve(completion);
      } else {
        reject(new Error('BENCHMARK_WORKER_FAILED'));
      }
    });
  });
}

async function benchmarkWidth(verificationContext, workerCount, checksPerWorker = 3) {
  const jobs = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    jobs.push(runWorker(
      verificationContext,
      Array.from({ length: checksPerWorker }, randomCandidate)
    ));
  }
  const results = await Promise.all(jobs);
  const checks = results.reduce((sum, result) => sum + result.checks, 0);
  const elapsedMs = Math.max(...results.map((result) => result.elapsedMs));
  const badMatches = results.reduce((sum, result) => sum + result.badMatches, 0);
  if (badMatches !== 0) {
    throw new Error('BENCHMARK_CANDIDATE_MATCHED');
  }
  return {
    workerCount,
    checks,
    elapsedMs,
    guessesPerSecond: checks / (elapsedMs / 1000),
    msPerGuess: elapsedMs / checks
  };
}

async function runBenchmark({ verificationContext, workerCounts = WORKER_CHOICES } = {}) {
  if (!verificationContext) {
    throw new Error('BENCHMARK_CONTEXT_REQUIRED');
  }
  const memory = allowedWorkerCounts(verificationContext, workerCounts);
  const measurements = [];
  for (const workerCount of memory.allowed) {
    measurements.push(await benchmarkWidth(verificationContext, workerCount));
  }
  const selected = measurements.reduce((best, result) => (
    result.guessesPerSecond > best.guessesPerSecond ? result : best
  ));
  return {
    status: 'ok',
    selectedWorkerCount: selected.workerCount,
    guessesPerSecond: selected.guessesPerSecond,
    guessesPerHour: selected.guessesPerSecond * 3600,
    memoryBudgetBytes: memory.budget,
    estimatedMemoryPerWorkerBytes: memory.perWorker,
    measurements
  };
}

module.exports = {
  MEMORY_HEADROOM_BYTES,
  WORKER_CHOICES,
  allowedWorkerCounts,
  benchmarkWidth,
  estimatedMemoryPerWorker,
  runBenchmark
};
