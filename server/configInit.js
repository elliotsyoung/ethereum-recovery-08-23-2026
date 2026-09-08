const path = require('node:path');
const { parseArgs } = require('node:util');
const {
  atomicCreatePrivate,
  ensurePrivateDirectory,
  readJsonFile,
  resolveRuntimeDir
} = require('./runtime');
const { EXAMPLE_PATTERNS_PATH } = require('./recovery/jobStore');

function initializeConfig({ runtimeDir: runtimeInput = null, outputPath = null } = {}) {
  const runtimeDir = ensurePrivateDirectory(resolveRuntimeDir(runtimeInput));
  const target = outputPath ? path.resolve(outputPath) : path.join(runtimeDir, 'patterns.json');
  if (outputPath && !path.isAbsolute(outputPath)) {
    throw new Error('PATTERNS_OUTPUT_PATH_MUST_BE_ABSOLUTE');
  }
  const example = readJsonFile(EXAMPLE_PATTERNS_PATH, { label: 'PATTERNS_EXAMPLE' });
  try {
    atomicCreatePrivate(target, `${JSON.stringify(example, null, 2)}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('PATTERNS_FILE_ALREADY_EXISTS');
    }
    throw error;
  }
  return target;
}

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        out: { type: 'string' },
        'runtime-dir': { type: 'string' }
      }
    });
    const target = initializeConfig({
      runtimeDir: values['runtime-dir'],
      outputPath: values.out
    });
    process.stdout.write(`${target}\n`);
  } catch (error) {
    process.stderr.write(`Configuration was not created: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { initializeConfig };
