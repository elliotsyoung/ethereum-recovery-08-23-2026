'use strict';

const POLL_INTERVAL_MS = 1000;
const BACKGROUND_POLL_INTERVAL_MS = 3000;
const DEFAULT_SYMBOLS = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).filter((character) => !/[A-Za-z0-9]/.test(character)).join('');
const NUMBER_ROW_SYMBOLS = '!@#$%^&*()';
const SHIFT_15_SYMBOLS = '!@#$%';
const SYMBOL_PRESETS = { numberRow: NUMBER_ROW_SYMBOLS, shift15: SHIFT_15_SYMBOLS, all: DEFAULT_SYMBOLS };
const DEFAULT_RULES = {
  searchMode: 'mask', masks: [], word1: [], word2: [], minLength: 11, maxLength: 64,
  minDigits: 0, maxDigits: 12, minSymbols: 0, maxSymbols: 12,
  symbols: DEFAULT_SYMBOLS, caseStyles: ['title', 'lower', 'upper', 'none'],
  layouts: ['suffix', 'between', 'split'], digitMode: 'all', symbolMode: 'all',
  word1MinLen: 1, word1MaxLen: 32, word2MinLen: 1, word2MaxLen: 32,
  digitMin: 0, digitMax: null, requireDistinctWords: false
};
const LAYOUTS = [
  ['suffix', 'Fragment + Fragment + digits + symbols'],
  ['between', 'Fragment + digits + Fragment + symbols'],
  ['split', 'Fragment + digits + Fragment + digits + symbols']
];
const appState = {
  sessionToken: null, status: null, pollTimer: null, polling: false,
  statusRequestFailed: false, action: null, setupEnabled: false,
  configured: false, editing: true, previewKey: null, preview: null, savedJobAvailable: false,
  previewTimer: null, previewSequence: 0, previewPending: false, filterKey: null
};
const byId = (id) => document.getElementById(id);
const els = Object.fromEntries([
  'connectionValue', 'notice', 'errorBanner', 'stateValue', 'modeValue', 'setupPanel',
  'setupForm', 'setupFields', 'setupSummary', 'toggleSetupBtn', 'savedSetup', 'restoreBtn',
  'modeInput', 'walletInput', 'walletField', 'demoHelp', 'rulesFields',
  'firstWordsInput', 'secondWordsInput', 'minLengthInput', 'maxLengthInput',
  'minDigitsInput', 'maxDigitsInput', 'minSymbolsInput', 'maxSymbolsInput',
  'symbolsInput', 'digitModeInput', 'symbolModeInput', 'caseOptions', 'layoutOptions',
  'word1MinLenInput', 'word1MaxLenInput', 'word2MinLenInput', 'word2MaxLenInput',
  'digitMinInput', 'digitMaxInput', 'symbolPresetInput', 'requireDistinctInput',
  'searchModeInput', 'masksInput', 'maskFields', 'fragmentFields', 'broadenBtn',
  'legacyNotice', 'memoryNotesInput', 'previewDuration', 'estimateScenarios',
  'measurementHelp', 'measureBtn', 'coveragePanel', 'coverageList', 'coverageConfirm',
  'questionSuggestions', 'suggestionList', 'reusedValue',
  'previewPanel', 'previewCount', 'previewDetails', 'previewWarnings', 'previewBtn',
  'configureBtn', 'setupHint', 'progressPanel', 'progressHeading', 'readinessBadge',
  'resultBanner', 'verifiedValue', 'remainingValue', 'completeValue', 'uniqueTotalValue',
  'progressTrack', 'progressBar', 'rateValue', 'elapsedValue', 'etaValue', 'finishValue',
  'etaHelp', 'controlHelp', 'controls', 'startBtn', 'pauseBtn', 'resumeBtn', 'stopBtn',
  'benchmarkBtn', 'detailsPanel', 'workersValue', 'benchmarkSummary', 'jobIdValue',
  'checkpointValue', 'uniqueCountValue', 'duplicatesValue', 'nextIndexValue',
  'attemptsValue', 'errorValue', 'restartRow', 'restartBtn'
].map((id) => [id, byId(id)]));
const buttons = {
  start: els.startBtn, pause: els.pauseBtn, resume: els.resumeBtn,
  stop: els.stopBtn, benchmark: els.benchmarkBtn
};
const allowedControls = {
  ready: ['start', 'benchmark'], running: ['pause', 'stop'], paused: ['resume', 'stop'],
  interrupted: ['resume', 'stop', 'benchmark'], stopped: ['start', 'benchmark'],
  exhausted: [], found: [], failed: []
};
const errorMessages = {
  WALLET_FILE_NOT_FOUND: 'The wallet file could not be found. Check its absolute path.',
  WALLET_NOT_FOUND: 'The wallet file could not be found. Check its absolute path.',
  WALLET_FILE_PERMISSIONS_MUST_BE_PRIVATE: 'The keystore needs owner-only permissions. In your terminal, run chmod 600 followed by its quoted file path.',
  WALLET_PERMISSIONS_MUST_BE_PRIVATE: 'The keystore needs owner-only permissions. In your terminal, run chmod 600 followed by its quoted file path.',
  REAL_WALLET_ABSOLUTE_PATH_REQUIRED: 'Enter an absolute path to your wallet JSON file.',
  JOB_ALREADY_RUNNING: 'This search is already open in another recovery process. Close that process first.',
  NO_SAVED_SETUP: 'There is no saved search to restore yet.',
  CANDIDATE_SPACE_EMPTY: 'These rules produce no passwords. Check the length range and selected layouts.',
  CANDIDATE_SPACE_TOO_LARGE: 'This selection exceeds the search limit. Keep unknowns open and add only information you can confidently remember.',
  EMPTY_CANDIDATE_SPACE: 'These rules produce no passwords. Check the length range and selected layouts.',
  SETUP_BUSY: 'Search preparation is already in progress.',
  SETUP_REQUIRES_IDLE: 'Pause or stop the current recovery before changing its setup.'
};

