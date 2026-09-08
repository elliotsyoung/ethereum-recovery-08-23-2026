const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const {
  APP_SCHEMA_VERSION,
  atomicWritePrivateJson,
  readJsonFile
} = require('../runtime');
const { candidateForUniqueIndex } = require('./candidateGenerator');
const { allowedWorkerCounts, runBenchmark } = require('./benchmark');
const { loadCheckpoint, saveCheckpoint } = require('./checkpoint');
const { confirmCandidate } = require('./walletVerifier');

const CHECKPOINT_INTERVAL_MS = 15_000;
const RATE_WINDOW_MS = 30_000;
const TERMINAL_STATES = new Set(['exhausted', 'found', 'failed']);

class RecoveryStateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.statusCode = 409;
  }
}

class RecoveryEngine {
  constructor(job, { workerSetting = 'auto', checkpointIntervalMs = CHECKPOINT_INTERVAL_MS } = {}) {
    if (!job?.checkpoint || !job?.candidatePlan || !job?.wallet) {
      throw new Error('RECOVERY_JOB_REQUIRED');
    }
    if (!['auto', '1', '2', '3', '4'].includes(String(workerSetting))) {
      throw new Error('WORKER_SETTING_INVALID');
    }
    if (!Number.isSafeInteger(checkpointIntervalMs) || checkpointIntervalMs < 1) {
      throw new Error('CHECKPOINT_INTERVAL_INVALID');
    }

    this.job = job;
    this.state = job.checkpoint.state;
    this.nextCandidateIndex = job.checkpoint.nextCandidateIndex;
    this.totalVerified = job.checkpoint.totalVerified;
    this.activeElapsedMs = job.checkpoint.activeElapsedMs;
    this.startedAt = job.checkpoint.startedAt;
    this.lastCheckpointAt = job.checkpoint.lastCheckpointAt;
    this.matchedUniqueIndex = job.checkpoint.matchedUniqueIndex;
    this.errorCode = job.checkpoint.errorCode;
    this.workerSetting = String(workerSetting);
    this.workerCount = workerSetting === 'auto' ? null : Number(workerSetting);
    this.checkpointIntervalMs = checkpointIntervalMs;
    this.workers = [];
    this.inFlight = new Map();
    this.completed = new Set();
    this.nextToAssign = this.nextCandidateIndex;
    this.rateSamples = [];
    this.segmentStartedAt = null;
    this.checkpointTimer = null;
    this.benchmark = null;
    this.matchPending = false;
    this.operationInProgress = null;
    this.operationPromise = null;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.terminationPromise = null;
    this.persistenceDisabled = false;

    if (this.nextCandidateIndex > job.candidatePlan.uniqueCount
        || (this.matchedUniqueIndex !== null
          && this.matchedUniqueIndex >= job.candidatePlan.uniqueCount)) {
      throw new Error('CHECKPOINT_INDEX_OUT_OF_RANGE');
    }
    if (this.state === 'running') {
      this.state = 'interrupted';
      this._checkpoint('interrupted');
    }
  }

  async initialize() {
    const loaded = this._loadBenchmark();
    if (!loaded && !TERMINAL_STATES.has(this.state)) {
      await this.calibrate();
    }
    return this.getStatus();
  }

