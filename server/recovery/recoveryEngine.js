const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { getDefaultPatternConfig } = require('./candidateGenerator');
const { loadCheckpoint } = require('./checkpoint');
const { ensureDemoWallet, readKeystoreFile } = require('./walletVerifier');

class RecoveryEngine {
  constructor() {
    this.worker = null;
    this.state = 'idle';
    this.mode = 'DEMO';
    this.status = {
      candidateIndex: 0,
      totalAttempted: 0,
      startedAt: null,
      lastCheckpointAt: null,
      elapsedMs: 0,
      currentPattern: 'n/a',
      matchesFound: 0,
      mode: 'DEMO',
      state: 'idle',
      keystorePath: null
    };
  }

  async start({ mode = 'DEMO', config = getDefaultPatternConfig(), walletPath = null, checkpointPath = path.resolve(__dirname, '../../data/checkpoint.json') } = {}) {
    const normalizedMode = String(mode || 'DEMO').toUpperCase();
    const prior = loadCheckpoint(checkpointPath);
    const lastIndex = Number(prior.candidateIndex || 0);
    const startedAt = prior.startedAt || Date.now();
    const walletTarget = normalizedMode === 'REAL'
      ? walletPath || process.env.WALLET_PATH || path.resolve(__dirname, '../../wallet/real-keystore.json')
      : await ensureDemoWallet();

    if (normalizedMode === 'REAL' && !walletTarget) {
      throw new Error('REAL mode requires a local keystore file path.');
    }

    if (this.worker) {
      this.worker.terminate();
    }

    this.mode = normalizedMode;
    this.state = 'running';
    this.status = {
      ...this.status,
      mode: normalizedMode,
      state: 'running',
      candidateIndex: lastIndex,
      totalAttempted: Number(prior.totalAttempted || 0),
      startedAt,
      lastCheckpointAt: prior.lastCheckpointAt || null,
      elapsedMs: Number(prior.elapsedMs || 0),
      currentPattern: prior.currentPattern || 'n/a',
      matchesFound: Number(prior.matchesFound || 0),
      keystorePath: walletTarget
    };

    const workerPath = path.resolve(__dirname, './recoveryWorker.js');
    this.worker = new Worker(workerPath, {
      workerData: {
        config,
        keystorePath: walletTarget,
        checkpointPath,
        startIndex: lastIndex,
        totalAttempted: Number(prior.totalAttempted || 0),
        matchesFound: Number(prior.matchesFound || 0),
        startedAt,
        checkpointInterval: 250,
        initialState: 'running'
      }
    });

    this.worker.on('message', (message) => {
      if (!message || !message.type) {
        return;
      }
      if (message.type === 'status' || message.type === 'tick' || message.type === 'match' || message.type === 'finished') {
        this.status = {
          ...this.status,
          mode: normalizedMode,
          state: message.state || this.state,
          candidateIndex: Number(message.candidateIndex || this.status.candidateIndex || 0),
          totalAttempted: Number(message.totalAttempted || this.status.totalAttempted || 0),
          startedAt: message.startedAt || this.status.startedAt || Date.now(),
          lastCheckpointAt: message.lastCheckpointAt || this.status.lastCheckpointAt || null,
          elapsedMs: Number(message.elapsedMs || this.status.elapsedMs || 0),
          currentPattern: message.currentPattern || this.status.currentPattern || 'n/a',
          matchesFound: Number(message.matchesFound || this.status.matchesFound || 0),
          keystorePath: walletTarget,
          foundCandidateIndex: message.candidateIndex || null
        };
        this.state = this.status.state;
      }
      if (message.type === 'match') {
        this.state = 'found';
        this.status.state = 'found';
      }
      if (message.type === 'finished') {
        this.state = message.state || 'stopped';
        this.status.state = message.state || 'stopped';
      }
    });

    this.worker.on('error', (error) => {
      this.state = 'stopped';
      this.status.state = 'stopped';
      this.status.error = String(error);
    });

    return {
      ok: true,
      mode: normalizedMode,
      status: this.getStatus()
    };
  }

  pause() {
    if (!this.worker) {
      return { ok: false, error: 'No active recovery job.' };
    }
    this.worker.postMessage({ type: 'control', action: 'pause' });
    this.state = 'paused';
    this.status.state = 'paused';
    return { ok: true, state: 'paused' };
  }

  resume() {
    if (!this.worker) {
      return { ok: false, error: 'No active recovery job.' };
    }
    this.worker.postMessage({ type: 'control', action: 'resume' });
    this.state = 'running';
    this.status.state = 'running';
    return { ok: true, state: 'running' };
  }

  stop() {
    if (!this.worker) {
      return { ok: false, error: 'No active recovery job.' };
    }
    this.worker.postMessage({ type: 'control', action: 'stop' });
    this.state = 'stopped';
    this.status.state = 'stopped';
    return { ok: true, state: 'stopped' };
  }

  getStatus() {
    const snapshot = { ...this.status };
    if (this.worker) {
      snapshot.workerActive = true;
    }
    snapshot.state = this.state;
    snapshot.mode = this.mode;
    return snapshot;
  }
}

module.exports = new RecoveryEngine();
