const fs = require('node:fs');
const path = require('node:path');
const { atomicWritePrivateJson, readJsonFile, resolveRuntimeDir } = require('./runtime');
const { prepareJob, releaseJobLock } = require('./recovery/jobStore');
const { RecoveryEngine, RecoveryStateError } = require('./recovery/recoveryEngine');
const { buildGuidedConfig, getGuidedDefaults } = require('./recovery/guidedConfig');
const { compileCandidatePlan, validateConfig } = require('./recovery/candidateGenerator');

class SetupError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function setupError(error) {
  if (error instanceof SetupError || error instanceof RecoveryStateError) return error;
  if (error.code === 'INVALID_KEYSTORE') {
    return new SetupError('INVALID_KEYSTORE', 'Use an owner-only Ethereum V3 scrypt keystore file (chmod 600). Check the path and file format.');
  }
  const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(error.message) ? error.message : 'SETUP_FAILED';
  return new SetupError(code, code === 'SETUP_FAILED'
    ? 'The search could not be prepared. Check your word lists, ranges, wallet file, and runtime directory.'
    : code.toLowerCase().replaceAll('_', ' '));
}

function demoConfig() {
  return buildGuidedConfig({
    ...getGuidedDefaults(), word1: ['Demo'], word2: ['Pass'],
    minLength: 12, maxLength: 12, minDigits: 3, maxDigits: 3,
    minSymbols: 1, maxSymbols: 1, symbols: '!', caseStyles: ['title'],
    layouts: ['suffix'], digitMode: 'all', symbolMode: 'repeated'
  });
}

class SetupController {
  constructor(options = {}, { onFatal = () => {} } = {}) {
    this.options = options;
    this.runtimeDir = resolveRuntimeDir(options.runtimeDir);
    this.savedPath = path.join(this.runtimeDir, 'last-setup.json');
    this.engine = null;
    this.job = null;
    this.pending = null;
    this.phase = null;
    this.errorCode = null;
    this.closing = false;
    this.shutdownPromise = null;
    this.freshPending = Boolean(options.fresh);
    this.onFatal = onFatal;
  }

  getSetup() {
    return {
      enabled: true, configured: Boolean(this.engine), busy: Boolean(this.pending),
      savedJobAvailable: fs.existsSync(this.savedPath),
      defaults: { mode: 'REAL', walletPath: '', rules: getGuidedDefaults() }
    };
  }

  currentSetup() {
    if (this.pending) throw new RecoveryStateError('OPERATION_IN_PROGRESS');
    if (!this.job) throw new RecoveryStateError('SETUP_REQUIRED');
    return {
      mode: this.job.mode,
      walletPath: this.job.mode === 'REAL' ? this.job.wallet.path : '',
      rules: this.job.mode === 'REAL' ? structuredClone(this.job.config.guided) : getGuidedDefaults()
    };
  }

  getStatus() {
    const status = this.engine ? this.engine.getStatus() : {
      ready: false, state: 'setup', jobId: null, mode: null,
      rawCandidateCount: 0, uniqueCandidateCount: 0, duplicatesRemoved: 0,
      totalVerified: 0, searchedCandidateCount: 0, remainingCandidateCount: 0,
      nextCandidateIndex: 0, completionPercent: 0, activeWorkers: 0,
      guessesPerSecond: 0, guessesPerHour: 0, activeElapsedMs: 0,
      estimatedSecondsRemaining: null, estimatedTotalSeconds: null,
      lastCheckpointAt: null, matchFound: false, benchmark: null
    };
    return {
      ...status, configured: Boolean(this.engine), setupPhase: this.phase,
      ...(status.matchFound ? {
        revealCommand: `npm run reveal -- --job ${status.jobId} --runtime-dir '${this.runtimeDir.replaceAll("'", "'\\''")}'`
      } : {}),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      ...(this.pending ? { state: 'preparing', ready: false } : {})
    };
  }

