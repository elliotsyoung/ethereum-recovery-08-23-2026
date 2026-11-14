const { parentPort, workerData } = require('node:worker_threads');
const { verifyCandidate } = require('./walletVerifier');

try {
  for (const candidate of workerData.warmupCandidates || []) {
    verifyCandidate(workerData.verificationContext, candidate);
  }

  // All workers warm up before the parent starts the shared timed interval.
  // Independent worker stopwatches can overstate throughput when their runs
  // do not overlap, especially for low-cost fixtures and short benchmarks.
  parentPort.postMessage({ type: 'ready' });
  parentPort.once('message', (message) => {
    try {
      if (message?.type !== 'start') throw new Error('Invalid benchmark command');
      let badMatches = 0;
      for (const candidate of workerData.candidates || []) {
        if (verifyCandidate(workerData.verificationContext, candidate)) {
          badMatches += 1;
        }
      }
      parentPort.postMessage({
        type: 'complete',
        checks: (workerData.candidates || []).length,
        badMatches
      });
    } catch {
      parentPort.postMessage({ type: 'error', errorCode: 'BENCHMARK_WORKER_FAILED' });
    }
    parentPort.close();
  });
} catch {
  parentPort.postMessage({ type: 'error', errorCode: 'BENCHMARK_WORKER_FAILED' });
  parentPort.close();
}
