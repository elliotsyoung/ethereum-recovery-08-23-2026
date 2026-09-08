const { parentPort, workerData } = require('node:worker_threads');
const { verifyCandidate } = require('./walletVerifier');

try {
  for (const candidate of workerData.warmupCandidates || []) {
    verifyCandidate(workerData.verificationContext, candidate);
  }

  const startedAt = process.hrtime.bigint();
  let badMatches = 0;
  for (const candidate of workerData.candidates || []) {
    if (verifyCandidate(workerData.verificationContext, candidate)) {
      badMatches += 1;
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  parentPort.postMessage({
    type: 'complete',
    checks: (workerData.candidates || []).length,
    badMatches,
    elapsedMs
  });
} catch {
  parentPort.postMessage({ type: 'error', errorCode: 'BENCHMARK_WORKER_FAILED' });
}