  _selection(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['mode', 'walletPath', 'rules'].includes(key))) {
      throw new SetupError('SETUP_INVALID', 'Supply a wallet mode and password rules.');
    }
    if (!['DEMO', 'REAL'].includes(input.mode)) {
      throw new SetupError('MODE_INVALID', 'Choose a local wallet or the demo.');
    }
    if (input.mode === 'DEMO') return { mode: 'DEMO', config: demoConfig(), walletPath: null };
    if (typeof input.walletPath !== 'string' || !path.isAbsolute(input.walletPath)
        || input.walletPath.length > 4096 || input.walletPath.includes('\0')) {
      throw new SetupError('WALLET_PATH_INVALID', 'Enter the absolute path to your local keystore JSON file.');
    }
    let config;
    try {
      config = buildGuidedConfig(input.rules);
    } catch (error) {
      // Guided validation contains field names and bounds, never supplied words.
      throw new SetupError('RULES_INVALID', error.message);
    }
    return { mode: 'REAL', walletPath: input.walletPath, config };
  }

  preview(input) {
    if (this.closing) throw new RecoveryStateError('SHUTDOWN_IN_PROGRESS');
    const selection = this._selection(input);
    let plan;
    try {
      plan = compileCandidatePlan(selection.config);
    } catch (error) {
      throw new SetupError('RULES_INVALID', error.message);
    }
    if (plan.uniqueCount === 0) {
      throw new SetupError('NO_CANDIDATES', 'No passwords fit these rules. Widen the length range or adjust your word lists.');
    }
    const warnings = [];
    if (selection.mode === 'DEMO') warnings.push('The demo uses a built-in wallet and a known 1,000-candidate search.');
    else {
      warnings.push('Coverage is limited to your word lists, selected case styles, and layouts.');
      if (selection.config.guided.digitMode === 'repeated' || selection.config.guided.symbolMode === 'repeated') {
        warnings.push('Repeated mode covers runs of one character. Choose all combinations to include mixed runs.');
      }
      if (plan.uniqueCount > 1_000_000) warnings.push('This is a large search. Preparation measures your wallet speed to estimate its duration.');
    }
    return {
      rawCandidateCount: plan.rawCount, uniqueCandidateCount: plan.uniqueCount,
      duplicatesRemoved: plan.duplicateCount, warnings
    };
  }

  _exclusive(operation) {
    if (this.closing) return Promise.reject(new RecoveryStateError('SHUTDOWN_IN_PROGRESS'));
    if (this.pending) return Promise.reject(new RecoveryStateError('OPERATION_IN_PROGRESS'));
    if (this.engine && (this.engine.state === 'running' || this.engine.operationInProgress)) {
      return Promise.reject(new SetupError('SEARCH_ACTIVE', 'Pause or stop the current search before changing its setup.', 409));
    }
    this.errorCode = null;
    this.phase = 'Preparing search';
    this.pending = Promise.resolve().then(operation).catch((error) => {
      const safe = setupError(error);
      this.errorCode = safe.code;
      throw safe;
    }).finally(() => {
      this.pending = null;
      this.phase = null;
    });
    return this.pending.then(() => this.getStatus());
  }

  configure(input) {
    return this._exclusive(async () => {
      this.preview(input);
      await this._prepare(this._selection(input));
    });
  }

  restore() {
    return this._exclusive(async () => {
      const saved = readJsonFile(this.savedPath, { privateFile: true, label: 'SAVED_SETUP' });
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)
          || saved.schemaVersion !== 1 || !['REAL', 'DEMO'].includes(saved.mode)
          || !['auto', '1', '2', '3', '4'].includes(saved.workerSetting)
          || (saved.mode === 'REAL' && (typeof saved.walletPath !== 'string' || !path.isAbsolute(saved.walletPath)))) {
        throw new SetupError('SAVED_SETUP_INVALID', 'The saved setup is invalid. Prepare a new search.');
      }
      const config = validateConfig(saved.config);
      if (!config.guided) throw new SetupError('SAVED_SETUP_INVALID', 'Prepare a new guided search.');
      const workerSetting = this.options.workerSettingExplicit === false
        ? saved.workerSetting : this.options.workerSetting || saved.workerSetting;
      await this._prepare({ mode: saved.mode, walletPath: saved.walletPath, config }, workerSetting);
    });
  }

  restart() {
    return this._exclusive(async () => {
      if (!this.job) throw new RecoveryStateError('SETUP_REQUIRED');
      const selection = { mode: this.job.mode, walletPath: this.job.wallet.path, config: this.job.config };
      const workerSetting = this.engine.workerSetting;
      this.freshPending = true;
      await this._prepare(selection, workerSetting);
    });
  }

  async _closeJob({ persist = true } = {}) {
    const engine = this.engine;
    const job = this.job;
    this.engine = null;
    this.job = null;
    try {
      if (engine) await engine.shutdown({ persist: persist && !job.lock.lost });
    } finally {
      if (job?.lock && !job.lock.lost && !job.lock.released) await releaseJobLock(job.lock);
    }
  }

  async _prepare(selection, workerSetting = this.options.workerSetting || 'auto') {
    await this._closeJob();
    if (this.closing) throw new RecoveryStateError('SHUTDOWN_IN_PROGRESS');
    const job = await prepareJob({
      ...selection, runtimeDir: this.runtimeDir, acquireLock: true,
      fresh: this.freshPending
    });
    this.freshPending = false;
    this.job = job;
    try {
      const engine = new RecoveryEngine(job, { workerSetting });
      this.engine = engine;
      job.lock.onLost = () => {
        this.errorCode = 'JOB_LOCK_LOST';
        void engine.shutdown({ persist: false }).catch(() => {});
        this.onFatal(new Error('JOB_LOCK_LOST'));
      };
      if (job.lock.lost) throw new Error('JOB_LOCK_LOST');
      this.phase = 'Measuring wallet speed';
      await engine.initialize();
      if (job.lock.lost) throw new Error('JOB_LOCK_LOST');
      if (this.closing) throw new RecoveryStateError('SHUTDOWN_IN_PROGRESS');
      atomicWritePrivateJson(this.savedPath, {
        schemaVersion: 1, ...selection, workerSetting
      });
    } catch (error) {
      await this._closeJob().catch(() => {});
      throw error;
    }
  }

  _operate(name) {
    if (this.closing) throw new RecoveryStateError('SHUTDOWN_IN_PROGRESS');
    if (this.pending) throw new RecoveryStateError('OPERATION_IN_PROGRESS');
    if (!this.engine) throw new RecoveryStateError('SETUP_REQUIRED');
    return this.engine[name]();
  }

  start() { return this._operate('start'); }
  pause() { return this._operate('pause'); }
  resume() { return this._operate('resume'); }
  stop() { return this._operate('stop'); }
  calibrate() { return this._operate('calibrate'); }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = (async () => {
      if (this.pending) await this.pending.catch(() => {});
      await this._closeJob();
    })();
    return this.shutdownPromise;
  }
}

module.exports = { SetupController, SetupError };
