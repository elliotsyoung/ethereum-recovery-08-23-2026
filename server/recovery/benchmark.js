const { performance } = require('node:perf_hooks');
const { verifyCandidate, ensureDemoWallet, readKeystoreFile } = require('./walletVerifier');
const { generateCandidate, getDefaultPatternConfig } = require('./candidateGenerator');

async function runBenchmark({ iterations = 5000, config = getDefaultPatternConfig() } = {}) {
  const walletPath = await ensureDemoWallet();
  const keystore = readKeystoreFile(walletPath);
  const start = performance.now();
  let checks = 0;
  let badMatches = 0;
  for (let i = 0; i < iterations; i += 1) {
    const candidate = generateCandidate(config, i);
    if (verifyCandidate(keystore, candidate)) {
      badMatches += 1;
    }
    checks += 1;
  }
  const elapsedMs = performance.now() - start;
  const guessesPerSecond = checks / (elapsedMs / 1000);
  const msPerGuess = elapsedMs / checks;
  const guessesPerHour = guessesPerSecond * 60 * 60;
  const guessesPerDay = guessesPerSecond * 60 * 60 * 24;

  const spaces = [10000, 100000, 1000000, 10000000, 100000000, 1000000000];
  const estimatedForSpace = spaces.map((space) => ({
    space,
    seconds: space / guessesPerSecond,
    hours: (space / guessesPerSecond) / 3600,
    days: (space / guessesPerSecond) / 86400
  }));

  return {
    iterations: checks,
    status: 'ok',
    guessesPerSecond,
    msPerGuess,
    guessesPerHour,
    guessesPerDay,
    estimatedForSpace,
    badMatches,
    elapsedMs
  };
}

if (require.main === module) {
  runBenchmark().then((result) => {
    console.log('Benchmark results');
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error('Benchmark failed:', error);
    process.exit(1);
  });
}

module.exports = { runBenchmark };
