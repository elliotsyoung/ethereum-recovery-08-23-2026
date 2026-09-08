const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_RUNTIME_DIR, resolveRuntimeDir } = require('../server/runtime');

function testFilesUnder(directoryPath) {
  const files = [];
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...testFilesUnder(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function snapshotTree(rootPath) {
  if (!fs.existsSync(rootPath)) return { exists: false, entries: [] };
  const entries = [];

  function visit(currentPath) {
    const stat = fs.lstatSync(currentPath);
    const relativePath = path.relative(rootPath, currentPath) || '.';
    const entry = {
      path: relativePath,
      mode: stat.mode & 0o777,
      type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file'
    };
    if (stat.isSymbolicLink()) {
      entry.hash = crypto.createHash('sha256').update(fs.readlinkSync(currentPath)).digest('hex');
    } else if (stat.isFile()) {
      entry.size = stat.size;
      entry.hash = crypto.createHash('sha256').update(fs.readFileSync(currentPath)).digest('hex');
    }
    entries.push(entry);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(currentPath).sort()) {
        visit(path.join(currentPath, name));
      }
    }
  }

  visit(rootPath);
  return { exists: true, entries };
}

const runtimeDir = resolveRuntimeDir(process.env.RECOVERY_DATA_DIR || DEFAULT_RUNTIME_DIR);
const before = snapshotTree(runtimeDir);
const projectRoot = path.resolve(__dirname, '..');
const result = spawnSync(process.execPath, [
  '--test',
  ...testFilesUnder(path.join(projectRoot, 'test'))
], {
  cwd: projectRoot,
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: 'inherit'
});
const after = snapshotTree(runtimeDir);

if (JSON.stringify(before) !== JSON.stringify(after)) {
  process.stderr.write('Test isolation failure: application runtime state changed.\n');
  process.exitCode = 1;
} else if (result.error) {
  process.stderr.write('Test runner failed to start.\n');
  process.exitCode = 1;
} else if (result.signal) {
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
