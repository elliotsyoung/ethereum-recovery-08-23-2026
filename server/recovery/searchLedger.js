const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const {
  assertPrivateFile, atomicCreatePrivate, ensurePrivateDirectory, readPrivateFile
} = require('../runtime');
const { normalizeCandidate } = require('./walletVerifier');

const LEDGER_VERSION = 2;
function processIdentity(pid) {
  let value = null;
  try {
    value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }
    }).trim() || null;
  } catch { /* An unreadable process identity never authorizes stealing work. */ }
  return value;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// A candidate's verifier-normalized UTF-8 bytes are its identity, independent of its index,
// generator, job, or filters. HMAC keeps the database from being a standalone
// dictionary of unsalted password hashes. The key stays in the private runtime.
class SearchLedger {
  constructor(runtimeDir, walletHash) {
    if (!/^[a-f0-9]{64}$/.test(walletHash)) throw new Error('LEDGER_WALLET_INVALID');
    this.walletHash = walletHash;
    this.owner = crypto.randomUUID();
    this.processStarted = processIdentity(process.pid);
    if (!this.processStarted) throw new Error('LEDGER_PROCESS_IDENTITY_UNAVAILABLE');
    this.closed = false;
    const directory = ensurePrivateDirectory(path.join(runtimeDir, 'search-history'));
    this.path = path.join(directory, 'checks.sqlite');
    const keyPath = path.join(directory, 'digest-key.bin');
    if (fs.existsSync(this.path) && !fs.existsSync(keyPath)) {
      throw new Error('LEDGER_KEY_MISSING');
    }
    try { atomicCreatePrivate(keyPath, crypto.randomBytes(32)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.key = readPrivateFile(keyPath, { maxBytes: 32, label: 'LEDGER_KEY' });
    if (this.key.length !== 32) throw new Error('LEDGER_KEY_INVALID');
    try { atomicCreatePrivate(this.path, Buffer.alloc(0)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`, `${this.path}-journal`]) {
      if (fs.existsSync(file)) assertPrivateFile(file, { maxBytes: Number.MAX_SAFE_INTEGER, label: 'LEDGER' });
    }
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1, LEDGER_VERSION].includes(version)) throw new Error('LEDGER_SCHEMA_UNSUPPORTED');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS checks (
          wallet TEXT NOT NULL, digest BLOB NOT NULL, matched INTEGER NOT NULL CHECK(matched IN (0, 1)),
          checked_at INTEGER NOT NULL, PRIMARY KEY(wallet, digest)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS claims (
          wallet TEXT NOT NULL, digest BLOB NOT NULL, owner TEXT NOT NULL,
          pid INTEGER NOT NULL, process_started TEXT NOT NULL DEFAULT '', PRIMARY KEY(wallet, digest)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS claims_owner ON claims(owner);
        CREATE TABLE IF NOT EXISTS imports (
          job_id TEXT PRIMARY KEY, next_index INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS ledger_metadata (
          name TEXT PRIMARY KEY, value TEXT NOT NULL
        ) WITHOUT ROWID;
      `);
      const keyDigest = crypto.createHash('sha256').update(this.key).digest('hex');
      this.db.prepare('INSERT OR IGNORE INTO ledger_metadata VALUES (?, ?)').run('key_digest', keyDigest);
      if (this.db.prepare('SELECT value FROM ledger_metadata WHERE name=?').get('key_digest').value !== keyDigest) {
        throw new Error('LEDGER_KEY_MISMATCH');
      }
      if (!this.db.prepare('PRAGMA table_info(claims)').all().some(({ name }) => name === 'process_started')) {
        this.db.exec("ALTER TABLE claims ADD COLUMN process_started TEXT NOT NULL DEFAULT ''");
      }
      this.db.exec('PRAGMA user_version=2');
      this.readCheck = this.db.prepare('SELECT matched FROM checks WHERE wallet=? AND digest=?');
      this.readClaim = this.db.prepare('SELECT owner, pid, process_started FROM claims WHERE wallet=? AND digest=?');
      this.insertCheck = this.db.prepare('INSERT OR IGNORE INTO checks VALUES (?, ?, ?, ?)');
      this.insertClaim = this.db.prepare('INSERT INTO claims VALUES (?, ?, ?, ?, ?)');
      this.deleteClaim = this.db.prepare('DELETE FROM claims WHERE wallet=? AND digest=?');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  digest(candidate) {
    if (typeof candidate !== 'string') throw new Error('LEDGER_CANDIDATE_INVALID');
    return crypto.createHmac('sha256', this.key).update(normalizeCandidate(candidate), 'utf8').digest();
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the storage failure. */ }
      throw error;
    }
  }

  lookup(digest) {
    const result = this.readCheck.get(this.walletHash, digest);
    return result ? { status: 'complete', matched: result.matched === 1 } : null;
  }

  claim(digest) {
    const known = this.lookup(digest);
    if (known) return known;
    return this.transaction(() => {
      const completed = this.lookup(digest);
      if (completed) return completed;
      const claim = this.readClaim.get(this.walletHash, digest);
      // Never steal a live process's work based on elapsed time: scrypt can be
      // slow or the computer asleep. A crashed process's unrecorded check is
      // uncertain and must be retried, not marked completed.
      if (claim && processExists(claim.pid)) {
        const identity = claim.pid === process.pid ? this.processStarted : processIdentity(claim.pid);
        if (!identity || !claim.process_started || identity === claim.process_started) return { status: 'busy' };
      }
      if (claim) this.deleteClaim.run(this.walletHash, digest);
      this.insertClaim.run(this.walletHash, digest, this.owner, process.pid, this.processStarted);
      return { status: 'claimed' };
    });
  }

  complete(digest, matched) {
    if (typeof matched !== 'boolean') throw new Error('LEDGER_RESULT_INVALID');
    this.transaction(() => {
      const claim = this.readClaim.get(this.walletHash, digest);
      if (!claim || claim.owner !== this.owner) throw new Error('LEDGER_CLAIM_LOST');
      this._record(digest, matched);
      this.deleteClaim.run(this.walletHash, digest);
    });
  }

  _record(digest, matched) {
    const existing = this.lookup(digest);
    if (existing && existing.matched !== matched) throw new Error('LEDGER_RESULT_CONFLICT');
    this.insertCheck.run(this.walletHash, digest, Number(matched), Date.now());
  }

  importedThrough(jobId) {
    return this.db.prepare('SELECT next_index FROM imports WHERE job_id=?').get(jobId)?.next_index || 0;
  }

  recordCoverage(jobId, nextIndex) {
    this.db.prepare(`INSERT INTO imports VALUES (?, ?) ON CONFLICT(job_id)
      DO UPDATE SET next_index=MAX(next_index, excluded.next_index)`).run(jobId, nextIndex);
  }

  importBatch(jobId, nextIndex, results) {
    this.transaction(() => {
      for (const { candidate, matched } of results) this._record(this.digest(candidate), matched);
      this.recordCoverage(jobId, nextIndex);
    });
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS count FROM checks WHERE wallet=?').get(this.walletHash).count;
  }

  releaseClaims() {
    if (!this.closed) this.db.prepare('DELETE FROM claims WHERE owner=?').run(this.owner);
  }

  close() {
    if (this.closed) return;
    try { this.releaseClaims(); } finally {
      this.db.close();
      this.key.fill(0);
      this.closed = true;
    }
  }
}

module.exports = { LEDGER_VERSION, SearchLedger };
