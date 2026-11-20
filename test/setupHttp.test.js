const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server/index');

async function setupServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ethereum-recovery-http-setup-'));
  fs.chmodSync(directory, 0o700);
  const runtimeDir = path.join(directory, 'runtime');
  let runtime;
  t.after(async () => {
    if (runtime) {
      runtime.server.closeAllConnections();
      await runtime.shutdown();
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  runtime = await startServer({ setup: true, port: 0, runtimeDir, workerSetting: '1' });
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const session = await fetch(`${origin}/api/session`).then((response) => response.json());
  const headers = {
    'content-type': 'application/json', origin,
    'x-recovery-session': session.token
  };
  const post = (endpoint, body = {}, overrides = {}) => fetch(`${origin}${endpoint}`, {
    method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body)
  });
  return { ...runtime, runtimeDir, origin, headers, post };
}

function previewInput(overrides = {}) {
  return {
    mode: 'REAL', walletPath: '/nonexistent/private-wallet-path.json',
    rules: {
      word1: ['Privatehint'], word2: ['Anotherhint'],
      minLength: 2, maxLength: 32, minDigits: 1, maxDigits: 1,
      minSymbols: 1, maxSymbols: 1, symbols: '!',
      caseStyles: ['none'], layouts: ['suffix']
    },
    ...overrides
  };
}

function assertNoPrivateData(payload) {
  assert.doesNotMatch(JSON.stringify(payload), /Privatehint|Anotherhint|private-wallet-path|DemoPass123!|ciphertext|privateKey/);
}

test('setup HTTP startup is immediately usable without a wallet, benchmark, or runtime writes', async (t) => {
  const server = await setupServer(t);
  assert.equal(server.controller.engine, null);
  assert.equal(server.controller.job, null);
  assert.equal(fs.existsSync(server.runtimeDir), false);
  const setupResponse = await fetch(`${server.origin}/api/setup`);
  assert.equal(setupResponse.status, 200);
  assert.equal(setupResponse.headers.get('cache-control'), 'no-store');
  const setup = await setupResponse.json();
  assert.equal(setup.enabled, true);
  assert.equal(setup.configured, false);
  assert.equal(setup.defaults.rules.searchMode, 'mask');
  assert.deepEqual(setup.defaults.rules.masks, []);
  assert.deepEqual(setup.defaults.fragmentRules.word1, []);
  assert.deepEqual(setup.defaults.fragmentRules.word2, []);
  assert.equal(setup.defaults.walletPath, '');

  const status = await fetch(`${server.origin}/api/status`).then((response) => response.json());
  assert.equal(status.state, 'setup');
  assert.equal(status.ready, false);
  assert.equal(status.benchmark, null);
  assertNoPrivateData(status);

  const response = await server.post('/api/setup/preview', previewInput());
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.preview.uniqueCandidateCount, 10);
  assertNoPrivateData(payload);
  assert.equal(fs.existsSync(server.runtimeDir), false);
  assert.equal(server.controller.engine, null);
});

test('every setup POST, including current settings and restart, requires origin, session, and JSON', async (t) => {
  const server = await setupServer(t);
  for (const endpoint of ['preview', 'measure', 'configure', 'restore', 'current', 'restart']) {
    const route = `/api/setup/${endpoint}`;
    for (const [overrides, expectedStatus, errorCode] of [
      [{ origin: '' }, 403, 'ORIGIN_REJECTED'],
      [{ origin: 'https://elsewhere.invalid' }, 403, 'ORIGIN_REJECTED'],
      [{ 'x-recovery-session': '' }, 403, 'SESSION_REJECTED'],
      [{ 'x-recovery-session': 'old-token' }, 403, 'SESSION_REJECTED'],
      [{ 'content-type': 'text/plain' }, 415, 'JSON_REQUIRED']
    ]) {
      const response = await server.post(route, { mode: 'DEMO' }, overrides);
      assert.equal(response.status, expectedStatus, route);
      assert.deepEqual(await response.json(), { ok: false, errorCode });
    }
  }
  const currentGet = await fetch(`${server.origin}/api/setup/current`);
  assert.equal(currentGet.status, 404);
  for (const endpoint of ['current', 'restart']) {
    const response = await server.post(`/api/setup/${endpoint}`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).errorCode, 'SETUP_REQUIRED');
  }
  assert.equal(fs.existsSync(server.runtimeDir), false);
});

