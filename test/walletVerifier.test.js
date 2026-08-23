const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');
const { verifyCandidate, ensureDemoWallet, readKeystoreFile } = require('../server/recovery/walletVerifier');
const { saveCheckpoint, loadCheckpoint } = require('../server/recovery/checkpoint');
const { generateCandidate, getDefaultPatternConfig } = require('../server/recovery/candidateGenerator');

const testWalletPath = path.resolve(__dirname, '../wallet/test-wallet.json');
const checkpointPath = path.resolve(__dirname, '../data/checkpoint.json');

async function createTestWallet() {
  const wallet = Wallet.createRandom();
  const encrypted = await wallet.encrypt('StrongPass123!');
  fs.mkdirSync(path.dirname(testWalletPath), { recursive: true });
  fs.writeFileSync(testWalletPath, encrypted, 'utf8');
  return { wallet, encrypted };
}

test('wrong password fails', async () => {
  const { encrypted } = await createTestWallet();
  assert.equal(await verifyCandidate(encrypted, 'bad-password'), false);
  fs.unlinkSync(testWalletPath);
});

test('correct password succeeds', async () => {
  const { encrypted } = await createTestWallet();
  assert.equal(await verifyCandidate(encrypted, 'StrongPass123!'), true);
  fs.unlinkSync(testWalletPath);
});

test('checkpoint save/load works', () => {
  const checkpoint = {
    candidateIndex: 25,
    totalAttempted: 100,
    startedAt: Date.now(),
    lastCheckpointAt: Date.now(),
    elapsedMs: 1200,
    currentPattern: 'word1+word2+number+suffix',
    matchesFound: 1,
    state: 'running'
  };

  saveCheckpoint(checkpointPath, checkpoint);
  const loaded = loadCheckpoint(checkpointPath);
  assert.equal(loaded.candidateIndex, 25);
  assert.equal(loaded.matchesFound, 1);
});

test('resume begins at the expected candidate index', () => {
  const checkpoint = {
    candidateIndex: 10,
    totalAttempted: 10,
    startedAt: Date.now(),
    lastCheckpointAt: Date.now(),
    elapsedMs: 500,
    currentPattern: 'word1+number+word2+suffix',
    matchesFound: 0,
    state: 'running'
  };

  saveCheckpoint(checkpointPath, checkpoint);
  const loaded = loadCheckpoint(checkpointPath);
  assert.equal(loaded.candidateIndex, 10);
});

test('demo wallet creation works', async () => {
  const walletPath = await ensureDemoWallet();
  const parsed = readKeystoreFile(walletPath);
  assert.equal(parsed.version, 3);
  assert.equal(await verifyCandidate(parsed, 'DemoPass123!'), true);
});
