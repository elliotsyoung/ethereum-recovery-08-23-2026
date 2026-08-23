const fs = require('node:fs');
const path = require('node:path');

function defaultCheckpoint() {
  return {
    candidateIndex: 0,
    totalAttempted: 0,
    startedAt: null,
    lastCheckpointAt: null,
    elapsedMs: 0,
    currentPattern: 'n/a',
    matchesFound: 0,
    state: 'idle'
  };
}

function atomicWriteJson(filePath, data) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function saveCheckpoint(filePath, checkpoint) {
  const merged = { ...defaultCheckpoint(), ...checkpoint };
  atomicWriteJson(filePath, merged);
  return merged;
}

function loadCheckpoint(filePath) {
  const fallback = defaultCheckpoint();
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    return { ...fallback, ...parsed };
  } catch (error) {
    return fallback;
  }
}

module.exports = {
  atomicWriteJson,
  defaultCheckpoint,
  loadCheckpoint,
  saveCheckpoint
};
