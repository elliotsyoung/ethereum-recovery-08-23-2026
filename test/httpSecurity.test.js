const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/index');
const { RecoveryStateError } = require('../server/recovery/recoveryEngine');

const SESSION_TOKEN = 'fixed-test-session-token';

function safeStatus(overrides = {}) {
  return {
    mode: 'REAL',
    ready: true,
    state: 'ready',
    jobId: 'a'.repeat(64),
    rawCandidateCount: 3,
    uniqueCandidateCount: 2,
    duplicatesRemoved: 1,
    totalVerified: 0,
    nextCandidateIndex: 0,
    completionPercent: 0,
    activeWorkers: 0,
    guessesPerSecond: 0,
    guessesPerHour: 0,
    activeElapsedMs: 0,
    estimatedSecondsRemaining: null,
    lastCheckpointAt: null,
    matchFound: false,
    errorCode: null,
    benchmark: null,
    ...overrides
  };
}

function mockEngine() {
  const calls = [];
  const status = safeStatus();
  return {
    calls,
    getStatus() {
      calls.push({ method: 'getStatus', args: [] });
      return status;
    },
    async start(...args) {
      calls.push({ method: 'start', args });
      return { ...status, state: 'running' };
    },
    async pause(...args) {
      calls.push({ method: 'pause', args });
      return { ...status, state: 'paused' };
    },
    async resume(...args) {
      calls.push({ method: 'resume', args });
      return { ...status, state: 'running' };
    },
    async stop(...args) {
      calls.push({ method: 'stop', args });
      return { ...status, state: 'stopped' };
    },
    async calibrate(...args) {
      calls.push({ method: 'calibrate', args });
      return { selectedWorkerCount: 1 };
    }
  };
}

async function listen(t, engine = mockEngine()) {
  const app = createApp(engine, { sessionToken: SESSION_TOKEN });
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    candidate.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  return { engine, port, origin: `http://127.0.0.1:${port}` };
}

function rawRequest({ port, method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function mutationHeaders(origin, token = SESSION_TOKEN) {
  return {
    'content-type': 'application/json',
    origin,
    'x-recovery-session': token
  };
}

test('status/session stay loopback-scoped and carry defensive response headers', async (t) => {
  const { origin } = await listen(t);
  const sessionResponse = await fetch(`${origin}/api/session`);
  assert.equal(sessionResponse.status, 200);
  assert.deepEqual(await sessionResponse.json(), { token: SESSION_TOKEN });
  assert.equal(sessionResponse.headers.get('cache-control'), 'no-store');
  assert.equal(sessionResponse.headers.get('x-frame-options'), 'DENY');
  assert.equal(sessionResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(sessionResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(sessionResponse.headers.get('x-powered-by'), null);
  assert.equal(sessionResponse.headers.get('access-control-allow-origin'), null);

  const statusResponse = await fetch(`${origin}/api/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.deepEqual(status, safeStatus());
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /\/private\/|Alpha1!|ciphertext|keystore|password/i);
});

test('host, origin, content type, and per-process token are required for mutations', async (t) => {
  const { engine, origin, port } = await listen(t);

  const hostileHost = await rawRequest({
    port,
    path: '/api/status',
    headers: { host: `evil.example:${port}` }
  });
  assert.equal(hostileHost.status, 403);
  assert.deepEqual(JSON.parse(hostileHost.body), { ok: false, errorCode: 'HOST_REJECTED' });

  const noOrigin = await fetch(`${origin}/api/recovery/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-recovery-session': SESSION_TOKEN },
    body: '{}'
  });
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(await noOrigin.json(), { ok: false, errorCode: 'ORIGIN_REJECTED' });

  const hostileOrigin = await fetch(`${origin}/api/recovery/start`, {
    method: 'POST',
    headers: mutationHeaders('http://evil.example'),
    body: '{}'
  });
  assert.equal(hostileOrigin.status, 403);
  assert.deepEqual(await hostileOrigin.json(), { ok: false, errorCode: 'ORIGIN_REJECTED' });

  const staleToken = await fetch(`${origin}/api/recovery/start`, {
    method: 'POST',
    headers: mutationHeaders(origin, 'stale-session-token'),
    body: '{}'
  });
  assert.equal(staleToken.status, 403);
  assert.deepEqual(await staleToken.json(), { ok: false, errorCode: 'SESSION_REJECTED' });

  const wrongType = await fetch(`${origin}/api/recovery/start`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      origin,
      'x-recovery-session': SESSION_TOKEN
    },
    body: '{}'
  });
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await wrongType.json(), { ok: false, errorCode: 'JSON_REQUIRED' });
  assert.equal(engine.calls.some((call) => call.method === 'start'), false);
});

test('HTTP bodies cannot select mode, wallet paths, patterns, or reveal candidates', async (t) => {
  const { engine, origin } = await listen(t);
  const response = await fetch(`${origin}/api/recovery/start`, {
    method: 'POST',
    headers: mutationHeaders(origin),
    body: JSON.stringify({
      mode: 'REAL',
      walletPath: '/private/secret-wallet.json',
      patterns: { candidate: ['secret'] },
      reveal: true
    })
  });
  assert.equal(response.status, 200);
  const startCall = engine.calls.find((call) => call.method === 'start');
  assert.deepEqual(startCall.args, []);
  assert.doesNotMatch(await response.text(), /secret-wallet|secret/);

  for (const endpoint of ['/api/patterns', '/api/recovery/reveal-match']) {
    const removed = await fetch(`${origin}${endpoint}`, {
      method: 'POST',
      headers: mutationHeaders(origin),
      body: '{}'
    });
    assert.equal(removed.status, 404, endpoint);
    assert.deepEqual(await removed.json(), { ok: false, errorCode: 'NOT_FOUND' });
  }
});

test('invalid state transitions return a sanitized 409 response', async (t) => {
  const engine = mockEngine();
  engine.pause = async () => {
    throw new RecoveryStateError('INVALID_STATE_TRANSITION');
  };
  const { origin } = await listen(t, engine);

  const response = await fetch(`${origin}/api/recovery/pause`, {
    method: 'POST',
    headers: mutationHeaders(origin),
    body: '{}'
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    errorCode: 'INVALID_STATE_TRANSITION'
  });
});

test('malformed JSON is rejected without parser internals or local data', async (t) => {
  const { origin, port } = await listen(t);
  const malformedBody = '{"walletPath": }';
  const response = await rawRequest({
    port,
    method: 'POST',
    path: '/api/recovery/start',
    headers: {
      host: `127.0.0.1:${port}`,
      ...mutationHeaders(origin),
      'content-length': String(Buffer.byteLength(malformedBody))
    },
    body: malformedBody
  });

  assert.equal(response.status, 400);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    errorCode: 'INVALID_JSON'
  });
  assert.doesNotMatch(response.body, /SyntaxError|Unexpected token|JSON\.parse|server\//i);
});