test('setup validation explains the violated rule without echoing private input', async (t) => {
  const server = await setupServer(t);
  const input = previewInput();
  const cases = [
    [{ ...input, rules: { ...input.rules, minLength: 33 } }, /minLength cannot exceed maxLength/],
    [{ ...input, rules: { ...input.rules, word1: ['Privatehinté'] } }, /English keyboard letters only/],
    [{ ...input, rules: { ...input.rules, Privatehint: 'Anotherhint' } }, /Unsupported search setting/],
    [{ ...input, rules: { ...input.rules, maxLength: 3 } }, /No passwords satisfy/]
  ];
  for (const [body, message] of cases) {
    const response = await server.post('/api/setup/preview', body);
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.errorCode, 'RULES_INVALID');
    assert.match(payload.message, message);
    assertNoPrivateData(payload);
  }
  const invalidPath = await server.post('/api/setup/preview', { ...input, walletPath: 'private-wallet-path.json' });
  const invalidPayload = await invalidPath.json();
  assert.equal(invalidPath.status, 400);
  assert.match(invalidPayload.message, /absolute path/);
  assertNoPrivateData(invalidPayload);
  assert.equal(fs.existsSync(server.runtimeDir), false);
});

test('demo prepares through HTTP while ordinary status and setup reads contain no saved hints', async (t) => {
  const server = await setupServer(t);
  const previewResponse = await server.post('/api/setup/preview', { mode: 'DEMO' });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.preview.uniqueCandidateCount, 1000);
  const configured = await server.post('/api/setup/configure', { mode: 'DEMO' });
  assert.equal(configured.status, 200);
  const payload = await configured.json();
  assert.equal(payload.status.state, 'ready');
  assert.equal(payload.status.uniqueCandidateCount, 1000);
  assert.equal(payload.status.remainingCandidateCount, 1000);
  assert.equal(payload.status.searchedCandidateCount, 0);
  assert.equal(payload.status.benchmark.selectedWorkerCount, 1);
  assertNoPrivateData(payload);

  const ordinarySetup = await fetch(`${server.origin}/api/setup`).then((response) => response.json());
  assert.equal(ordinarySetup.configured, true);
  assert.deepEqual(ordinarySetup.defaults.rules.masks, []);
  assert.deepEqual(ordinarySetup.defaults.fragmentRules.word1, []);
  assert.deepEqual(ordinarySetup.defaults.fragmentRules.word2, []);
  assert.equal(ordinarySetup.defaults.walletPath, '');
  const ordinaryStatus = await fetch(`${server.origin}/api/status`).then((response) => response.json());
  assertNoPrivateData(ordinaryStatus);
  assert.equal(Object.hasOwn(ordinaryStatus, 'config'), false);
  assert.equal(Object.hasOwn(ordinaryStatus, 'walletPath'), false);

  const current = await server.post('/api/setup/current');
  assert.equal(current.status, 200);
  const currentPayload = await current.json();
  assert.equal(currentPayload.ok, true);
  assert.equal(currentPayload.selection.mode, 'DEMO');
  // Demo rules stay internal so switching to a real wallet starts with empty hints.
  assert.equal(currentPayload.selection.rules.searchMode, 'mask');
  assert.deepEqual(currentPayload.selection.rules.masks, []);
  assert.equal(server.controller.getStatus().state, 'ready');
  const restarted = await server.post('/api/setup/restart');
  assert.equal(restarted.status, 200);
  const restartPayload = await restarted.json();
  assert.equal(restartPayload.status.jobId, payload.status.jobId);
  assert.equal(restartPayload.status.state, 'ready');
  assert.equal(restartPayload.status.nextCandidateIndex, 0);
  assert.equal(restartPayload.status.activeElapsedMs, 0);
  assert.ok(fs.readdirSync(server.controller.job.paths.jobDir)
    .some((name) => /^checkpoint\..+\.json$/.test(name)));
});
