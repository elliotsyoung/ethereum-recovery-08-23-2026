const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// These exercise the actual client state and request handlers without a browser.
// The element stubs deliberately make no claims about layout or browser behavior.
function client(fetch = async () => { throw new Error('Unexpected request'); }) {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
  function element() {
    return {
      textContent: '', hidden: false, disabled: false, value: '',
      dataset: {}, style: {}, children: [], attributes: {}, listeners: {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      querySelectorAll() { return []; }, scrollIntoView() {}, reportValidity() { return true; }
    };
  }
  const elements = new Map(ids.map((id) => [id, element()]));
  const context = vm.createContext({
    Date, fetch,
    document: {
      getElementById(id) { assert.ok(elements.has(id), `Missing HTML element: ${id}`); return elements.get(id); },
      createElement: element, createTextNode(textContent) { return { textContent }; }, addEventListener() {}
    },
    window: { clearTimeout() {}, setTimeout() {} }
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
    .replace(/void initialize\(\);\s*$/, '');
  vm.runInContext(source, context);
  const run = (source) => vm.runInContext(source, context, { timeout: 1000 });
  run("appState.sessionToken = 'session-token'; appState.setupEnabled = true;");
  return { context, run, elements };
}
function sampleStatus(overrides = {}) {
  return {
    jobId: 'a'.repeat(64), mode: 'REAL', ready: true, state: 'running',
    uniqueCandidateCount: 100, totalVerified: 25, searchedCandidateCount: 20,
    remainingCandidateCount: 80, nextCandidateIndex: 20, completionPercent: 20,
    guessesPerSecond: 10, activeElapsedMs: 10000, estimatedSecondsRemaining: 8,
    estimateSource: 'live', activeWorkers: 2, ...overrides
  };
}
function render(app, status) { app.context.status = status; app.run('renderStatus(status)'); }

test('dashboard separates search coverage from replay attempts and renders live timing', () => {
  const app = client();
  render(app, sampleStatus());
  assert.equal(app.elements.get('verifiedValue').textContent, '20');
  assert.equal(app.elements.get('remainingValue').textContent, '80');
  assert.equal(app.elements.get('attemptsValue').textContent, '25');
  assert.equal(app.elements.get('elapsedValue').textContent, '10s');
  assert.equal(app.elements.get('etaValue').textContent, '8s');
  assert.equal(app.elements.get('progressTrack').attributes['aria-valuenow'], '20');
  assert.equal(app.run('duration(null)'), 'Calculating…');
  render(app, sampleStatus({ state: 'paused' }));
  assert.equal(app.elements.get('finishValue').textContent, 'When resumed');
});

test('dashboard disables stale and busy controls and keeps configuration locked during recovery', () => {
  const app = client();
  render(app, sampleStatus());
  assert.equal(app.elements.get('pauseBtn').disabled, false);
  assert.equal(app.elements.get('configureBtn').disabled, true);
  assert.equal(app.elements.get('restartBtn').disabled, true);
  app.run('appState.statusRequestFailed = true; renderControls();');
  assert.equal(app.elements.get('pauseBtn').disabled, true);
  app.run('appState.statusRequestFailed = false;');
  render(app, sampleStatus({ state: 'paused' }));
  assert.equal(app.elements.get('resumeBtn').disabled, false);
  assert.equal(app.elements.get('configureBtn').disabled, true, 'new settings need a reviewed current preview');
  assert.equal(app.elements.get('restartBtn').disabled, false);
  render(app, sampleStatus({ state: 'paused', operationInProgress: 'benchmark' }));
  assert.equal(app.elements.get('resumeBtn').disabled, true);
  assert.equal(app.elements.get('restartBtn').disabled, true);
  assert.match(app.elements.get('benchmarkSummary').textContent, /Measuring/);
});

test('found results refresh the reveal command when controller adds the runtime path', () => {
  const app = client();
  const status = sampleStatus({ state: 'found', matchFound: true, matchConfirming: true });
  render(app, status);
  assert.equal(app.elements.get('stateValue').textContent, 'Found');
  assert.equal(app.elements.get('readinessBadge').textContent, 'Found');
  assert.equal(app.elements.get('resultBanner').children[1].textContent, `npm run reveal -- --job ${status.jobId}`);
  const revealCommand = `npm run reveal -- --job ${status.jobId} --runtime-dir '/tmp/recovery'`;
  render(app, { ...status, revealCommand });
  assert.equal(app.elements.get('resultBanner').children[1].textContent, revealCommand);
  assert.equal(app.elements.get('etaValue').textContent, 'Complete');
  assert.equal(app.elements.get('pauseBtn').hidden, true);
});

test('client presents safe field validation messages as text', async () => {
  const app = client(async () => ({
    ok: false, status: 400,
    json: async () => ({ ok: false, errorCode: 'RULES_INVALID', message: 'First words needs at least one word.' })
  }));
  const message = await app.run("requestJson('/api/setup/preview').catch((error) => friendlyError(error))");
  assert.equal(message, 'First words needs at least one word.');
});

test('editing hydrates the active search through authenticated POST and restart avoids stale form data', async () => {
  const requests = [];
  const current = { mode: 'REAL', walletPath: '/tmp/example-wallet.json', rules: { word1: ['Alpha'], word2: ['Beta'], minLength: 12 } };
  const app = client(async (url, options) => {
    requests.push({ url, options });
    let payload;
    if (url === '/api/setup/current') payload = { ok: true, selection: current };
    else if (url === '/api/setup/restart') payload = { ok: true, status: sampleStatus({ state: 'ready', totalVerified: 0, nextCandidateIndex: 0, searchedCandidateCount: 0, remainingCandidateCount: 100 }) };
    else if (url === '/api/status') payload = sampleStatus({ state: 'ready', totalVerified: 0, nextCandidateIndex: 0, searchedCandidateCount: 0, remainingCandidateCount: 100 });
    else throw new Error(`Unexpected route ${url}`);
    return { ok: true, status: 200, json: async () => payload };
  });
  render(app, sampleStatus({ state: 'paused' }));
  app.run('appState.editing = false;');
  await app.elements.get('toggleSetupBtn').listeners.click();
  assert.equal(app.elements.get('walletInput').value, '/tmp/example-wallet.json');
  assert.equal(app.elements.get('firstWordsInput').value, 'Alpha');
  assert.equal(String(app.elements.get('minLengthInput').value), '12');
  assert.equal(app.elements.get('setupForm').hidden, false);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['X-Recovery-Session'], 'session-token');
  app.elements.get('walletInput').value = '/unused/stale-edit.json';
  await app.run("setupAction('restart')");
  const restartRequest = requests.find((request) => request.url === '/api/setup/restart');
  assert.equal(restartRequest.options.body, '{}');
  assert.equal(app.elements.get('verifiedValue').textContent, '0');
  assert.match(app.elements.get('notice').textContent, /checkpoint is archived/);
});

test('unknown defaults keep arbitrary structure and notes never become search filters', () => {
  const app = client();
  app.run('applyDefaults()');
  assert.equal(app.elements.get('searchModeInput').value, 'mask');
  assert.equal(app.elements.get('minLengthInput').value, 11);
  assert.equal(app.elements.get('maxLengthInput').value, 64);
  assert.equal(app.elements.get('fragmentFields').hidden, true);
  app.elements.get('memoryNotesInput').value = 'Maybe a rhyme or a typo';
  const setup = JSON.parse(app.run('JSON.stringify(readSetup())'));
  assert.deepEqual(setup.rules, { searchMode: 'mask', masks: [], minLength: 11, maxLength: 64 });
  assert.equal(JSON.stringify(setup).includes('Maybe'), false);
  app.run("appState.previewKey = 'saved'; els.coverageConfirm.checked = true; invalidatePreview({target:els.memoryNotesInput});");
  assert.equal(app.run('appState.previewKey'), 'saved');
  assert.equal(app.elements.get('coverageConfirm').checked, true);
});

test('preview preserves enormous exact counts and labels illustrative time honestly', () => {
  const app = client();
  app.context.preview = {
    candidateCountExact: '123456789012345678901234567890', runnable: false,
    estimate: { source: 'illustrative', scenarios: [{ guessesPerSecond: 10, seconds: 120 }] },
    coverage: ['All positions remain open.'],
    questions: [{ prompt: 'What length range is certain?', reason: 'An exact boundary can reduce the search.' }]
  };
  app.run('renderPreview(preview)');
  assert.equal(app.elements.get('previewCount').textContent, BigInt(app.context.preview.candidateCountExact).toLocaleString());
  assert.match(app.elements.get('measurementHelp').textContent, /not a forecast/);
  assert.match(app.elements.get('estimateScenarios').children[0].textContent, /If 10 checks\/sec: 2m 0s/);
  assert.match(app.elements.get('previewWarnings').children[0].textContent, /cannot be started/);
  assert.equal(app.elements.get('questionSuggestions').hidden, false);
  assert.equal(app.elements.get('coverageList').children[0].textContent, 'All positions remain open.');
});

test('batch estimate uses the exact displayed preview and is unavailable when it becomes stale', () => {
  const app = client();
  const trigger = app.elements.get('batchEstimateBtn');
  const dialog = app.elements.get('batchEstimateDialog');
  let opens = 0;
  dialog.showModal = () => { opens += 1; };
  app.context.preview = {
    candidateCountExact: '12345678901234567890',
    estimate: { source: 'illustrative', scenarios: [{ guessesPerSecond: 10, seconds: 120 }] }
  };
  app.run('applyDefaults(); renderControls();');
  assert.equal(trigger.hidden, true);
  app.run('renderPreview(preview); appState.previewKey = JSON.stringify(readSetup()); renderControls();');
  assert.equal(trigger.hidden, false);
  assert.equal(trigger.disabled, false);
  trigger.listeners.click();
  assert.equal(opens, 1);
  assert.equal(app.elements.get('batchEstimateCount').textContent, app.elements.get('previewCount').textContent);
  assert.equal(app.elements.get('batchEstimateHelp').textContent, app.elements.get('measurementHelp').textContent);
  assert.equal(app.elements.get('batchEstimateTimes').children[0].textContent, 'If 10 checks/sec: 2m 0s');
  app.run('appState.previewPending = true; renderControls();');
  assert.equal(trigger.disabled, true);
  trigger.listeners.click();
  app.run('invalidatePreview();');
  assert.equal(trigger.hidden, true);
  trigger.listeners.click();
  assert.equal(opens, 1);
});

test('out-of-order preview responses never replace the current filter estimate', async () => {
  const pending = [];
  const app = client((url, options) => new Promise((resolve) => pending.push({ url, options, resolve })));
  app.run('applyDefaults()');
  app.elements.get('masksInput').value = 'abcdefghij?d';
  const first = app.run('previewSearch({automatic:true})');
  app.elements.get('masksInput').value = 'abcdefghij?x';
  app.run('invalidatePreview()');
  const second = app.run('previewSearch({automatic:true})');
  pending[1].resolve({ ok: true, status: 200, json: async () => ({ preview: { candidateCountExact: '95', runnable: true } }) });
  await second;
  pending[0].resolve({ ok: true, status: 200, json: async () => ({ preview: { candidateCountExact: '10', runnable: true } }) });
  await first;
  assert.equal(app.elements.get('previewCount').textContent, '95');
  assert.equal(app.run('appState.previewKey === JSON.stringify(readSetup())'), true);
  assert.equal(app.elements.get('coverageConfirm').checked, false);
});

test('preparing requires current reviewed coverage and carries explicit acknowledgement', async () => {
  const requests = [];
  const app = client(async (url, options) => {
    requests.push({ url, body: options?.body && JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => url === '/api/status' ? sampleStatus({ state: 'ready' }) : { status: sampleStatus({ state: 'ready' }) } };
  });
  app.run('applyDefaults()');
  app.elements.get('walletInput').value = '/tmp/wallet.json';
  app.elements.get('masksInput').value = 'abcdefghij?d';
  await app.run("setupAction('configure')");
  assert.equal(requests.length, 0);
  assert.match(app.elements.get('errorBanner').textContent, /coverage/);
  app.run('appState.preview = {runnable:true}; appState.previewKey = JSON.stringify(readSetup()); els.coverageConfirm.checked = true;');
  await app.run("setupAction('configure')");
  assert.equal(requests[0].url, '/api/setup/configure');
  assert.equal(requests[0].body.coverageAcknowledged, true);
  assert.deepEqual(requests[0].body.rules.masks, ['abcdefghij?d']);
});

test('changing a filter clears coverage consent and separates reused results from attempts', () => {
  const app = client();
  app.run('applyDefaults(); appState.preview = {runnable:true}; appState.previewKey = JSON.stringify(readSetup()); els.coverageConfirm.checked = true;');
  render(app, sampleStatus({ state: 'paused', reusedCandidateCount: 17 }));
  assert.equal(app.elements.get('configureBtn').disabled, false);
  assert.equal(app.elements.get('reusedValue').textContent, '17');
  assert.equal(app.elements.get('attemptsValue').textContent, '25');
  app.run('invalidatePreview()');
  assert.equal(app.elements.get('coverageConfirm').checked, false);
  assert.equal(app.elements.get('configureBtn').disabled, true);
});

test('wallet measurement sends no hints and refreshes the current estimate', async () => {
  const requests = [];
  const app = client(async (url, options) => {
    requests.push({ url, body: options?.body && JSON.parse(options.body) });
    const payload = url === '/api/setup/measure'
      ? { measurement: { guessesPerSecond: 20 } }
      : url === '/api/setup/preview'
        ? { preview: { candidateCountExact: '10', runnable: true, estimate: { source: 'measured', guessesPerSecond: 20, seconds: .5 } } }
        : { state: 'setup' };
    return { ok: true, status: 200, json: async () => payload };
  });
  app.run('applyDefaults()');
  app.elements.get('walletInput').value = '/tmp/wallet.json';
  app.elements.get('masksInput').value = 'abcdefghij?d';
  app.elements.get('memoryNotesInput').value = 'private tentative thought';
  await app.run("setupAction('measure')");
  assert.deepEqual(requests[0].body, { mode: 'REAL', walletPath: '/tmp/wallet.json' });
  assert.equal(requests.at(-1).url, '/api/setup/preview');
  assert.match(app.elements.get('previewDuration').textContent, /20 checks\/sec/);
  assert.equal(app.elements.get('coverageConfirm').checked, false);
});

test('delegated change on blur and coverage events preserve an already previewed selection', async () => {
  const app = client(async () => ({ ok: true, status: 200, json: async () => ({ preview: { candidateCountExact: '10', runnable: true } }) }));
  app.run('applyDefaults()');
  app.elements.get('masksInput').value = 'abcdefghij?d';
  await app.run('previewSearch({automatic:true})');
  const key = app.run('appState.previewKey');
  // Browsers emit change when the textarea loses focus, after the input-driven
  // live preview has already arrived. A click on coverage must survive it.
  app.elements.get('setupForm').listeners.change({ target: app.elements.get('masksInput') });
  app.elements.get('coverageConfirm').checked = true;
  app.elements.get('setupForm').listeners.input({ target: app.elements.get('coverageConfirm') });
  app.elements.get('setupForm').listeners.change({ target: app.elements.get('coverageConfirm') });
  assert.equal(app.elements.get('coverageConfirm').checked, true);
  assert.equal(app.run('appState.previewKey'), key);
  assert.equal(app.elements.get('configureBtn').disabled, false);
  app.elements.get('memoryNotesInput').value = 'a hunch';
  app.elements.get('setupForm').listeners.input({ target: app.elements.get('memoryNotesInput') });
  assert.equal(app.elements.get('coverageConfirm').checked, true);
  app.elements.get('masksInput').value = 'abcdefghij?x';
  app.elements.get('setupForm').listeners.input({ target: app.elements.get('masksInput') });
  assert.equal(app.elements.get('coverageConfirm').checked, false);
});