  _loadBenchmark() {
    if (!fs.existsSync(this.job.paths.benchmarkPath)) return false;
    try {
      const stored = readJsonFile(this.job.paths.benchmarkPath, {
        privateFile: true,
        label: 'JOB_BENCHMARK'
      });
      const result = stored?.benchmark;
      if (stored.schemaVersion !== APP_SCHEMA_VERSION
          || stored.jobId !== this.job.jobId
          || stored.workerSetting !== this.workerSetting
          || typeof stored.measuredAt !== 'string'
          || !Number.isFinite(Date.parse(stored.measuredAt))
          || result?.status !== 'ok'
          || !Number.isSafeInteger(result.selectedWorkerCount)
          || result.selectedWorkerCount < 1
          || result.selectedWorkerCount > 4
          || !Number.isFinite(result.guessesPerSecond)
          || result.guessesPerSecond <= 0
          || !Number.isFinite(result.guessesPerHour)
          || result.guessesPerHour <= 0
          || !Number.isSafeInteger(result.memoryBudgetBytes)
          || result.memoryBudgetBytes <= 0
          || !Number.isSafeInteger(result.estimatedMemoryPerWorkerBytes)
          || result.estimatedMemoryPerWorkerBytes <= 0
          || !Array.isArray(result.measurements)
          || result.measurements.length === 0) {
        return false;
      }
      const measurements = result.measurements.map((measurement) => {
        if (!Number.isSafeInteger(measurement?.workerCount)
            || measurement.workerCount < 1
            || measurement.workerCount > 4
            || !Number.isSafeInteger(measurement.checks)
            || measurement.checks <= 0
            || !Number.isFinite(measurement.elapsedMs)
            || measurement.elapsedMs <= 0
            || !Number.isFinite(measurement.guessesPerSecond)
            || measurement.guessesPerSecond <= 0
            || !Number.isFinite(measurement.msPerGuess)
            || measurement.msPerGuess <= 0) {
          throw new Error('JOB_BENCHMARK_INVALID');
        }
        return {
          workerCount: measurement.workerCount,
          checks: measurement.checks,
          elapsedMs: measurement.elapsedMs,
          guessesPerSecond: measurement.guessesPerSecond,
          msPerGuess: measurement.msPerGuess
        };
      });
      if (!measurements.some(({ workerCount }) => workerCount === result.selectedWorkerCount)) {
        return false;
      }
      const currentMemory = allowedWorkerCounts(
        this.job.wallet.verificationContext,
        [result.selectedWorkerCount]
      );
      if (currentMemory.budget !== result.memoryBudgetBytes
          || currentMemory.perWorker !== result.estimatedMemoryPerWorkerBytes) {
        return false;
      }
      const fastest = measurements.reduce((best, measurement) => (
        measurement.guessesPerSecond > best.guessesPerSecond ? measurement : best
      ));
      if (fastest.workerCount !== result.selectedWorkerCount
          || (this.workerSetting !== 'auto'
            && result.selectedWorkerCount !== Number(this.workerSetting))) {
        return false;
      }
      this.benchmark = {
        status: 'ok',
        selectedWorkerCount: result.selectedWorkerCount,
        guessesPerSecond: result.guessesPerSecond,
        guessesPerHour: result.guessesPerHour,
        memoryBudgetBytes: result.memoryBudgetBytes,
        estimatedMemoryPerWorkerBytes: result.estimatedMemoryPerWorkerBytes,
        measurements
      };
      this.workerCount = this.workerSetting === 'auto'
        ? result.selectedWorkerCount
        : Number(this.workerSetting);
      return true;
    } catch {
      return false;
    }
  }

  _assertState(allowed) {
    if (!allowed.includes(this.state)) {
      throw new RecoveryStateError('INVALID_STATE_TRANSITION');
    }
    if (this.shuttingDown) {
      throw new RecoveryStateError('SHUTDOWN_IN_PROGRESS');
    }
    if (this.matchPending) {
      throw new RecoveryStateError('MATCH_CONFIRMATION_IN_PROGRESS');
    }
  }

