const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { generateCandidate, patternForIndex } = require('./candidateGenerator');
const { verifyCandidate } = require('./walletVerifier');
const { saveCheckpoint } = require('./checkpoint');

const config = JSON.parse(JSON.stringify(workerData.config || {}));
const keystorePath = workerData.keystorePath;
const checkpointPath = workerData.checkpointPath || path.resolve(__dirname, '../../data/checkpoint.json');
const keystore = JSON.parse(fs.readFileSync(keystorePath, 'utf8'));
let state = workerData.initialState || 'running';
let candidateIndex = Number(workerData.startIndex || 0);
let totalAttempted = Number(workerData.totalAttempted || 0);
let matchesFound = Number(workerData.matchesFound || 0);
const startedAt = Number(workerData.startedAt || Date.now());
const checkpointInterval = Number(workerData.checkpointInterval || 250);
let stopRequested = false;

function updateStatus(message) {
  const status = {
    type: 'status',
    state,
    candidateIndex,
    totalAttempted,
    matchesFound,
    currentPattern: patternForIndex(config, candidateIndex).pattern.name,
    elapsedMs: Date.now() - startedAt,
    startedAt,
    lastCheckpointAt: Date.now()
  };
  parentPort.postMessage({ ...status, ...message });
}

parentPort.on('message', (message) => {
  if (!message || !message.type) {
    return;
  }
  if (message.type === 'control') {
    if (message.action === 'pause') {
      state = 'paused';
    }
    if (message.action === 'resume') {
      state = 'running';
    }
    if (message.action === 'stop') {
      state = 'stopped';
      stopRequested = true;
    }
  }
});

(async function loop() {
  while (!stopRequested) {
    while (state === 'paused' && !stopRequested) {
      await new Promise((resolve) => setTimeout(resolve, 75));
    }

    if (state === 'stopped' || stopRequested) {
      break;
    }

    let batch = 0;
    while (state === 'running' && !stopRequested && batch < 2000) {
      const currentPattern = patternForIndex(config, candidateIndex).pattern.name;
      const candidate = generateCandidate(config, candidateIndex);
      const found = await verifyCandidate(keystore, candidate);
      totalAttempted += 1;
      if (found) {
        matchesFound += 1;
        const message = {
          type: 'match',
          candidateIndex,
          currentPattern,
          totalAttempted,
          matchesFound,
          elapsedMs: Date.now() - startedAt,
          state: 'found'
        };
        saveCheckpoint(checkpointPath, {
          candidateIndex,
          totalAttempted,
          startedAt,
          lastCheckpointAt: Date.now(),
          elapsedMs: Date.now() - startedAt,
          currentPattern,
          matchesFound,
          state: 'found'
        });
        parentPort.postMessage(message);
        state = 'found';
        stopRequested = true;
        break;
      }

      candidateIndex += 1;
      batch += 1;

      if (totalAttempted % checkpointInterval === 0) {
        const checkpoint = {
          candidateIndex,
          totalAttempted,
          startedAt,
          lastCheckpointAt: Date.now(),
          elapsedMs: Date.now() - startedAt,
          currentPattern,
          matchesFound,
          state: 'running'
        };
        saveCheckpoint(checkpointPath, checkpoint);
        parentPort.postMessage({ type: 'status', ...checkpoint });
      }
    }

    if (!stopRequested) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  parentPort.postMessage({
    type: 'finished',
    candidateIndex,
    totalAttempted,
    matchesFound,
    currentPattern: patternForIndex(config, candidateIndex).pattern.name,
    elapsedMs: Date.now() - startedAt,
    state: state === 'found' ? 'found' : 'stopped'
  });
})().catch((error) => {
  parentPort.postMessage({ type: 'error', error: String(error) });
});
