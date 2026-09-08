const crypto = require('node:crypto');
const path = require('node:path');
const { parseArgs } = require('node:util');
const express = require('express');
const { prepareJob, releaseJobLock } = require('./recovery/jobStore');
const { RecoveryEngine, RecoveryStateError } = require('./recovery/recoveryEngine');

const PUBLIC_DIR = path.resolve(__dirname, '../public');
const DEFAULT_PORT = 3000;

function loopbackOrigin(localPort) {
  return localPort === 80
    ? 'http://127.0.0.1'
    : `http://127.0.0.1:${localPort}`;
}

function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function createApp(engine, { sessionToken = crypto.randomBytes(32).toString('base64url') } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const expectedHost = loopbackOrigin(req.socket.localPort).slice('http://'.length);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    if (req.headers.host !== expectedHost) {
      return res.status(403).json({ ok: false, errorCode: 'HOST_REJECTED' });
    }
    next();
  });

  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const expectedOrigin = loopbackOrigin(req.socket.localPort);
    const contentType = String(req.headers['content-type'] || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (req.headers.origin !== expectedOrigin) {
      return res.status(403).json({ ok: false, errorCode: 'ORIGIN_REJECTED' });
    }
    if (contentType !== 'application/json') {
      return res.status(415).json({ ok: false, errorCode: 'JSON_REQUIRED' });
    }
    if (!safeTokenEqual(req.headers['x-recovery-session'], sessionToken)) {
      return res.status(403).json({ ok: false, errorCode: 'SESSION_REJECTED' });
    }
    next();
  });

  app.use(express.json({ limit: '1kb', type: 'application/json' }));

  app.get('/api/session', (req, res) => {
    res.json({ token: sessionToken });
  });

  app.get('/api/status', (req, res) => {
    res.json(engine.getStatus());
  });

  function operation(handler) {
    return async (req, res) => {
      try {
        const status = await handler();
        res.json({ ok: true, status });
      } catch (error) {
        if (error instanceof RecoveryStateError) {
          res.status(error.statusCode).json({ ok: false, errorCode: error.code });
          return;
        }
        res.status(500).json({ ok: false, errorCode: 'OPERATION_FAILED' });
      }
    };
  }

  app.post('/api/recovery/start', operation(() => engine.start()));
  app.post('/api/recovery/pause', operation(() => engine.pause()));
  app.post('/api/recovery/resume', operation(() => engine.resume()));
  app.post('/api/recovery/stop', operation(() => engine.stop()));
  app.post('/api/benchmark', operation(() => engine.calibrate()));

  app.use(express.static(PUBLIC_DIR, { etag: false, lastModified: false }));
  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, errorCode: 'NOT_FOUND' });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, errorCode: 'REQUEST_TOO_LARGE' });
    }
    if (error instanceof SyntaxError && error?.status === 400) {
      return res.status(400).json({ ok: false, errorCode: 'INVALID_JSON' });
    }
    return res.status(500).json({ ok: false, errorCode: 'INTERNAL_ERROR' });
  });
  return app;
}

function parseServerOptions(
  argv = process.argv.slice(2),
  processMode = process.env.RECOVERY_MODE || 'DEMO'
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      wallet: { type: 'string' },
      patterns: { type: 'string' },
      workers: { type: 'string', default: 'auto' },
      fresh: { type: 'boolean', default: false },
      port: { type: 'string', default: String(process.env.PORT || DEFAULT_PORT) },
      'runtime-dir': { type: 'string' }
    }
  });
  const mode = String(processMode).toUpperCase();
  const port = Number(values.port);
  if (!['DEMO', 'REAL'].includes(mode)) throw new Error('MODE_INVALID');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT_INVALID');
  if (!['auto', '1', '2', '3', '4'].includes(values.workers)) {
    throw new Error('WORKER_SETTING_INVALID');
  }
  if (mode === 'REAL' && (!values.wallet || !path.isAbsolute(values.wallet))) {
    throw new Error('REAL_WALLET_ABSOLUTE_PATH_REQUIRED');
  }
  if (mode === 'DEMO' && (values.wallet || values.patterns)) {
    throw new Error('DEMO_EXTERNAL_INPUT_NOT_ALLOWED');
  }
  if (values.patterns && !path.isAbsolute(values.patterns)) {
    throw new Error('PATTERNS_PATH_MUST_BE_ABSOLUTE');
  }
  return {
    mode,
    port,
    walletPath: values.wallet,
    patternsPath: values.patterns,
    workerSetting: values.workers,
    fresh: values.fresh,
    runtimeDir: values['runtime-dir']
  };
}

