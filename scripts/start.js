// Bootstrap missing dependencies so a fresh checkout has one launch command.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  process.stderr.write('Ethereum Recovery requires Node 24. Run nvm install && nvm use, then npm start.\n');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'node_modules/express/package.json'))
    || !fs.existsSync(path.join(root, 'node_modules/ethers/package.json'))) {
  process.stdout.write('Installing locked dependencies for the first launch…\n');
  const install = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status || 1);
}
const { parseServerOptions, startServer } = require('../server');
let runtime;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
    if (runtime) await runtime.shutdown();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
};
(async () => {
  try {
    const options = parseServerOptions(['--setup', ...process.argv.slice(2)]);
    runtime = await startServer(options, {
      onLockLost: () => { process.stderr.write('Recovery stopped: JOB_LOCK_LOST\n'); process.exitCode = 1; },
      onServerError: () => { process.stderr.write('Recovery stopped: HTTP_SERVER_FAILURE\n'); process.exitCode = 1; }
    });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(error.message) ? error.message : 'STARTUP_FAILED';
    process.stderr.write(`Startup failed: ${code}\n`);
    process.exitCode = 1;
  }
})();
