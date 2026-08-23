const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const recoveryEngine = require('./recovery/recoveryEngine');
const { getDefaultPatternConfig, calculateCandidateSpace } = require('./recovery/candidateGenerator');
const { loadCheckpoint, saveCheckpoint } = require('./recovery/checkpoint');
const { ensureDemoWallet, readKeystoreFile } = require('./recovery/walletVerifier');
const { runBenchmark } = require('./recovery/benchmark');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(__dirname, '../data');
const PATTERN_FILE = path.resolve(DATA_DIR, 'patterns.json');
const CHECKPOINT_FILE = path.resolve(DATA_DIR, 'checkpoint.json');
const PUBLIC_DIR = path.resolve(__dirname, '../public');

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PATTERN_FILE)) {
    fs.writeFileSync(PATTERN_FILE, JSON.stringify(getDefaultPatternConfig(), null, 2), 'utf8');
  }
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    saveCheckpoint(CHECKPOINT_FILE, { candidateIndex: 0, totalAttempted: 0, startedAt: null, lastCheckpointAt: null, elapsedMs: 0, currentPattern: 'n/a', matchesFound: 0, state: 'idle' });
  }
}

function readPatterns() {
  ensureDataFiles();
  const raw = fs.readFileSync(PATTERN_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed;
}

function writePatterns(patterns) {
  ensureDataFiles();
  fs.writeFileSync(PATTERN_FILE, JSON.stringify(patterns, null, 2), 'utf8');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/status', (req, res) => {
  const checkpoint = loadCheckpoint(CHECKPOINT_FILE);
  const status = recoveryEngine.getStatus();
  const patternConfig = readPatterns();
  const candidateSpace = calculateCandidateSpace(patternConfig);
  const total = Math.max(candidateSpace, 1);
  const percentComplete = status.candidateIndex && total > 0 ? (status.candidateIndex / total) * 100 : 0;
  const benchmarkStats = status.benchmark || null;

  res.json({
    mode: status.mode || 'DEMO',
    state: status.state || 'idle',
    totalGuesses: Number(status.totalAttempted || checkpoint.totalAttempted || 0),
    guessesPerSecond: benchmarkStats ? benchmarkStats.guessesPerSecond : 0,
    guessesPerHour: benchmarkStats ? benchmarkStats.guessesPerHour : 0,
    elapsedMs: Number(status.elapsedMs || checkpoint.elapsedMs || 0),
    candidateIndex: Number(status.candidateIndex || checkpoint.candidateIndex || 0),
    currentPattern: status.currentPattern || checkpoint.currentPattern || 'n/a',
    totalCandidateSpace: total,
    completionPercent: Number(percentComplete.toFixed(5)),
    estimatedTimeRemaining: Number((Math.max(total - status.candidateIndex, 0) / Math.max(benchmarkStats?.guessesPerSecond || 1, 1)).toFixed(2)),
    lastCheckpointAt: checkpoint.lastCheckpointAt || null,
    matchesFound: Number(status.matchesFound || checkpoint.matchesFound || 0),
    benchmark: benchmarkStats,
    startedAt: checkpoint.startedAt || status.startedAt || null
  });
});

app.post('/api/recovery/start', async (req, res) => {
  const mode = String(req.body?.mode || 'DEMO').toUpperCase();
  const config = readPatterns();

  if (!['DEMO', 'REAL'].includes(mode)) {
    return res.status(400).json({ error: 'Mode must be DEMO or REAL.' });
  }

  try {
    const result = await recoveryEngine.start({
      mode,
      config,
      checkpointPath: CHECKPOINT_FILE,
      walletPath: req.body?.walletPath || process.env.WALLET_PATH || null
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error.message || error) });
  }
});

app.post('/api/recovery/pause', (req, res) => {
  const result = recoveryEngine.pause();
  res.json(result);
});

app.post('/api/recovery/resume', (req, res) => {
  const result = recoveryEngine.resume();
  res.json(result);
});

app.post('/api/recovery/stop', (req, res) => {
  const result = recoveryEngine.stop();
  res.json(result);
});

app.get('/api/patterns', (req, res) => {
  const config = readPatterns();
  const total = calculateCandidateSpace(config);
  res.json({
    ok: true,
    patterns: config.patterns,
    candidateSpace: total,
    capitalization: config.capitalization,
    mutations: config.mutations
  });
});

app.put('/api/patterns', (req, res) => {
  const nextConfig = req.body;
  if (!nextConfig || !Array.isArray(nextConfig.patterns)) {
    return res.status(400).json({ error: 'Patterns payload must include a patterns array.' });
  }
  writePatterns(nextConfig);
  res.json({ ok: true, candidateSpace: calculateCandidateSpace(nextConfig) });
});

app.post('/api/benchmark', async (req, res) => {
  try {
    const result = await runBenchmark({ config: readPatterns() });
    recoveryEngine.status.benchmark = result;
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

ensureDataFiles();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
});