async function startServer(options, { onLockLost = null, onServerError = null } = {}) {
  const job = await prepareJob({ ...options, acquireLock: true });
  let engine;
  let server;
  let lockLossError = null;
  let serverRuntimeError = null;
  let shutdownPromise = null;

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let shutdownError = lockLossError;
      if (engine) {
        try {
          await engine.shutdown({ persist: lockLossError === null && !job.lock.lost });
        } catch (error) {
          shutdownError ||= error;
        }
      }
      if (server?.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (!job.lock.lost) {
        try {
          await releaseJobLock(job.lock);
        } catch (error) {
          shutdownError ||= error;
        }
      }
      if (job.lock.lost && !lockLossError) {
        lockLossError = new Error('JOB_LOCK_LOST');
      }
      shutdownError ||= lockLossError;
      shutdownError ||= serverRuntimeError;
      if (shutdownError) throw shutdownError;
    })();
    return shutdownPromise;
  };

  job.lock.onLost = () => {
    if (lockLossError) return;
    lockLossError = new Error('JOB_LOCK_LOST');
    if (engine) {
      void engine.shutdown({ persist: false }).catch(() => {
        // The outer shutdown path still closes the HTTP server.
      });
    }
    if (typeof onLockLost === 'function') {
      try {
        onLockLost(lockLossError);
      } catch {
        // Lock loss remains fatal even if the notification callback fails.
      }
    }
    void shutdown().catch(() => {
      // The caller receives JOB_LOCK_LOST if it later awaits shutdown.
    });
  };

  if (job.lock.lost || job.lock.child.exitCode !== null) {
    job.lock.onLost();
  }
  try {
    if (lockLossError) throw lockLossError;
    engine = new RecoveryEngine(job, { workerSetting: options.workerSetting });
    await engine.initialize();
    if (lockLossError) throw lockLossError;
    const app = createApp(engine);
    await new Promise((resolve, reject) => {
      const listening = () => {
        server.off('error', reject);
        resolve();
      };
      server = app.listen(options.port, '127.0.0.1');
      server.once('error', reject);
      server.once('listening', listening);
    });
    if (lockLossError) {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      throw lockLossError;
    }
    server.on('error', () => {
      if (serverRuntimeError) return;
      serverRuntimeError = new Error('HTTP_SERVER_FAILURE');
      if (typeof onServerError === 'function') {
        try {
          onServerError(serverRuntimeError);
        } catch {
          // A runtime server error still shuts recovery down if notification fails.
        }
      }
      void shutdown().catch(() => {
        // The caller receives HTTP_SERVER_FAILURE if it later awaits shutdown.
      });
    });

    const actualPort = server.address().port;
    const origin = loopbackOrigin(actualPort);
    process.stdout.write([
      `Mode: ${job.mode}`,
      `Job: ${job.jobId}`,
      `Wallet address: ${job.wallet.address}`,
      `Wallet fingerprint: ${job.wallet.walletHash.slice(0, 16)}`,
      `Candidates: ${job.candidatePlan.uniqueCount} unique (${job.candidatePlan.duplicateCount} duplicates removed)`,
      `Workers: ${engine.workerCount}`,
      `Dashboard: ${origin}`
    ].join('\n') + '\n');

    return { app, engine, job, server, shutdown };
  } catch (error) {
    try {
      await shutdown();
    } catch {
      // Preserve the startup error after stopping workers and releasing ownership.
    }
    throw error;
  }
}

if (require.main === module) {
  let runtime;
  try {
    const options = parseServerOptions();
    startServer(options, {
      onLockLost: () => {
        process.stderr.write('Recovery stopped: JOB_LOCK_LOST\n');
        process.exitCode = 1;
      },
      onServerError: () => {
        process.stderr.write('Recovery stopped: HTTP_SERVER_FAILURE\n');
        process.exitCode = 1;
      }
    }).then((result) => {
      runtime = result;
      const onSignal = () => {
        runtime.shutdown()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    }).catch((error) => {
      process.stderr.write(`Startup failed: ${error.message}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`Startup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  createApp,
  parseServerOptions,
  startServer
};