  _exclusive(name, operation) {
    if (this.operationInProgress !== null) {
      return Promise.reject(new RecoveryStateError('OPERATION_IN_PROGRESS'));
    }
    this.operationInProgress = name;
    let trackedPromise;
    trackedPromise = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.operationInProgress === name) {
          this.operationInProgress = null;
        }
        if (this.operationPromise === trackedPromise) {
          this.operationPromise = null;
        }
      });
    this.operationPromise = trackedPromise;
    return trackedPromise;
  }

  _activeElapsedNow() {
    if (this.segmentStartedAt === null) return this.activeElapsedMs;
    return this.activeElapsedMs + (Date.now() - this.segmentStartedAt);
  }

  _closeActiveSegment() {
    this.activeElapsedMs = this._activeElapsedNow();
    this.segmentStartedAt = null;
  }

  _checkpoint(state = this.state) {
    if (this.persistenceDisabled) {
      throw new Error('RECOVERY_PERSISTENCE_DISABLED');
    }
    const checkpointAt = Date.now();
    const saved = saveCheckpoint(this.job.paths.checkpointPath, {
      schemaVersion: APP_SCHEMA_VERSION,
      jobId: this.job.jobId,
      state,
      nextCandidateIndex: this.nextCandidateIndex,
      totalVerified: this.totalVerified,
      activeElapsedMs: Math.round(this._activeElapsedNow()),
      startedAt: this.startedAt,
      lastCheckpointAt: checkpointAt,
      matchedUniqueIndex: this.matchedUniqueIndex,
      errorCode: this.errorCode
    });
    this.lastCheckpointAt = checkpointAt;
    return saved;
  }

  _startCheckpointTimer() {
    this._stopCheckpointTimer();
    this.checkpointTimer = setInterval(() => {
      if (this.state !== 'running') return;
      try {
        this._checkpoint('running');
      } catch {
        void this._fail('CHECKPOINT_WRITE_FAILED', { attemptCheckpoint: false });
      }
    }, this.checkpointIntervalMs);
    this.checkpointTimer.unref();
  }

  _stopCheckpointTimer() {
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  calibrate() {
    return this._exclusive('benchmark', async () => {
      this._assertState(['ready', 'paused', 'interrupted', 'stopped']);
      const workerCounts = this.workerSetting === 'auto'
        ? [1, 2, 4]
        : [Number(this.workerSetting)];
      const benchmark = await runBenchmark({
        verificationContext: this.job.wallet.verificationContext,
        workerCounts
      });
      if (this.shuttingDown || this.persistenceDisabled) {
        throw new RecoveryStateError('SHUTDOWN_IN_PROGRESS');
      }
      this.benchmark = benchmark;
      this.workerCount = this.workerSetting === 'auto'
        ? benchmark.selectedWorkerCount
        : Number(this.workerSetting);
      atomicWritePrivateJson(this.job.paths.benchmarkPath, {
        schemaVersion: APP_SCHEMA_VERSION,
        jobId: this.job.jobId,
        workerSetting: this.workerSetting,
        measuredAt: new Date().toISOString(),
        benchmark
      });
      return benchmark;
    });
  }

  _spawnWorkers() {
    if (this.workers.length) return;
    if (!Number.isSafeInteger(this.workerCount) || this.workerCount < 1 || this.workerCount > 4) {
      throw new Error('WORKER_COUNT_INVALID');
    }
    allowedWorkerCounts(this.job.wallet.verificationContext, [this.workerCount]);
    const workerPath = path.resolve(__dirname, 'recoveryVerifierWorker.js');
    try {
      for (let index = 0; index < this.workerCount; index += 1) {
        const worker = new Worker(workerPath, {
          workerData: {
            config: this.job.config,
            rawIndices: this.job.candidatePlan.rawIndices,
            verificationContext: this.job.wallet.verificationContext
          }
        });
        worker.on('message', (message) => this._onWorkerMessage(worker, message));
        worker.on('error', () => {
          if (!this.shuttingDown && this.state === 'running') {
            void this._fail('WORKER_FAILURE');
          }
        });
        worker.on('exit', () => {
          if (!this.shuttingDown
              && this.terminationPromise === null
              && this.state === 'running') {
            void this._fail('WORKER_EXITED');
          }
        });
        this.workers.push(worker);
      }
    } catch (error) {
      void this._terminateWorkers();
      throw error;
    }
  }

  _schedule() {
    if (this.state !== 'running' || this.matchPending || this.shuttingDown) return;
    for (const worker of this.workers) {
      if (this.inFlight.has(worker)) continue;
      if (this.nextToAssign >= this.job.candidatePlan.uniqueCount) break;
      const index = this.nextToAssign;
      this.nextToAssign += 1;
      this.inFlight.set(worker, index);
      try {
        worker.postMessage({ type: 'verify', index });
      } catch {
        void this._fail('WORKER_FAILURE');
        return;
      }
    }
    this._finishIfExhausted();
  }

  _onWorkerMessage(worker, message) {
    if (this.state !== 'running' || this.shuttingDown) return;
    if (message?.type === 'error') {
      void this._fail(message.errorCode || 'WORKER_FAILURE');
      return;
    }
    if (message?.type !== 'result'
        || typeof message.matched !== 'boolean'
        || !this.inFlight.has(worker)) {
      void this._fail('WORKER_PROTOCOL_ERROR');
      return;
    }
    const expectedIndex = this.inFlight.get(worker);
    this.inFlight.delete(worker);
    if (message.index !== expectedIndex) {
      void this._fail('WORKER_PROTOCOL_ERROR');
      return;
    }

    this.totalVerified += 1;
    this.rateSamples.push(Date.now());
    this._trimRateSamples();
    if (message.matched) {
      void this._confirmMatch(message.index);
      return;
    }
    this.completed.add(message.index);
    while (this.completed.delete(this.nextCandidateIndex)) {
      this.nextCandidateIndex += 1;
    }
    this._schedule();
  }

  async _confirmMatch(uniqueIndex) {
    if (this.matchPending || this.state !== 'running' || this.shuttingDown) return;
    this.matchPending = true;
    try {
      const candidate = candidateForUniqueIndex(
        this.job.config,
        this.job.candidatePlan,
        uniqueIndex
      );
      const confirmed = await confirmCandidate(
        this.job.wallet.rawJson,
        candidate,
        this.job.wallet.address
      );
      if (this.state !== 'running' || this.shuttingDown) return;
      if (!confirmed) {
        await this._fail('VERIFIER_MISMATCH');
        return;
      }
      this._closeActiveSegment();
      this.state = 'found';
      this.matchedUniqueIndex = uniqueIndex;
      this.errorCode = null;
      this._stopCheckpointTimer();
      try {
        this._checkpoint('found');
      } catch {
        let durableFound = null;
        try {
          const checkpoint = loadCheckpoint(
            this.job.paths.checkpointPath,
            this.job.jobId
          );
          if (checkpoint.state === 'found'
              && checkpoint.matchedUniqueIndex === uniqueIndex) {
            durableFound = checkpoint;
          }
        } catch {
          // A prior running checkpoint intentionally causes safe replay.
        }
        if (durableFound) {
          this.lastCheckpointAt = durableFound.lastCheckpointAt;
        } else {
          this.state = 'failed';
          this.matchedUniqueIndex = null;
          this.errorCode = 'CHECKPOINT_WRITE_FAILED';
        }
      }
      await this._terminateWorkers();
    } catch {
      await this._fail('MATCH_CONFIRMATION_FAILED');
    } finally {
      this.matchPending = false;
    }
  }

  _finishIfExhausted() {
    if (this.state !== 'running'
        || this.nextCandidateIndex < this.job.candidatePlan.uniqueCount
        || this.inFlight.size > 0
        || this.matchPending) {
      return;
    }
    this._closeActiveSegment();
    this.state = 'exhausted';
    this._stopCheckpointTimer();
    try {
      this._checkpoint('exhausted');
    } catch {
      this.state = 'failed';
      this.errorCode = 'CHECKPOINT_WRITE_FAILED';
      try {
        this._checkpoint('failed');
      } catch {
        // The prior running checkpoint remains safe to resume.
      }
    }
    void this._terminateWorkers();
  }

  async _fail(errorCode, { attemptCheckpoint = true } = {}) {
    if (TERMINAL_STATES.has(this.state)) return;
    this._closeActiveSegment();
    this.state = 'failed';
    this.matchedUniqueIndex = null;
    this.errorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(errorCode || ''))
      ? errorCode
      : 'RECOVERY_FAILURE';
    this._stopCheckpointTimer();
    if (attemptCheckpoint) {
      try {
        this._checkpoint('failed');
      } catch {
        // Stop workers even if persistent storage is no longer writable.
      }
    }
    await this._terminateWorkers();
  }

  async _terminateWorkers() {
    if (this.terminationPromise) return this.terminationPromise;
    const workers = this.workers.splice(0);
    this.inFlight.clear();
    this.completed.clear();
    this.nextToAssign = this.nextCandidateIndex;
    if (!workers.length) return undefined;

    this.terminationPromise = Promise.all(workers.map(async (worker) => {
      worker.removeAllListeners();
      try {
        await worker.terminate();
      } catch {
        // A worker may already have exited after reporting a failure.
      }
    })).finally(() => {
      this.terminationPromise = null;
    });
    return this.terminationPromise;
  }

  async _begin(allowedStates) {
    this._assertState(allowedStates);
    if (this.nextCandidateIndex >= this.job.candidatePlan.uniqueCount) {
      throw new RecoveryStateError('CANDIDATE_SPACE_EXHAUSTED');
    }
    this.state = 'running';
    this.errorCode = null;
    this.matchedUniqueIndex = null;
    if (!this.startedAt) this.startedAt = Date.now();
    this.segmentStartedAt = Date.now();
    this.rateSamples = [];
    this.nextToAssign = this.nextCandidateIndex;
    try {
      this._checkpoint('running');
      this._spawnWorkers();
    } catch {
      await this._fail('RECOVERY_START_FAILED');
      throw new Error('RECOVERY_START_FAILED');
    }
    this._startCheckpointTimer();
    this._schedule();
    return this.getStatus();
  }

  start() {
    return this._exclusive('start', () => this._begin(['ready', 'stopped']));
  }

  resume() {
    return this._exclusive('resume', () => this._begin(['paused', 'interrupted']));
  }

  pause() {
    return this._exclusive('pause', async () => {
      this._assertState(['running']);
      this._closeActiveSegment();
      this.state = 'paused';
      this._stopCheckpointTimer();
      try {
        this._checkpoint('paused');
      } catch {
        await this._fail('CHECKPOINT_WRITE_FAILED', { attemptCheckpoint: false });
        throw new Error('CHECKPOINT_WRITE_FAILED');
      }
      await this._terminateWorkers();
      return this.getStatus();
    });
  }

  stop() {
    return this._exclusive('stop', async () => {
      this._assertState(['running', 'paused', 'interrupted']);
      this._closeActiveSegment();
      this.state = 'stopped';
      this._stopCheckpointTimer();
      try {
        this._checkpoint('stopped');
      } catch {
        await this._fail('CHECKPOINT_WRITE_FAILED', { attemptCheckpoint: false });
        throw new Error('CHECKPOINT_WRITE_FAILED');
      }
      await this._terminateWorkers();
      return this.getStatus();
    });
  }

  shutdown({ persist = true } = {}) {
    if (!persist) this.persistenceDisabled = true;
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      if (this.operationPromise) {
        try {
          await this.operationPromise;
        } catch {
          // The operation caller receives its own sanitized failure.
        }
      }
      let checkpointError = null;
      if (this.state === 'running') {
        this._closeActiveSegment();
        this.state = 'interrupted';
        this.matchPending = false;
        if (!this.persistenceDisabled) {
          try {
            this._checkpoint('interrupted');
          } catch (error) {
            checkpointError = error;
          }
        }
      }
      this._stopCheckpointTimer();
      await this._terminateWorkers();
      if (checkpointError) throw checkpointError;
    })();
    return this.shutdownPromise;
  }

  _trimRateSamples() {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (this.rateSamples.length && this.rateSamples[0] < cutoff) {
      this.rateSamples.shift();
    }
  }

  _liveRate() {
    if (this.state !== 'running' || this.segmentStartedAt === null) return 0;
    this._trimRateSamples();
    if (!this.rateSamples.length) return 0;
    const windowStart = Math.max(Date.now() - RATE_WINDOW_MS, this.segmentStartedAt);
    return this.rateSamples.length / Math.max((Date.now() - windowStart) / 1000, 0.001);
  }

  getStatus() {
    const uniqueCount = this.job.candidatePlan.uniqueCount;
    const progressIndex = this.state === 'found' && this.matchedUniqueIndex !== null
      ? Math.max(this.nextCandidateIndex, this.matchedUniqueIndex + 1)
      : this.nextCandidateIndex;
    const liveRate = this._liveRate();
    const estimateRate = liveRate || this.benchmark?.guessesPerSecond || 0;
    return {
      mode: this.job.mode,
      ready: true,
      state: this.state,
      jobId: this.job.jobId,
      rawCandidateCount: this.job.candidatePlan.rawCount,
      uniqueCandidateCount: uniqueCount,
      duplicatesRemoved: this.job.candidatePlan.duplicateCount,
      totalVerified: this.totalVerified,
      nextCandidateIndex: this.nextCandidateIndex,
      completionPercent: uniqueCount > 0
        ? Number(((progressIndex / uniqueCount) * 100).toFixed(5))
        : 100,
      activeWorkers: this.state === 'running' ? this.workers.length : 0,
      guessesPerSecond: liveRate,
      guessesPerHour: liveRate * 3600,
      activeElapsedMs: Math.round(this._activeElapsedNow()),
      estimatedSecondsRemaining: ['found', 'exhausted'].includes(this.state)
        ? 0
        : this.state === 'failed'
          ? null
          : estimateRate > 0
            ? Math.max(uniqueCount - this.nextCandidateIndex, 0) / estimateRate
            : null,
      lastCheckpointAt: this.lastCheckpointAt,
      matchFound: this.state === 'found',
      errorCode: this.errorCode,
      benchmark: this.benchmark
    };
  }
}

module.exports = {
  CHECKPOINT_INTERVAL_MS,
  RATE_WINDOW_MS,
  RecoveryEngine,
  RecoveryStateError
};
