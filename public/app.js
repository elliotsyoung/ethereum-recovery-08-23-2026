'use strict';

const POLL_INTERVAL_MS = 1500;
const BACKGROUND_POLL_INTERVAL_MS = 5000;

const appState = {
  sessionToken: null,
  status: null,
  pollTimer: null,
  polling: false,
  statusRequestFailed: false,
  action: null
};

const els = {
  notice: document.getElementById('notice'),
  errorBanner: document.getElementById('errorBanner'),
  readinessBadge: document.getElementById('readinessBadge'),
  stateValue: document.getElementById('stateValue'),
  modeValue: document.getElementById('modeValue'),
  jobIdValue: document.getElementById('jobIdValue'),
  readyValue: document.getElementById('readyValue'),
  completeValue: document.getElementById('completeValue'),
  progressTrack: document.getElementById('progressTrack'),
  progressBar: document.getElementById('progressBar'),
  verifiedValue: document.getElementById('verifiedValue'),
  uniqueTotalValue: document.getElementById('uniqueTotalValue'),
  rawCountValue: document.getElementById('rawCountValue'),
  uniqueCountValue: document.getElementById('uniqueCountValue'),
  duplicatesValue: document.getElementById('duplicatesValue'),
  nextIndexValue: document.getElementById('nextIndexValue'),
  workersValue: document.getElementById('workersValue'),
  rateValue: document.getElementById('rateValue'),
  hourlyRateValue: document.getElementById('hourlyRateValue'),
  elapsedValue: document.getElementById('elapsedValue'),
  etaValue: document.getElementById('etaValue'),
  checkpointValue: document.getElementById('checkpointValue'),
  matchValue: document.getElementById('matchValue'),
  errorValue: document.getElementById('errorValue'),
  benchmarkSummary: document.getElementById('benchmarkSummary'),
  controls: document.getElementById('controls'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  stopBtn: document.getElementById('stopBtn'),
  benchmarkBtn: document.getElementById('benchmarkBtn')
};

const buttons = {
  start: els.startBtn,
  pause: els.pauseBtn,
  resume: els.resumeBtn,
  stop: els.stopBtn,
  benchmark: els.benchmarkBtn
};

const allowedControls = {
  ready: ['start', 'benchmark'],
  running: ['pause', 'stop'],
  paused: ['resume', 'stop'],
  interrupted: ['resume', 'stop', 'benchmark'],
  stopped: ['start', 'benchmark'],
  exhausted: [],
  found: [],
  failed: []
};

class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatNumber(value, maximumFractionDigits = 0) {
  return finiteNumber(value).toLocaleString(undefined, { maximumFractionDigits });
}

function formatRate(value) {
  const rate = Math.max(0, finiteNumber(value));
  const digits = rate > 0 && rate < 10 ? 2 : rate < 100 ? 1 : 0;
  return formatNumber(rate, digits);
}

function formatDurationFromMilliseconds(value) {
  const totalSeconds = Math.max(0, Math.floor(finiteNumber(value) / 1000));
  return formatDurationFromSeconds(totalSeconds);
}

function formatDurationFromSeconds(value) {
  let remaining = Math.max(0, Math.floor(finiteNumber(value)));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function cleanErrorCode(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value)
    ? value.toUpperCase()
    : null;
}

function friendlyRequestError(error, action = 'request') {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return 'The local session expired. Refresh the page and try again.';
    }
    if (error.status === 409) {
      return `That ${action} is not available in the current state.`;
    }
    if (error.status === 429) {
      return 'Another operation is already in progress.';
    }
    return `The ${action} failed${error.code ? ` (${error.code})` : ''}.`;
  }
  return 'The local recovery service is unavailable. Status may be stale.';
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...options
    });
  } catch (_error) {
    throw new ApiError('NETWORK_ERROR', 0);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    throw new ApiError('INVALID_RESPONSE', response.status);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError('INVALID_RESPONSE', response.status);
  }

  if (!response.ok || payload.ok === false) {
    throw new ApiError(cleanErrorCode(payload && payload.errorCode) || 'REQUEST_FAILED', response.status);
  }

  return payload;
}

