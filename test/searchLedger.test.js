const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { SearchLedger } = require('../server/recovery/searchLedger');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-ledger-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('ledger identifies exact bytes across connections and isolates wallets without plaintext', (t) => {
  const root = directory(t);
  const a = new SearchLedger(root, 'a'.repeat(64));
  const b = new SearchLedger(root, 'a'.repeat(64));
  const c = new SearchLedger(root, 'b'.repeat(64));
  t.after(() => { a.close(); b.close(); c.close(); });
  const candidate = 'not-a-real-password-123!!';
  const digest = a.digest(candidate);
  assert.deepEqual(digest, b.digest(candidate));
  assert.notDeepEqual(digest, crypto.createHash('sha256').update(candidate).digest());
  assert.deepEqual(a.digest('Ａlpha'), a.digest('Alpha'), 'identity follows verifier NFKC normalization');
  assert.equal(a.claim(digest).status, 'claimed');
  assert.equal(b.claim(digest).status, 'busy');
  a.complete(digest, false);
  assert.deepEqual(b.claim(digest), { status: 'complete', matched: false });
  assert.equal(c.claim(digest).status, 'claimed');
  assert.equal(b.claim(b.digest(candidate.toUpperCase())).status, 'claimed');
  assert.equal(a.count(), 1);
  for (const name of fs.readdirSync(path.join(root, 'search-history'))) {
    const file = path.join(root, 'search-history', name);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file).includes(Buffer.from(candidate)), false);
  }
});

test('released incomplete claims remain eligible and completed matches survive reopen', (t) => {
  const root = directory(t);
  const a = new SearchLedger(root, 'a'.repeat(64));
  const digest = a.digest('Recovery!!123');
  a.claim(digest);
  a.close();
  const b = new SearchLedger(root, 'a'.repeat(64));
  assert.equal(b.claim(digest).status, 'claimed');
  b.complete(digest, true);
  b.close();
  const reopened = new SearchLedger(root, 'a'.repeat(64));
  t.after(() => reopened.close());
  assert.deepEqual(reopened.claim(digest), { status: 'complete', matched: true });
});

test('transaction rollback leaves interrupted work uncompleted', (t) => {
  const ledger = new SearchLedger(directory(t), 'a'.repeat(64));
  t.after(() => ledger.close());
  const digest = ledger.digest('Recovery!!123');
  ledger.claim(digest);
  const record = ledger._record.bind(ledger);
  ledger._record = (...args) => { record(...args); throw new Error('injected storage failure'); };
  assert.throws(() => ledger.complete(digest, false), /injected storage failure/);
  assert.equal(ledger.lookup(digest), null);
  ledger._record = record;
  ledger.complete(digest, false);
  assert.equal(ledger.lookup(digest).matched, false);
});

test('a recycled live PID cannot strand a claim from its previous process', (t) => {
  const ledger = new SearchLedger(directory(t), 'a'.repeat(64));
  t.after(() => ledger.close());
  const digest = ledger.digest('Recovery!!123');
  ledger.db.prepare('INSERT INTO claims VALUES (?, ?, ?, ?, ?)')
    .run(ledger.walletHash, digest, 'previous-process', process.pid, 'a different process start time');
  assert.equal(ledger.claim(digest).status, 'claimed');
  assert.equal(ledger.lookup(digest), null);
});

test('another process waits for a live claim and safely reclaims it after a crash', async (t) => {
  const root = directory(t);
  const script = `
    const {SearchLedger}=require(${JSON.stringify(path.resolve(__dirname, '../server/recovery/searchLedger'))});
    const ledger=new SearchLedger(process.argv[1], 'a'.repeat(64));
    ledger.claim(ledger.digest('Recovery!!123'));
    process.send('claimed');
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['-e', script, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'message');
  const ledger = new SearchLedger(root, 'a'.repeat(64));
  t.after(() => ledger.close());
  const digest = ledger.digest('Recovery!!123');
  assert.equal(ledger.claim(digest).status, 'busy');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal(ledger.claim(digest).status, 'claimed');
  assert.equal(ledger.lookup(digest), null);
  ledger.complete(digest, false);
  assert.equal(ledger.lookup(digest).matched, false);
});

test('ledger refuses insecure paths and missing keys instead of silently losing reuse', (t) => {
  const root = directory(t);
  const ledger = new SearchLedger(root, 'a'.repeat(64));
  ledger.close();
  fs.chmodSync(ledger.path, 0o644);
  assert.throws(() => new SearchLedger(root, 'a'.repeat(64)), /PERMISSIONS_MUST_BE_PRIVATE/);
  fs.chmodSync(ledger.path, 0o600);
  fs.writeFileSync(path.join(root, 'search-history', 'digest-key.bin'), crypto.randomBytes(32));
  assert.throws(() => new SearchLedger(root, 'a'.repeat(64)), /LEDGER_KEY_MISMATCH/);
  fs.unlinkSync(path.join(root, 'search-history', 'digest-key.bin'));
  assert.throws(() => new SearchLedger(root, 'a'.repeat(64)), /LEDGER_KEY_MISSING/);
});
