const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Wallet } = require('ethers');
const {
  KeystoreValidationError,
  MAX_KEYSTORE_BYTES,
  calculateScryptMemoryBytes,
  confirmCandidate,
  createVerificationContext,
  ensureDemoWallet,
  preflightKeystore,
  readKeystoreFile,
  validateKeystore,
  verifyCandidate
} = require('../server/recovery/walletVerifier');

const FIXTURE_DIRECTORY = path.resolve(__dirname, 'fixtures');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIRECTORY, name), 'utf8');
}

function parseFixture(name = 'low-cost-v3.json') {
  return JSON.parse(readFixture(name));
}

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ethereum-recovery-wallet-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function copySecureFixture(t, name = 'low-cost-v3.json') {
  const directory = makeTempDirectory(t);
  const destination = path.join(directory, 'wallet.json');
  fs.copyFileSync(path.join(FIXTURE_DIRECTORY, name), destination);
  fs.chmodSync(destination, 0o600);
  return { directory, walletPath: destination };
}

test('strict preflight returns validated metadata and a cloneable context', (t) => {
  const { walletPath } = copySecureFixture(t);
  const result = preflightKeystore(walletPath);

  assert.equal(result.path, walletPath);
  assert.equal(result.filePath, walletPath);
  assert.equal(result.keystore.version, 3);
  assert.equal(result.parsedKeystore, result.keystore);
  assert.equal(result.rawJson, readFixture('low-cost-v3.json'));
  assert.equal(result.walletHash, crypto.createHash('sha256').update(result.rawJson).digest('hex'));
  assert.equal(result.address, '0xfcad0b19bb29d4674531d6f115237e16afce377c');
  assert.deepEqual(result.verificationContext, {
    N: 1024,
    r: 8,
    p: 1,
    dklen: 32,
    salt: '11'.repeat(32),
    ciphertext: '6aac5ae6fc4060431fa0f392cfb06009db000e77b9d162823373b0adec57051d',
    mac: '83a3a736529498c0286cac72e70480a1eb66337c11529dbde8b1710c29a55c2f'
  });
  assert.deepEqual(structuredClone(result.verificationContext), result.verificationContext);
  assert.deepEqual(readKeystoreFile(walletPath), result.keystore);
});

test('preflight rejects relative paths, symlinks, non-files, and oversized files', (t) => {
  const { directory, walletPath } = copySecureFixture(t);
  assert.throws(() => preflightKeystore(path.relative(process.cwd(), walletPath)), /absolute path/);

  const symlinkPath = path.join(directory, 'wallet-link.json');
  fs.symlinkSync(walletPath, symlinkPath);
  assert.throws(() => preflightKeystore(symlinkPath), /symbolic link/);
  assert.throws(() => preflightKeystore(directory), /regular file/);

  const oversizedPath = path.join(directory, 'oversized.json');
  fs.writeFileSync(oversizedPath, Buffer.alloc(MAX_KEYSTORE_BYTES + 1), { mode: 0o600 });
  assert.throws(() => preflightKeystore(oversizedPath), /1 MiB/);
});

test('preflight requires owner-only permissions and owner readability', (t) => {
  const { walletPath } = copySecureFixture(t);

  fs.chmodSync(walletPath, 0o640);
  assert.throws(() => preflightKeystore(walletPath), /group or other/);

  fs.chmodSync(walletPath, 0o200);
  assert.throws(() => preflightKeystore(walletPath), /readable by its owner/);

  fs.chmodSync(walletPath, 0o600);
  assert.equal(preflightKeystore(walletPath).keystore.version, 3);
});

test('native MAC verification agrees with ethers for correct and wrong passwords', async () => {
  const rawJson = readFixture('low-cost-v3.json');
  const { address, verificationContext } = validateKeystore(rawJson);

  assert.equal(verifyCandidate(verificationContext, 'Alpha1!'), true);
  assert.equal(verifyCandidate(verificationContext, 'not-the-password'), false);
  assert.equal(verifyCandidate(rawJson, 'Alpha1!'), true);
  assert.equal(await confirmCandidate(rawJson, 'Alpha1!', address), true);
  assert.equal(await confirmCandidate(rawJson, 'not-the-password', address), false);
});