class ApiError extends Error {
  constructor(code, status, userMessage = null) { super(code); this.code = code; this.status = status; this.userMessage = userMessage; }
}
function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
function formatNumber(value, maximumFractionDigits = 0) {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toLocaleString();
  return number(value).toLocaleString(undefined, { maximumFractionDigits });
}
function formatRate(value) {
  const rate = Math.max(0, number(value));
  return formatNumber(rate, rate > 0 && rate < 10 ? 2 : rate < 100 ? 1 : 0);
}
function duration(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Calculating…';
  let seconds = Math.max(0, Math.floor(Number(value)));
  const years = Math.floor(seconds / 31557600);
  if (years >= 1e9) return `≈ ${years.toExponential(2)} years`;
  if (years > 0) return `≈ ${formatNumber(years)} ${years === 1 ? 'year' : 'years'}`;
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  if (days > 0) return `${formatNumber(days)}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
function cleanErrorCode(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,100}$/i.test(value) ? value.toUpperCase() : null;
}
function friendlyError(error, action = 'request') {
  if (!(error instanceof ApiError) || error.status === 0) return 'The local recovery service is unavailable. Keep its terminal running, then reconnect or refresh.';
  if (error.userMessage) return error.userMessage;
  if (errorMessages[error.code]) return errorMessages[error.code];
  if (error.status === 401 || error.status === 403) return 'The local session expired. Refresh this page and try again.';
  if (error.status === 409) return `That ${action} is not available while another operation or recovery is active.`;
  if (error.status === 429) return 'Another operation is in progress. Its status will update here.';
  if (/EMPTY|WORDS_REQUIRED/.test(error.code)) return 'Enter at least one first-word possibility and check that the rules allow a password.';
  if (/TOO_LARGE|LIMIT|OVERFLOW/.test(error.code)) return `The search exceeds a supported limit. Narrow the word lists or number and symbol ranges. (${error.code})`;
  return `The ${action} could not be completed${error.code ? ` (${error.code})` : ''}. Check your inputs and try again.`;
}
async function requestJson(url, options = {}) {
  let response;
  try { response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options }); }
  catch { throw new ApiError('NETWORK_ERROR', 0); }
  let payload;
  try { payload = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', response.status); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError('INVALID_RESPONSE', response.status);
  if (!response.ok || payload.ok === false) {
    const userMessage = typeof payload.message === 'string' && payload.message.length <= 1000 ? payload.message : null;
    throw new ApiError(cleanErrorCode(payload.errorCode) || 'REQUEST_FAILED', response.status, userMessage);
  }
  return payload;
}
function post(url, body = {}) {
  return requestJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Recovery-Session': appState.sessionToken },
    body: JSON.stringify(body)
  });
}
function notice(message, isError = false) {
  const element = isError ? els.errorBanner : els.notice;
  const other = isError ? els.notice : els.errorBanner;
  other.hidden = true; other.textContent = '';
  element.textContent = message; element.hidden = false;
}
function clearNotices() {
  for (const element of [els.notice, els.errorBanner]) { element.hidden = true; element.textContent = ''; }
}
function setConnected(connected) {
  els.connectionValue.dataset.connected = String(connected);
  els.connectionValue.replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot'; dot.setAttribute('aria-hidden', 'true');
  els.connectionValue.append(dot, document.createTextNode(connected ? 'Local service connected' : 'Connection lost'));
}
function titleCase(value) { return String(value || '').replace(/^./, (letter) => letter.toUpperCase()); }
function checkpointAge(value) {
  if (value === null || value === undefined) return 'Not yet saved';
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unavailable';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  return seconds < 5 ? 'Just saved' : `${duration(seconds)} ago`;
}
function renderLayouts(selected) {
  els.layoutOptions.replaceChildren();
  for (const [value, label] of LAYOUTS) {
    const element = document.createElement('label');
    const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'layout'; input.value = value; input.checked = selected.includes(value);
    element.append(input, document.createTextNode(label)); els.layoutOptions.append(element);
  }
}
function symbolPresetFor(symbols) {
  const normalized = [...new Set(String(symbols || ''))].sort().join('');
  for (const [name, value] of Object.entries(SYMBOL_PRESETS)) {
    if ([...value].sort().join('') === normalized) return name;
  }
  return 'custom';
}
function syncSymbolPreset(symbols) { els.symbolPresetInput.value = symbolPresetFor(symbols); }
function applyDefaults(defaults = {}) {
  const rules = { ...DEFAULT_RULES, ...defaults.fragmentRules, ...defaults.rules };
  const legacy = Boolean(defaults.rules && !defaults.rules.searchMode);
  els.modeInput.value = defaults.mode === 'DEMO' ? 'DEMO' : 'REAL';
  els.walletInput.value = defaults.walletPath || '';
  els.searchModeInput.value = legacy ? 'fragments' : rules.searchMode;
  els.legacyNotice.hidden = !legacy || defaults.mode === 'DEMO';
  const wordText = (value) => Array.isArray(value) ? value.join('\n') : String(value || '');
  els.masksInput.value = wordText(rules.masks || rules.mask);
  els.firstWordsInput.value = wordText(rules.word1); els.secondWordsInput.value = wordText(rules.word2);
  for (const field of ['minLength', 'maxLength', 'minDigits', 'maxDigits', 'minSymbols', 'maxSymbols', 'symbols', 'digitMode', 'symbolMode', 'word1MinLen', 'word1MaxLen', 'word2MinLen', 'word2MaxLen', 'digitMin']) els[`${field}Input`].value = rules[field];
  els.digitMaxInput.value = rules.digitMax === null || rules.digitMax === undefined ? '' : rules.digitMax;
  els.requireDistinctInput.checked = Boolean(rules.requireDistinctWords);
  syncSymbolPreset(rules.symbols);
  for (const input of els.caseOptions.querySelectorAll('input')) input.checked = rules.caseStyles.includes(input.value);
  renderLayouts(rules.layouts); renderMode();
}
function renderMode() {
  const demo = els.modeInput.value === 'DEMO';
  const fragments = els.searchModeInput.value === 'fragments';
  els.walletField.hidden = demo; els.demoHelp.hidden = !demo; els.rulesFields.hidden = demo;
  els.walletInput.required = false; els.firstWordsInput.required = !demo && fragments;
  for (const input of els.rulesFields.querySelectorAll('input, textarea, select')) input.disabled = demo;
  els.fragmentFields.hidden = !fragments; els.maskFields.hidden = fragments;
  for (const input of els.fragmentFields.querySelectorAll('input, textarea, select')) input.disabled = demo || !fragments;
  for (const input of els.maskFields.querySelectorAll('input, textarea, select')) input.disabled = demo || fragments;
  els.coveragePanel.hidden = demo; els.measureBtn.hidden = demo;
}
function readSetup() {
  let rules;
  if (els.searchModeInput.value === 'mask') {
    rules = {
      searchMode: 'mask', masks: els.masksInput.value.split(/\r?\n/).filter((line) => line.length),
      minLength: Number(els.minLengthInput.value), maxLength: Number(els.maxLengthInput.value)
    };
  } else {
    rules = {
      searchMode: 'fragments', word1: els.firstWordsInput.value, word2: els.secondWordsInput.value,
      symbols: els.symbolsInput.value,
      caseStyles: [...els.caseOptions.querySelectorAll('input:checked')].map((input) => input.value),
      layouts: [...els.layoutOptions.querySelectorAll('input:checked')].map((input) => input.value),
      digitMode: els.digitModeInput.value, symbolMode: els.symbolModeInput.value,
      requireDistinctWords: els.requireDistinctInput.checked
    };
    for (const field of ['minLength', 'maxLength', 'minDigits', 'maxDigits', 'minSymbols', 'maxSymbols', 'word1MinLen', 'word1MaxLen', 'word2MinLen', 'word2MaxLen', 'digitMin']) rules[field] = Number(els[`${field}Input`].value);
    const digitMaxRaw = els.digitMaxInput.value.trim();
    rules.digitMax = digitMaxRaw === '' ? null : Number(digitMaxRaw);
  }
  return { mode: els.modeInput.value, walletPath: els.walletInput.value.trim(), rules };
}
function validateForm() {
  if (!els.setupForm.reportValidity()) return false;
  if (els.modeInput.value === 'DEMO') return true;
  const { rules } = readSetup();
  if (!Number.isInteger(rules.minLength) || rules.minLength < 11 || rules.maxLength > 64 || rules.minLength > rules.maxLength) {
    notice('Choose a password length range within 11–64 characters.', true); return false;
  }
  if (rules.searchMode === 'mask') return true;
  for (const [minimum, maximum, label] of [['minDigits', 'maxDigits', 'digit count'], ['minSymbols', 'maxSymbols', 'symbol count'], ['word1MinLen', 'word1MaxLen', 'first fragment length'], ['word2MinLen', 'word2MaxLen', 'second fragment length']]) {
    if (rules[minimum] > rules[maximum]) { notice(`The minimum ${label} cannot exceed its maximum.`, true); return false; }
  }
  if (rules.digitMax !== null && rules.digitMin > rules.digitMax) { notice('The smallest digit value cannot exceed the largest.', true); return false; }
  if (!rules.caseStyles.length || !rules.layouts.length) { notice('Select at least one capitalization style and one placement layout.', true); return false; }
  return true;
}
function invalidatePreview(event) {
  if (event?.target === els.memoryNotesInput) return;
  if (event?.target === els.coverageConfirm) { renderControls(); return; }
  const filterKey = JSON.stringify(readSetup());
  // Text controls emit change on blur after their input event was already
  // previewed. That same selection must not clear a newly reviewed checkbox.
  if (event?.target && filterKey === appState.filterKey) return;
  appState.filterKey = filterKey;
  appState.previewKey = null; appState.preview = null; appState.previewSequence += 1; appState.previewPending = false;
  els.coverageConfirm.checked = false; els.previewPanel.hidden = true;
  window.clearTimeout(appState.previewTimer);
  appState.previewTimer = window.setTimeout(() => { void previewSearch({ automatic: true }); }, 500);
  renderControls();
}
function renderPreview(preview) {
  appState.preview = preview;
  els.previewPanel.hidden = false;
  els.previewCount.textContent = formatNumber(preview.candidateCountExact ?? preview.uniqueCandidateCount);
  const duplicateCount = number(preview.duplicatesRemoved);
  els.previewDetails.textContent = `${duplicateCount > 0 ? `${formatNumber(duplicateCount)} duplicate passwords removed. ` : ''}Full selected search before reuse of completed checks. A match could appear sooner; this is not a prediction of when it will appear.`;
  const estimate = preview.estimate || {};
  const measured = estimate.source === 'measured' && number(estimate.guessesPerSecond) > 0;
  els.previewDuration.textContent = measured
    ? `${duration(estimate.seconds)} for the full search at ${formatRate(estimate.guessesPerSecond)} checks/sec`
    : 'Measure your wallet to estimate the time on this machine.';
  els.measurementHelp.textContent = measured
    ? 'Based on this wallet’s measured verification speed. Machine load, reuse lookups, and future changes can affect duration.'
    : 'Illustrative rates below show scale only. They are not a forecast for your wallet.';
  els.estimateScenarios.replaceChildren();
  if (!measured) {
    for (const scenario of Array.isArray(estimate.scenarios) ? estimate.scenarios : []) {
      const item = document.createElement('p');
      item.textContent = `If ${formatRate(scenario.guessesPerSecond)} checks/sec: ${duration(scenario.seconds)}`;
      els.estimateScenarios.append(item);
    }
  }
  els.previewWarnings.replaceChildren();
  const warnings = Array.isArray(preview.warnings) ? preview.warnings.filter((item) => typeof item === 'string') : [];
  if (preview.runnable === false) warnings.unshift('This search cannot be started within the supported candidate limit. More reliable information is needed; do not remove uncertain possibilities just to make the number smaller.');
  for (const warning of warnings) { const item = document.createElement('li'); item.textContent = warning; els.previewWarnings.append(item); }
  els.previewWarnings.hidden = !warnings.length;
  els.coverageList.replaceChildren();
  const coverage = Array.isArray(preview.coverage) ? preview.coverage : ['Only the patterns, lengths, character choices, and arrangements selected above are included.'];
  for (const text of coverage) {
    if (typeof text !== 'string') continue;
    const item = document.createElement('li'); item.textContent = text; els.coverageList.append(item);
  }
  els.suggestionList.replaceChildren();
  for (const question of Array.isArray(preview.questions) ? preview.questions : []) {
    if (typeof question.prompt !== 'string') continue;
    const item = document.createElement('li'); const prompt = document.createElement('strong'); prompt.textContent = question.prompt;
    const reason = document.createElement('p'); reason.textContent = question.reason || '';
    item.append(prompt, reason); els.suggestionList.append(item);
  }
  els.questionSuggestions.hidden = !els.suggestionList.children.length;
}
async function previewSearch({ automatic = false } = {}) {
  if (!appState.sessionToken || busy() || !appState.editing) return;
  if (!automatic && !validateForm()) return;
  const setup = readSetup(); const key = JSON.stringify(setup);
  window.clearTimeout(appState.previewTimer);
  appState.filterKey = key;
  const sequence = ++appState.previewSequence;
  appState.previewPending = true; appState.previewKey = null; els.coverageConfirm.checked = false;
  renderControls();
  try {
    const result = await post('/api/setup/preview', setup);
    if (sequence !== appState.previewSequence || key !== JSON.stringify(readSetup())) return;
    renderPreview(result.preview); appState.previewKey = key;
  } catch (error) {
    if (sequence !== appState.previewSequence || key !== JSON.stringify(readSetup())) return;
    appState.preview = null; els.previewPanel.hidden = false;
    els.previewCount.textContent = 'Check the settings';
    els.previewDetails.textContent = friendlyError(error, 'search preview');
    els.previewDuration.textContent = ''; els.estimateScenarios.replaceChildren();
    els.previewWarnings.hidden = true; els.questionSuggestions.hidden = true; els.coverageList.replaceChildren();
    if (!automatic) notice(friendlyError(error, 'search preview'), true);
  } finally {
    if (sequence === appState.previewSequence) appState.previewPending = false;
    renderControls();
  }
}
function busy() { return Boolean(appState.action || appState.status?.operationInProgress || appState.status?.state === 'preparing'); }
function renderControls() {
  const state = String(appState.status?.state || 'setup');
  const permitted = new Set(allowedControls[state] || []);
  const connected = Boolean(appState.sessionToken) && !appState.statusRequestFailed;
  for (const [action, button] of Object.entries(buttons)) {
    button.hidden = !permitted.has(action);
    button.disabled = !connected || busy() || (action === 'start' && appState.status?.ready !== true);
  }
  els.controls.setAttribute('aria-busy', String(busy()));
  const canEdit = state !== 'running' && !busy() && connected;
  els.toggleSetupBtn.hidden = !appState.configured;
  els.toggleSetupBtn.disabled = !canEdit;
  els.toggleSetupBtn.textContent = appState.editing ? 'Close setup' : 'Edit search';
  els.setupFields.disabled = !canEdit;
  els.previewBtn.disabled = !canEdit;
  const coverageReady = els.modeInput.value === 'DEMO' || (appState.previewKey === JSON.stringify(readSetup()) && appState.preview?.runnable !== false && els.coverageConfirm.checked);
  els.configureBtn.disabled = !canEdit || !coverageReady;
  els.measureBtn.disabled = !canEdit || els.modeInput.value === 'DEMO' || !els.walletInput.value.trim();
  els.restoreBtn.disabled = !connected || busy();
  els.restartRow.hidden = !appState.setupEnabled || !appState.configured;
  els.restartBtn.disabled = !canEdit;
  els.restartBtn.textContent = appState.action === 'restart' ? 'Resetting…' : 'Restart from zero';
  els.configureBtn.textContent = appState.action === 'configure' || state === 'preparing' ? 'Preparing…' : 'Prepare search →';
  els.previewBtn.textContent = appState.previewPending ? 'Updating estimate…' : 'Update estimate';
  els.measureBtn.textContent = appState.action === 'measure' ? 'Measuring wallet…' : 'Measure wallet speed';
  els.restoreBtn.textContent = appState.action === 'restore' ? 'Restoring…' : 'Restore last search';
  const preparation = state === 'preparing' || ['configure', 'restore'].includes(appState.action);
  els.setupHint.textContent = preparation
    ? `${appState.status?.setupPhase || 'Preparing your search'}… This may take a moment while wallet speed is measured.`
    : appState.preview?.runnable === false ? 'Keep uncertain possibilities open. The questions above may help you remember useful limits.'
      : 'The estimate updates as you answer. Review coverage and select the checkbox before preparing.';
}
function renderSetup() {
  els.setupPanel.hidden = !appState.setupEnabled;
  els.setupForm.hidden = appState.configured && !appState.editing;
  els.setupSummary.hidden = !appState.configured || appState.editing;
  els.setupSummary.textContent = `${appState.status?.mode === 'DEMO' ? 'Demo wallet' : 'Wallet configured'} · ${formatNumber(appState.status?.uniqueCandidateCount)} passwords in this search. Your settings and progress are saved locally.`;
  els.savedSetup.hidden = !appState.savedJobAvailable || appState.configured;
  renderControls();
}
function renderBenchmark(status) {
  const benchmark = status.benchmark;
  if (status.operationInProgress === 'benchmark' || benchmark?.running || benchmark?.state === 'running') {
    els.benchmarkSummary.textContent = 'Measuring your wallet’s encryption cost to choose the fastest worker count…'; return;
  }
  const workerCount = number(benchmark?.selectedWorkerCount ?? benchmark?.selectedWorkers ?? benchmark?.workerCount ?? status.selectedWorkers ?? status.activeWorkers);
  const rate = number(benchmark?.guessesPerSecond);
  els.benchmarkSummary.textContent = rate > 0
    ? `${formatNumber(workerCount)} worker${workerCount === 1 ? '' : 's'} selected · ${formatRate(rate)} passwords/sec measured on this wallet. Running speed varies with system load.`
    : 'Speed is based on this wallet’s encryption cost and your machine. Running speed varies with system load.';
}
function renderResult(status) {
  const state = status.state;
  els.resultBanner.hidden = !['found', 'exhausted', 'failed'].includes(state);
  if (els.resultBanner.dataset.state === state && els.resultBanner.dataset.job === status.jobId
      && els.resultBanner.dataset.command === String(status.revealCommand || '')) return;
  els.resultBanner.dataset.state = state; els.resultBanner.dataset.job = status.jobId || '';
  els.resultBanner.dataset.command = String(status.revealCommand || '');
  els.resultBanner.replaceChildren();
  if (state === 'found') {
    const text = document.createElement('p'); text.textContent = 'Password found and verified. Reveal it in the terminal with this command:';
    const command = document.createElement('code');
    command.textContent = typeof status.revealCommand === 'string' ? status.revealCommand : `npm run reveal -- --job ${status.jobId}`;
    const help = document.createElement('p'); help.textContent = 'The password stays out of the dashboard. Keep the reveal output private.';
    els.resultBanner.append(text, command, help);
  } else if (state === 'exhausted') {
    els.resultBanner.textContent = 'Every candidate in this selection was covered with no match. Review the exclusions and add other patterns, spelling variants, positions, or broader character choices. Completed checks can be reused in the next search.';
  } else if (state === 'failed') {
    els.resultBanner.textContent = 'Recovery stopped after an error. Your last saved position is kept. Check the error below and the local terminal before retrying.';
  }
}
function renderStatus(status) {
  appState.status = status;
  appState.configured = Boolean(status.jobId && status.state !== 'preparing');
  const state = String(status.state || 'setup');
  const configured = Boolean(status.jobId);
  const matchConfirming = state === 'running' && status.matchConfirming;
  els.progressPanel.hidden = !configured; els.detailsPanel.hidden = !configured;
  els.stateValue.textContent = matchConfirming ? 'Confirming match' : state === 'setup' ? 'Set up a search' : state === 'preparing' ? 'Preparing search' : titleCase(state);
  els.stateValue.dataset.state = state;
  els.modeValue.hidden = !configured; els.modeValue.textContent = status.mode === 'DEMO' ? 'Demo' : 'Real wallet';
  els.readinessBadge.textContent = status.operationInProgress === 'benchmark' ? 'Measuring speed' : matchConfirming ? 'Verifying match' : titleCase(state);
  els.readinessBadge.dataset.state = state;
  const headings = { ready: 'Ready when you are.', running: 'Checking possibilities.', paused: 'Progress saved. Take your time.', stopped: 'Stopped. Progress saved.', interrupted: 'Pick up where you left off.', found: 'A match. Verified.', exhausted: 'Selected search checked.', failed: 'Recovery needs attention.' };
  els.progressHeading.textContent = headings[state] || 'Preparing your search.';
  const total = Math.max(0, number(status.uniqueCandidateCount));
  const searched = Math.max(0, number(status.searchedCandidateCount ?? status.nextCandidateIndex ?? status.totalVerified));
  const remaining = Math.max(0, number(status.remainingCandidateCount, total - searched));
  const percent = Math.min(100, Math.max(0, number(status.completionPercent, total ? searched / total * 100 : 0)));
  els.verifiedValue.textContent = formatNumber(searched); els.remainingValue.textContent = formatNumber(remaining);
  els.uniqueTotalValue.textContent = formatNumber(total); els.uniqueCountValue.textContent = formatNumber(total);
  els.completeValue.textContent = `${percent.toFixed(percent > 0 && percent < .01 ? 4 : 2)}%`;
  els.progressBar.style.width = `${percent}%`;
  els.progressTrack.setAttribute('aria-valuenow', String(percent));
  els.progressTrack.setAttribute('aria-valuetext', `${formatNumber(searched)} of ${formatNumber(total)} passwords searched`);
  els.rateValue.textContent = status.guessesPerSecond > 0 ? formatRate(status.guessesPerSecond) : state === 'running' ? 'Measuring…' : '—';
  els.elapsedValue.textContent = duration(number(status.activeElapsedMs) / 1000);
  const finished = state === 'found' || state === 'exhausted';
  const eta = status.estimatedSecondsRemaining;
  els.etaValue.textContent = finished ? 'Complete' : duration(eta);
  const finishTimestamp = eta === null || eta === undefined ? NaN : Date.now() + number(eta) * 1000;
  if (state === 'running' && Number.isFinite(finishTimestamp) && finishTimestamp < 8.64e15) {
    const date = new Date(finishTimestamp);
    els.finishValue.textContent = date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(eta > 31557600 ? { year: 'numeric' } : {}) });
  } else els.finishValue.textContent = state === 'running' && eta !== null && eta !== undefined ? 'Beyond date range' : finished ? 'Complete' : ['paused', 'stopped', 'interrupted'].includes(state) ? 'When resumed' : 'After starting';
  const source = status.estimateSource === 'benchmark' ? 'Based on the wallet speed benchmark' : status.estimateSource === 'average' ? 'Based on average active speed' : 'Based on recent speed';
  els.etaHelp.textContent = `${source}. Time left is a rough estimate for the full remaining search; a match may appear sooner. Paused and offline time are excluded.`;
  els.nextIndexValue.textContent = formatNumber(status.nextCandidateIndex);
  els.attemptsValue.textContent = formatNumber(status.totalVerified);
  els.reusedValue.textContent = formatNumber(status.reusedCandidateCount ?? status.reusedCount ?? 0);
  els.duplicatesValue.textContent = formatNumber(status.duplicatesRemoved);
  els.workersValue.textContent = `${formatNumber(status.activeWorkers)} active worker${status.activeWorkers === 1 ? '' : 's'}`;
  els.jobIdValue.textContent = typeof status.jobId === 'string' ? status.jobId : '—';
  els.checkpointValue.textContent = checkpointAge(status.lastCheckpointAt);
  els.errorValue.textContent = cleanErrorCode(status.errorCode) || 'None';
  els.controlHelp.textContent = status.operationInProgress
    ? `${titleCase(status.operationInProgress)} in progress. Controls will be available when it finishes.`
    : 'Pausing or stopping saves progress. After an interruption, unfinished checks may safely repeat.';
  renderBenchmark(status); renderResult(status); renderSetup();
}
async function refreshStatus({ announceErrors = true } = {}) {
  if (appState.polling) return;
  appState.polling = true;
  try {
    const status = await requestJson('/api/status');
    const recoveringConnection = appState.statusRequestFailed;
    appState.statusRequestFailed = false; setConnected(true); renderStatus(status);
    if (recoveringConnection) clearNotices();
  } catch (error) {
    appState.statusRequestFailed = true; setConnected(false);
    if (announceErrors) notice(friendlyError(error, 'status request'), true);
    renderControls();
  } finally { appState.polling = false; }
}
function schedulePoll() {
  window.clearTimeout(appState.pollTimer);
  appState.pollTimer = window.setTimeout(async () => { await refreshStatus(); schedulePoll(); }, document.hidden ? BACKGROUND_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
}
async function setupAction(action) {
  if (action === 'preview') return previewSearch();
  if (busy() || !appState.sessionToken) return;
  if (action === 'configure' && !validateForm()) return;
  const setup = readSetup();
  if (action === 'configure' && setup.mode !== 'DEMO') {
    if (appState.previewKey !== JSON.stringify(setup) || !els.coverageConfirm.checked || appState.preview?.runnable === false) {
      notice('Review the current estimate and coverage, then select the coverage checkbox before preparing.', true); return;
    }
    setup.coverageAcknowledged = true;
  }
  appState.action = action; clearNotices(); renderControls();
  try {
    const body = ['restore', 'restart'].includes(action) ? {} : action === 'measure' ? { mode: setup.mode, walletPath: setup.walletPath } : setup;
    const result = await post(`/api/setup/${action}`, body);
    if (action === 'measure') {
      notice(`Wallet speed measured at ${formatRate(result.measurement?.guessesPerSecond)} checks/sec. The estimate below uses this measurement.`);
    } else {
      appState.editing = false; appState.savedJobAvailable = true;
      if (result.status) renderStatus(result.status);
      notice(action === 'restart' ? 'Search position reset. The previous checkpoint is archived. Completed checks remain reusable.' : result.status?.state === 'found' ? 'This saved search already found a match. See the reveal command below.' : 'Search prepared. Review the estimate, then start or resume recovery.');
      els.progressPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) { notice(friendlyError(error, action === 'measure' ? 'wallet measurement' : 'search preparation'), true); }
  finally {
    appState.action = null; await refreshStatus({ announceErrors: false }); renderSetup();
    if (action === 'measure') await previewSearch({ automatic: true });
  }
}
async function runAction(action) {
  if (busy() || !appState.sessionToken) return;
  appState.action = action; clearNotices(); renderControls();
  try {
    const result = await post(`/api/${action === 'benchmark' ? 'benchmark' : `recovery/${action}`}`);
    if (result.status) renderStatus(result.status);
    const messages = { pause: 'Paused. Your progress is saved.', stop: 'Stopped. Your progress is saved.', benchmark: 'Speed measurement complete.' };
    if (messages[action]) notice(messages[action]);
  } catch (error) { notice(friendlyError(error, action), true); }
  finally { appState.action = null; await refreshStatus({ announceErrors: false }); renderControls(); }
}
for (const [action, button] of Object.entries(buttons)) button.addEventListener('click', () => runAction(action));
els.previewBtn.addEventListener('click', () => setupAction('preview'));
els.setupForm.addEventListener('submit', (event) => { event.preventDefault(); void setupAction('configure'); });
els.restoreBtn.addEventListener('click', () => setupAction('restore'));
els.toggleSetupBtn.addEventListener('click', async () => {
  if (busy()) return;
  if (appState.editing) { appState.editing = false; renderSetup(); return; }
  appState.action = 'edit'; renderControls();
  try {
    const result = await post('/api/setup/current');
    applyDefaults(result.selection); invalidatePreview(); appState.editing = true;
  } catch (error) { notice(friendlyError(error, 'load settings'), true); }
  finally { appState.action = null; renderSetup(); }
});
els.restartBtn.addEventListener('click', () => setupAction('restart'));
els.measureBtn.addEventListener('click', () => setupAction('measure'));
els.coverageConfirm.addEventListener('change', renderControls);
els.broadenBtn.addEventListener('click', () => {
  if (busy()) return;
  const mode = els.modeInput.value; const walletPath = els.walletInput.value;
  applyDefaults({ mode, walletPath }); invalidatePreview();
  notice('Structure and filters reset to unknown within the supported 11–64 character range. Your uncertain notes are unchanged.');
});
els.searchModeInput.addEventListener('change', () => { renderMode(); invalidatePreview(); });
els.symbolPresetInput.addEventListener('change', () => {
  const preset = SYMBOL_PRESETS[els.symbolPresetInput.value];
  if (preset !== undefined) { els.symbolsInput.value = preset; invalidatePreview(); }
});
els.symbolsInput.addEventListener('input', () => syncSymbolPreset(els.symbolsInput.value));
els.setupForm.addEventListener('input', invalidatePreview);
els.setupForm.addEventListener('change', invalidatePreview);
els.modeInput.addEventListener('change', () => { renderMode(); invalidatePreview(); });
els.toggleSetupBtn.disabled = true;
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshStatus(); schedulePoll(); });

async function initialize() {
  applyDefaults(); renderControls();
  try {
    const session = await requestJson('/api/session');
    if (typeof session.token !== 'string' || !session.token) throw new ApiError('INVALID_SESSION', 0);
    appState.sessionToken = session.token;
    try {
      const setup = await requestJson('/api/setup');
      appState.setupEnabled = setup.enabled === true;
      appState.savedJobAvailable = setup.savedJobAvailable === true;
      appState.editing = !setup.configured;
      applyDefaults(setup.defaults);
    } catch (error) { if (error.status !== 404) throw error; }
  } catch (error) { notice(friendlyError(error, 'startup'), true); }
  await refreshStatus({ announceErrors: Boolean(appState.sessionToken) });
  schedulePoll();
  if (appState.editing && appState.setupEnabled) void previewSearch({ automatic: true });
}
void initialize();
