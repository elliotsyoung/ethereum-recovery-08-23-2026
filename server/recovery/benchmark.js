const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { calculateScryptMemoryBytes } = require('./walletVerifier');

const WORKER_CHOICES = [1, 2, 4];
const BENCHMARK_VERSION = 2;
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

function benchmarkWidth(verificationContext, workerCount, checksPerWorker = 3) {
  if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > 4
      || !Number.isSafeInteger(checksPerWorker) || checksPerWorker < 1) {
    return Promise.reject(new Error('BENCHMARK_OPTIONS_INVALID'));
  }
  const workerPath = path.resolve(__dirname, 'benchmarkWorker.js');
  return new Promise((resolve, reject) => {
    const workers = [];
    const ready = new Set();
    const completions = new Map();
    const exited = new Set();
    let startedAt = null;
    let completedAt = null;
    let settled = false;
    const fail = (code = 'BENCHMARK_WORKER_FAILED') => {
      if (settled) return;
      settled = true;
      // Do not start the next width while failed siblings still consume KDF
      // memory or CPU. Every width owns the complete worker lifecycle.
      Promise.allSettled(workers.map((worker) => worker.terminate()))
        .then(() => reject(new Error(code)));
    };
    try {
      for (let index = 0; index < workerCount; index += 1) {
        const worker = new Worker(workerPath, {
          workerData: {
            verificationContext,
            warmupCandidates: [randomCandidate()],
            candidates: Array.from({ length: checksPerWorker }, randomCandidate)
          }
        });
        workers.push(worker);
        worker.on('message', (message) => {
          if (settled) return;
          if (message?.type === 'ready' && !ready.has(worker) && startedAt === null) {
            ready.add(worker);
            if (ready.size === workerCount) {
              startedAt = performance.now();
              try {
                for (const participant of workers) participant.postMessage({ type: 'start' });
              } catch {
                fail();
              }
            }
          } else if (message?.type === 'complete' && startedAt !== null
              && !completions.has(worker) && message.checks === checksPerWorker
              && Number.isSafeInteger(message.badMatches) && message.badMatches >= 0) {
            completions.set(worker, message);
            completedAt = performance.now();
          } else {
            fail();
          }
        });
        worker.once('error', () => fail());
        worker.once('exit', (code) => {
          if (settled) return;
          if (code !== 0 || !completions.has(worker)) return fail();
          exited.add(worker);
          if (exited.size !== workerCount) return;
          if ([...completions.values()].some((result) => result.badMatches !== 0)) {
            return fail('BENCHMARK_CANDIDATE_MATCHED');
          }
          settled = true;
          const checks = workerCount * checksPerWorker;
          const elapsedMs = Math.max(completedAt - startedAt, 0.001);
          resolve({
            workerCount,
            checks,
            elapsedMs,
            guessesPerSecond: checks / (elapsedMs / 1000),
            msPerGuess: elapsedMs / checks
          });
        });
      }
    } catch {
      fail();
    }
  });
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
  BENCHMARK_VERSION,
  MEMORY_HEADROOM_BYTES,
  WORKER_CHOICES,
  allowedWorkerCounts,
  benchmarkWidth,
  estimatedMemoryPerWorker,
  runBenchmark
};
