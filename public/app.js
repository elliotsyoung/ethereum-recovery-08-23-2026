const state = {
  samples: []
};

const els = {
  stateValue: document.getElementById('stateValue'),
  totalGuessesValue: document.getElementById('totalGuessesValue'),
  guessesPerSecondValue: document.getElementById('guessesPerSecondValue'),
  guessesPerHourValue: document.getElementById('guessesPerHourValue'),
  elapsedValue: document.getElementById('elapsedValue'),
  candidateIndexValue: document.getElementById('candidateIndexValue'),
  currentPatternValue: document.getElementById('currentPatternValue'),
  candidateSpaceValue: document.getElementById('candidateSpaceValue'),
  completeValue: document.getElementById('completeValue'),
  remainingValue: document.getElementById('remainingValue'),
  checkpointValue: document.getElementById('checkpointValue'),
  matchesValue: document.getElementById('matchesValue'),
  progressBar: document.getElementById('progressBar'),
  patternJson: document.getElementById('patternJson'),
  candidateEstimate: document.getElementById('candidateEstimate'),
  modeSelect: document.getElementById('modeSelect'),
  chartCanvas: document.getElementById('chartCanvas')
};

function formatDuration(ms) {
  if (!ms || ms < 1000) return `${Number(ms || 0).toFixed(0)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function renderChart() {
  const canvas = els.chartCanvas;
  const context = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#09111d';
  context.fillRect(0, 0, width, height);

  if (!state.samples.length) {
    context.fillStyle = '#9db4d5';
    context.font = '12px sans-serif';
    context.fillText('No activity yet', 14, 24);
    return;
  }

  const maxValue = Math.max(...state.samples, 1);
  const minValue = 0;
  context.strokeStyle = '#2d4366';
  context.beginPath();
  context.moveTo(18, 12);
  context.lineTo(18, height - 18);
  context.lineTo(width - 14, height - 18);
  context.stroke();

  context.beginPath();
  const mid = height - 18;
  state.samples.forEach((sample, index) => {
    const x = 18 + (index / Math.max(state.samples.length - 1, 1)) * (width - 34);
    const y = mid - ((sample - minValue) / Math.max(maxValue - minValue, 1)) * (height - 42);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.strokeStyle = '#5cc8ff';
  context.lineWidth = 2;
  context.stroke();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  return response.json();
}

async function loadPatterns() {
  const data = await fetchJson('/api/patterns');
  els.patternJson.value = JSON.stringify({
    patterns: data.patterns,
    capitalization: data.capitalization,
    mutations: data.mutations
  }, null, 2);
  updateCandidateEstimate(data.candidateSpace);
}

function updateCandidateEstimate(space) {
  els.candidateEstimate.textContent = `Estimated candidates: ${Number(space || 0).toLocaleString()}`;
}

function updateStatus(data) {
  const total = Number(data.totalCandidateSpace || 1);
  const percent = Number(data.completionPercent || 0);
  const elapsed = Number(data.elapsedMs || 0);
  els.stateValue.textContent = data.state || 'idle';
  els.totalGuessesValue.textContent = formatNumber(data.totalGuesses);
  els.guessesPerSecondValue.textContent = Number(data.guessesPerSecond || 0).toFixed(2);
  els.guessesPerHourValue.textContent = formatNumber(Number(data.guessesPerHour || 0).toFixed(0));
  els.elapsedValue.textContent = formatDuration(elapsed);
  els.candidateIndexValue.textContent = formatNumber(data.candidateIndex || 0);
  els.currentPatternValue.textContent = data.currentPattern || 'n/a';
  els.candidateSpaceValue.textContent = formatNumber(total);
  els.completeValue.textContent = `${percent.toFixed(2)}%`;
  els.progressBar.style.width = `${Math.min(percent, 100)}%`;
  els.remainingValue.textContent = formatDuration(Number((data.estimatedTimeRemaining || 0) * 1000));
  els.checkpointValue.textContent = data.lastCheckpointAt ? new Date(data.lastCheckpointAt).toLocaleTimeString() : 'n/a';
  els.matchesValue.textContent = formatNumber(data.matchesFound || 0);

  if (Number(data.totalGuesses || 0) > 0 && state.samples[state.samples.length - 1] !== Number(data.totalGuesses)) {
    state.samples.push(Number(data.totalGuesses));
    if (state.samples.length > 40) {
      state.samples.shift();
    }
  }
  renderChart();
}

async function refreshStatus() {
  const data = await fetchJson('/api/status');
  updateStatus(data);
}

async function startRecovery() {
  const payload = {
    mode: els.modeSelect.value
  };
  const result = await fetchJson('/api/recovery/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (result.ok === false) {
    alert(result.error || 'Unable to start recovery.');
    return;
  }
  await refreshStatus();
}

async function savePatterns() {
  try {
    const payload = JSON.parse(els.patternJson.value);
    const result = await fetchJson('/api/patterns', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    updateCandidateEstimate(result.candidateSpace);
    await refreshStatus();
  } catch (error) {
    alert('Pattern JSON is invalid.');
  }
}

async function benchmark() {
  const response = await fetchJson('/api/benchmark', {
    method: 'POST'
  });
  if (!response.ok) {
    alert(response.error || 'Benchmark failed');
    return;
  }
  alert(`Benchmark complete: ${Number(response.result.guessesPerSecond || 0).toFixed(2)} guesses/sec`);
  await refreshStatus();
}

document.getElementById('startBtn').addEventListener('click', startRecovery);
document.getElementById('pauseBtn').addEventListener('click', async () => {
  await fetchJson('/api/recovery/pause', { method: 'POST' });
  await refreshStatus();
});
document.getElementById('resumeBtn').addEventListener('click', async () => {
  await fetchJson('/api/recovery/resume', { method: 'POST' });
  await refreshStatus();
});
document.getElementById('stopBtn').addEventListener('click', async () => {
  await fetchJson('/api/recovery/stop', { method: 'POST' });
  await refreshStatus();
});
document.getElementById('savePatternsBtn').addEventListener('click', savePatterns);
document.getElementById('benchmarkBtn').addEventListener('click', benchmark);

loadPatterns();
refreshStatus();
setInterval(refreshStatus, 1500);