function setNotice(message, isError = false) {
  const element = isError ? els.errorBanner : els.notice;
  const other = isError ? els.notice : els.errorBanner;
  other.hidden = true;
  other.textContent = '';
  element.textContent = message;
  element.hidden = false;
}

function clearRequestError() {
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = '';
}

function stateLabel(value) {
  const state = String(value || 'unknown').toLowerCase();
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function checkpointAge(value) {
  if (value === null || value === undefined || value === '') return 'Not yet saved';
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unavailable';
  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (ageSeconds < 5) return 'Just now';
  return `${formatDurationFromSeconds(ageSeconds)} ago`;
}

function renderBenchmark(benchmark) {
  if (!benchmark || typeof benchmark !== 'object') {
    els.benchmarkSummary.textContent = 'No benchmark recorded.';
    return;
  }

  if (benchmark.running === true || benchmark.state === 'running') {
    els.benchmarkSummary.textContent = 'Benchmark in progress…';
    return;
  }

  const workers = finiteNumber(
    benchmark.selectedWorkerCount
      ?? benchmark.selectedWorkers
      ?? benchmark.workerCount
      ?? benchmark.workers,
    0
  );
  const rate = finiteNumber(benchmark.guessesPerSecond, 0);

  if (workers > 0 && rate > 0) {
    els.benchmarkSummary.textContent = `${formatNumber(workers)} worker${workers === 1 ? '' : 's'} selected at ${formatRate(rate)} checks/sec.`;
  } else if (rate > 0) {
    els.benchmarkSummary.textContent = `Measured ${formatRate(rate)} checks/sec.`;
  } else {
    els.benchmarkSummary.textContent = 'Benchmark completed; no rate was reported.';
  }
}

function renderControls() {
  const currentState = String(appState.status?.state || '').toLowerCase();
  const permitted = new Set(allowedControls[currentState] || []);
  const hasSession = typeof appState.sessionToken === 'string';
  const isReady = appState.status?.ready === true;

  Object.entries(buttons).forEach(([name, button]) => {
    let enabled = permitted.has(name) && hasSession && appState.action === null;
    if (name === 'start') enabled = enabled && isReady;
    button.disabled = !enabled;
    button.setAttribute('aria-disabled', String(!enabled));
  });

  els.controls.setAttribute('aria-busy', String(appState.action !== null));
}

function renderStatus(status) {
  appState.status = status;

  const suppliedState = typeof status.state === 'string' ? status.state.toLowerCase() : '';
  const state = Object.hasOwn(allowedControls, suppliedState) ? suppliedState : 'unknown';
  const ready = status.ready === true;
  const rawCount = Math.max(0, finiteNumber(status.rawCandidateCount));
  const uniqueCount = Math.max(0, finiteNumber(status.uniqueCandidateCount));
  const duplicates = Math.max(0, finiteNumber(status.duplicatesRemoved, rawCount - uniqueCount));
  const verified = Math.max(0, finiteNumber(status.totalVerified));
  const percent = Math.min(100, Math.max(0, finiteNumber(
    status.completionPercent,
    uniqueCount > 0 ? (verified / uniqueCount) * 100 : 0
  )));
  const errorCode = cleanErrorCode(status.errorCode);
  const jobId = typeof status.jobId === 'string' && /^[a-f0-9]{64}$/i.test(status.jobId)
    ? status.jobId
    : 'Not configured';

  els.stateValue.textContent = stateLabel(state);
  els.stateValue.dataset.state = state;
  els.modeValue.textContent = status.mode === 'REAL' || status.mode === 'DEMO' ? status.mode : '—';
  els.readinessBadge.textContent = ready ? 'Ready' : 'Not ready';
  els.readinessBadge.className = `badge ${ready ? 'badge-ready' : 'badge-muted'}`;
  els.readyValue.textContent = ready ? 'Ready to run' : 'Configuration required';
  els.jobIdValue.textContent = jobId;
  els.jobIdValue.title = jobId;

  els.completeValue.textContent = `${percent.toFixed(2)}%`;
  els.progressBar.style.width = `${percent}%`;
  els.progressTrack.setAttribute('aria-valuenow', percent.toFixed(2));
  els.progressTrack.setAttribute('aria-valuetext', `${percent.toFixed(2)} percent complete`);
  els.verifiedValue.textContent = formatNumber(verified);
  els.uniqueTotalValue.textContent = formatNumber(uniqueCount);

  els.rawCountValue.textContent = formatNumber(rawCount);
  els.uniqueCountValue.textContent = formatNumber(uniqueCount);
  els.duplicatesValue.textContent = formatNumber(duplicates);
  els.nextIndexValue.textContent = formatNumber(status.nextCandidateIndex);
  els.workersValue.textContent = formatNumber(status.activeWorkers);
  els.rateValue.textContent = `${formatRate(status.guessesPerSecond)}/sec`;
  els.hourlyRateValue.textContent = `${formatNumber(status.guessesPerHour)}/hour`;
  els.elapsedValue.textContent = formatDurationFromMilliseconds(status.activeElapsedMs);
  els.etaValue.textContent = status.estimatedSecondsRemaining === null || status.estimatedSecondsRemaining === undefined
    ? 'Calculating…'
    : formatDurationFromSeconds(status.estimatedSecondsRemaining);
  els.checkpointValue.textContent = checkpointAge(status.lastCheckpointAt);
  els.matchValue.textContent = status.matchFound === true ? 'Found — use terminal' : 'Not found';
  els.matchValue.classList.toggle('success-text', status.matchFound === true);
  els.errorValue.textContent = errorCode || 'None';
  els.errorValue.classList.toggle('error-text', Boolean(errorCode));

  renderBenchmark(status.benchmark);
  renderControls();
}

async function loadSession() {
  const payload = await requestJson('/api/session');
  if (typeof payload.token !== 'string' || payload.token.length === 0) {
    throw new ApiError('INVALID_SESSION', 0);
  }
  appState.sessionToken = payload.token;
}

async function refreshStatus({ announceErrors = true } = {}) {
  if (appState.polling) return;
  appState.polling = true;
  try {
    const status = await requestJson('/api/status');
    renderStatus(status);
    if (appState.statusRequestFailed) {
      appState.statusRequestFailed = false;
      clearRequestError();
    }
  } catch (error) {
    if (announceErrors && appState.sessionToken !== null) {
      appState.statusRequestFailed = true;
      setNotice(friendlyRequestError(error, 'status request'), true);
    }
    renderControls();
  } finally {
    appState.polling = false;
  }
}

function schedulePoll() {
  window.clearTimeout(appState.pollTimer);
  const delay = document.hidden ? BACKGROUND_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
  appState.pollTimer = window.setTimeout(async () => {
    await refreshStatus();
    schedulePoll();
  }, delay);
}

async function runAction(action) {
  if (appState.action !== null || !appState.sessionToken) return;
  appState.action = action;
  appState.statusRequestFailed = false;
  renderControls();

  try {
    await requestJson(`/api/${action === 'benchmark' ? 'benchmark' : `recovery/${action}`}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Recovery-Session': appState.sessionToken
      },
      body: '{}'
    });
    setNotice(action === 'benchmark' ? 'Benchmark completed.' : `${stateLabel(action)} request completed.`);
    await refreshStatus({ announceErrors: false });
  } catch (error) {
    setNotice(friendlyRequestError(error, action), true);
  } finally {
    appState.action = null;
    renderControls();
  }
}

Object.entries(buttons).forEach(([action, button]) => {
  button.addEventListener('click', () => runAction(action));
});

document.addEventListener('visibilitychange', schedulePoll);

async function initialize() {
  renderControls();
  try {
    await loadSession();
  } catch (error) {
    setNotice(friendlyRequestError(error, 'session request'), true);
  }
  await refreshStatus({ announceErrors: appState.sessionToken !== null });
  schedulePoll();
}

initialize();
