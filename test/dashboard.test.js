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
  assert.equal(app.elements.get('configureBtn').disabled, false);
  assert.equal(app.elements.get('restartBtn').disabled, false);
  render(app, sampleStatus({ state: 'paused', operationInProgress: 'benchmark' }));
  assert.equal(app.elements.get('resumeBtn').disabled, true);
  assert.equal(app.elements.get('restartBtn').disabled, true);
  assert.match(app.elements.get('benchmarkSummary').textContent, /Measuring/);
});

test('found results refresh the reveal command when controller adds the runtime path', () => {
  const app = client();
  const status = sampleStatus({ state: 'found', matchFound: true });
  render(app, status);
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