test('candidate passwords are normalized with NFKC before native and ethers verification', async () => {
  const rawJson = readFixture('unicode-v3.json');
  const { address, verificationContext } = validateKeystore(rawJson);
  const composed = 'Caf\u00e9123!';
  const decomposed = 'Cafe\u0301123!';

  assert.equal(verifyCandidate(verificationContext, composed), true);
  assert.equal(verifyCandidate(verificationContext, decomposed), true);
  assert.equal(await confirmCandidate(rawJson, decomposed, address), true);
});

test('confirmCandidate rejects a decrypted wallet whose address does not match', async () => {
  const keystore = parseFixture();
  keystore.address = '00'.repeat(20);

  await assert.rejects(
    confirmCandidate(keystore, 'Alpha1!'),
    /does not match the keystore address/
  );
});

test('malformed and unsupported keystores throw instead of looking like wrong passwords', () => {
  assert.throws(() => verifyCandidate('{', 'anything'), KeystoreValidationError);

  const cases = [
    ['version', (wallet) => { wallet.version = 2; }],
    ['id', (wallet) => { wallet.id = 'not-a-uuid'; }],
    ['address', (wallet) => { wallet.address = 'xyz'; }],
    ['cipher', (wallet) => { wallet.Crypto.cipher = 'aes-128-cbc'; }],
    ['iv', (wallet) => { wallet.Crypto.cipherparams.iv = '00'; }],
    ['ciphertext', (wallet) => { wallet.Crypto.ciphertext = 'xyz'; }],
    ['kdf', (wallet) => { wallet.Crypto.kdf = 'pbkdf2'; }],
    ['dklen', (wallet) => { wallet.Crypto.kdfparams.dklen = 64; }],
    ['N', (wallet) => { wallet.Crypto.kdfparams.n = 1000; }],
    ['N/r bound', (wallet) => {
      wallet.Crypto.kdfparams.n = 65536;
      wallet.Crypto.kdfparams.r = 1;
    }],
    ['r', (wallet) => { wallet.Crypto.kdfparams.r = 0; }],
    ['p', (wallet) => { wallet.Crypto.kdfparams.p = 1.5; }],
    ['r/p bound', (wallet) => { wallet.Crypto.kdfparams.p = 2 ** 30; }],
    ['salt', (wallet) => { wallet.Crypto.kdfparams.salt = '0x11'; }],
    ['mac', (wallet) => { wallet.Crypto.mac = '00'; }]
  ];

  for (const [name, mutate] of cases) {
    const wallet = parseFixture();
    mutate(wallet);
    assert.throws(() => createVerificationContext(wallet), KeystoreValidationError, name);
  }
});

test('validator accepts either conventional crypto key casing, but never both', () => {
  const lowercase = parseFixture();
  lowercase.crypto = lowercase.Crypto;
  delete lowercase.Crypto;
  assert.equal(validateKeystore(lowercase).verificationContext.N, 1024);

  lowercase.Crypto = lowercase.crypto;
  assert.throws(() => validateKeystore(lowercase), /exactly one crypto section/);
});

test('target-parameter fixture is accepted without running its expensive KDF', () => {
  const context = createVerificationContext(readFixture('target-cost-v3.json'));
  assert.equal(context.N, 262144);
  assert.equal(context.r, 8);
  assert.equal(context.p, 1);
  assert.equal(calculateScryptMemoryBytes(context), 268438528);
  assert.equal(calculateScryptMemoryBytes({ N: 2, r: 300000, p: 1 }), 192000000);
});

test('ensureDemoWallet creates a protected low-cost demo without overwriting it', async (t) => {
  const directory = makeTempDirectory(t);
  const walletPath = path.join(directory, 'demo.json');
  const fixedWallet = new Wallet('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

  await ensureDemoWallet(walletPath, {
    wallet: fixedWallet,
    password: 'DemoPass123!',
    scrypt: { N: 1024, r: 8, p: 1 }
  });
  const firstContents = fs.readFileSync(walletPath, 'utf8');
  assert.equal(fs.statSync(walletPath).mode & 0o777, 0o600);
  assert.equal(verifyCandidate(readKeystoreFile(walletPath), 'DemoPass123!'), true);

  await ensureDemoWallet(walletPath, {
    wallet: Wallet.createRandom(),
    password: 'different',
    scrypt: { N: 1024, r: 8, p: 1 }
  });
  assert.equal(fs.readFileSync(walletPath, 'utf8'), firstContents);
});
