const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createVerificationContext } = require('../server/recovery/walletVerifier');
const { buildGuidedConfig } = require('../server/recovery/guidedConfig');
const { compileCandidatePlan } = require('../server/recovery/candidateGenerator');

const workerPath = path.resolve(__dirname, '../server/recovery/recoveryVerifierWorker.js');
const fixturePath = path.resolve(__dirname, 'fixtures/low-cost-v3.json');
const config = {
  schemaVersion: 2,
  patterns: [{
    name: 'worker-test',
    slots: ['word1', 'number', 'suffix'],
    word1: ['Alpha', 'Beta'],
    number: ['1'],
    suffix: ['!']
  }],
  capitalization: ['none'],
  mutations: { word1: ['none'] }
};

function createWorker(t) {
  const verificationContext = createVerificationContext(fs.readFileSync(fixturePath, 'utf8'));
  const worker = new Worker(workerPath, {
    workerData: {
      config,
      rawIndices: [1, 0],
      verificationContext
    }
  });
  t.after(() => worker.terminate());
  return worker;
}

test('verifier worker returns only the unique index and native match result', async (t) => {
  const worker = createWorker(t);

  worker.postMessage({ type: 'verify', index: 0 });
  const [miss] = await once(worker, 'message');
  assert.deepEqual(miss, { type: 'result', index: 0, matched: false });

  worker.postMessage({ type: 'verify', index: 1 });
  const [match] = await once(worker, 'message');
  assert.deepEqual(match, { type: 'result', index: 1, matched: true });
  assert.equal(Object.prototype.hasOwnProperty.call(match, 'candidate'), false);
});

test('verifier worker sanitizes invalid index failures', async (t) => {
  const worker = createWorker(t);
  worker.postMessage({ type: 'verify', index: 99 });
  const [message] = await once(worker, 'message');

  assert.deepEqual(message, {
    type: 'error',
    index: 99,
    errorCode: 'VERIFICATION_FAILED'
  });
});

test('guided verifier workers resolve compact indexes without allocating an index map', async (t) => {
  const guided = buildGuidedConfig({
    word1: ['Al'], word2: ['pha'], caseStyles: ['none'], layouts: ['suffix'],
    minLength: 7, maxLength: 7, minDigits: 1, maxDigits: 1,
    minSymbols: 1, maxSymbols: 1, symbols: '!'
  });
  const plan = compileCandidatePlan(guided);
  assert.equal(plan.kind, 'guided');
  assert.equal(plan.rawIndices, null);
  assert.equal(plan.uniqueCount, 10);
  const worker = new Worker(workerPath, {
    workerData: {
      config: guided,
      planKind: plan.kind,
      rawIndices: null,
      uniqueCount: plan.uniqueCount,
      verificationContext: createVerificationContext(fs.readFileSync(fixturePath, 'utf8'))
    }
  });
  t.after(() => worker.terminate());
  worker.postMessage({ type: 'verify', index: 0 });
  const [miss] = await once(worker, 'message');
  assert.deepEqual(miss, { type: 'result', index: 0, matched: false });
  worker.postMessage({ type: 'verify', index: 1 });
  const [match] = await once(worker, 'message');
  assert.deepEqual(match, { type: 'result', index: 1, matched: true });
  worker.postMessage({ type: 'verify', index: 10 });
  const [invalid] = await once(worker, 'message');
  assert.deepEqual(invalid, { type: 'error', index: 10, errorCode: 'VERIFICATION_FAILED' });
});
