const path = require('node:path');
const { parseArgs } = require('node:util');
const { candidateForUniqueIndex } = require('./recovery/candidateGenerator');
const { loadStoredJob } = require('./recovery/jobStore');
const {
  confirmCandidate,
  normalizeCandidate,
  preflightKeystore,
  verifyCandidate
} = require('./recovery/walletVerifier');

function parseRevealOptions(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      job: { type: 'string' },
      wallet: { type: 'string' },
      'runtime-dir': { type: 'string' }
    },
    strict: true
  });
  if (!values.job) {
    throw new Error('JOB_ID_REQUIRED');
  }
  if (values.wallet && !path.isAbsolute(values.wallet)) {
    throw new Error('REVEAL_WALLET_ABSOLUTE_PATH_REQUIRED');
  }
  return {
    jobId: values.job,
    walletPath: values.wallet || null,
    runtimeDir: values['runtime-dir'] || null
  };
}

async function revealPassword({ jobId, walletPath = null, runtimeDir = null }) {
  const job = loadStoredJob({ jobId, runtimeDir });
  if (job.checkpoint.state !== 'found' || job.checkpoint.matchedUniqueIndex === null) {
    throw new Error('MATCH_NOT_FOUND');
  }
  const selectedWalletPath = walletPath || job.manifest.walletPath;
  if (!path.isAbsolute(selectedWalletPath)) {
    throw new Error('REVEAL_WALLET_ABSOLUTE_PATH_REQUIRED');
  }
  const wallet = preflightKeystore(selectedWalletPath);
  if (wallet.walletHash !== job.manifest.walletHash
      || wallet.address.toLowerCase() !== job.manifest.walletAddress.toLowerCase()
      || wallet.verificationContext.N !== job.manifest.kdf.N
      || wallet.verificationContext.r !== job.manifest.kdf.r
      || wallet.verificationContext.p !== job.manifest.kdf.p
      || wallet.verificationContext.dklen !== job.manifest.kdf.dklen) {
    throw new Error('WALLET_FINGERPRINT_MISMATCH');
  }

  const candidate = normalizeCandidate(candidateForUniqueIndex(
    job.config,
    job.candidatePlan,
    job.checkpoint.matchedUniqueIndex
  ));
  if (!verifyCandidate(wallet.verificationContext, candidate)) {
    throw new Error('MATCH_RECHECK_FAILED');
  }
  if (!await confirmCandidate(wallet.rawJson, candidate, wallet.address)) {
    throw new Error('MATCH_CONFIRMATION_FAILED');
  }
  return candidate;
}

if (require.main === module) {
  let options;
  try {
    options = parseRevealOptions();
  } catch (error) {
    process.stderr.write(`Reveal failed: ${error.message}\n`);
    process.exitCode = 1;
  }
  if (options) {
    revealPassword(options)
      .then((password) => process.stdout.write(password))
      .catch((error) => {
        const code = typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
          ? error.message
          : 'REVEAL_FAILED';
        process.stderr.write(`Reveal failed: ${code}\n`);
        process.exitCode = 1;
      });
  }
}

module.exports = {
  parseRevealOptions,
  revealPassword
};
