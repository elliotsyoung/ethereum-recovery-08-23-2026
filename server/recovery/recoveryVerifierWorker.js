const { parentPort, workerData } = require('node:worker_threads');
const { createCandidateResolver } = require('./candidateGenerator');
const { createVerificationContext, verifyCandidate } = require('./walletVerifier');

if (!parentPort) {
  throw new Error('recoveryVerifierWorker must run in a worker thread.');
}

const config = workerData && workerData.config;
const rawIndices = workerData && workerData.rawIndices;
const verificationContext = createVerificationContext(workerData && workerData.verificationContext);

if (!config || typeof config !== 'object') {
  throw new Error('Invalid verifier worker configuration.');
}
if (!Array.isArray(rawIndices) && !ArrayBuffer.isView(rawIndices)) {
  throw new Error('Invalid verifier worker index map.');
}
const candidateAtRawIndex = createCandidateResolver(config);

parentPort.on('message', (message) => {
  if (!message || message.type !== 'verify') {
    return;
  }

  const index = message.index;
  try {
    if (!Number.isSafeInteger(index) || index < 0 || index >= rawIndices.length) {
      throw new RangeError('Verification index is out of range.');
    }
    const rawIndex = Number(rawIndices[index]);
    if (!Number.isSafeInteger(rawIndex) || rawIndex < 0) {
      throw new RangeError('Raw candidate index is invalid.');
    }
    const candidate = candidateAtRawIndex(rawIndex);
    const matched = verifyCandidate(verificationContext, candidate);
    parentPort.postMessage({ type: 'result', index, matched });
  } catch (error) {
    parentPort.postMessage({ type: 'error', index, errorCode: 'VERIFICATION_FAILED' });
  }
});
