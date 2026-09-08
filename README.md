# Local Ethereum Keystore Password Recovery

This is a single-owner, local macOS tool for testing generated password candidates against an Ethereum Web3 Secret Storage V3 keystore. The dashboard is limited to status and recovery controls; wallet selection, pattern configuration, and password reveal are terminal-only.

The process binds only to `127.0.0.1`. It does not use RPC, sign messages or transactions, broadcast transactions, upload files, or move assets. Its final action is to verify and print a recovered password in the local terminal.

## Before using a real wallet

This repository was previously public. Treat every previously published password hint or pattern as disclosed and never reuse it for any credential. Before introducing a real wallet, confirm that the GitHub repository is private and that its reachable history no longer contains the old hint files:

```bash
git rev-list --objects --all | rg '(^| )(data/patterns\.json|copilot-instructions\.md)$'
```

That command must produce no output. Do not commit a real keystore, real pattern file, runtime artifact, recovered password, or private key. Keep an independently secured backup of the original keystore.

## Install and test

Node 24 is required and pinned by `.nvmrc`:

```bash
nvm install 24
nvm use
npm ci
npm test
```

Use `npm ci`, not `npm install`, for a reproducible dependency tree. Tests use temporary runtime directories and must not modify application runtime state.

## Demo

```bash
npm start
```

Open <http://127.0.0.1:3000> and select **Start**. `npm start` always uses DEMO mode; the known demo password is the first unique candidate, so a clean run should reach `found` immediately. The sanitized demo configuration should compile from 462,600 raw candidates to 352,320 unique candidates, removing 110,280 duplicates. The generated demo keystore and all progress remain in the protected runtime directory described below.

`npm run dev` is also DEMO-only. Do not use the development watcher for a real recovery.

## Real recovery

### 1. Create the protected pattern file

```bash
npm run config:init
```

The command prints the new file path and refuses to overwrite an existing file. By default it creates:

```text
~/Library/Application Support/Ethereum Recovery/patterns.json
```

Edit that local file with a trusted editor and keep it mode `0600`. Only the sanitized [`data/patterns.example.json`](data/patterns.example.json) belongs in Git. Keep each prioritized job at or below 10,000,000 raw candidates; split larger searches into smaller, most-likely-first configurations.

To create a protected config at another absolute path:

```bash
npm run config:init -- --out "/absolute/path/patterns.json"
```

Its containing directory must be newly created by the command or already owned by you with mode `0700`; unsafe existing directory permissions are rejected and never changed automatically.

### 2. Preflight the keystore

Use an absolute path to an owner-readable, owner-only regular file. Symlinks and files larger than 1 MiB are rejected.

```bash
WALLET_PATH="/absolute/path/to/wallet.json"
chmod 600 "$WALLET_PATH"
```

Only V3 keystores using `aes-128-ctr`, scrypt, and `dklen=32` are supported. The keystore fields, address, and scrypt parameters are validated before candidate work begins.

### 3. Launch

Keep macOS awake while the process runs:

```bash
caffeinate -i npm run real -- --wallet "$WALLET_PATH" --workers auto
```

If the pattern file is not at its default location, pass it explicitly:

```bash
caffeinate -i npm run real -- \
  --wallet "$WALLET_PATH" \
  --patterns "/absolute/path/patterns.json" \
  --workers auto
```

`--workers auto` benchmarks the wallet's actual KDF at 1, 2, and 4 workers when permitted by the 50%-of-system-memory ceiling, then chooses the fastest measured width. To constrain the run, use `--workers 1`, `2`, `3`, or `4`. Open <http://127.0.0.1:3000>, review readiness and candidate counts, then select **Start**.

The startup output includes the job ID. A job ID binds the mode, exact wallet hash, canonical configuration hash, schema version, and generator version. A different wallet or configuration cannot resume that job.

### Pause, stop, restart, and resume

Pause and Stop return only after a durable checkpoint. `Ctrl-C` or `SIGTERM` checkpoints a running job as `interrupted` before shutdown.

To resume after a restart, run the identical launch command, confirm the same job ID, open the dashboard, and select **Resume**. Active elapsed time excludes paused and offline time. Work that was in flight at shutdown can repeat, but no candidate index is skipped.

To intentionally restart the same job from index zero, append `--fresh` to the launch command. The prior compatible checkpoint is timestamp-archived in the job directory; it is not deleted.

### Reveal a found password

The dashboard reports that a match exists but never returns the password. After the state is `found`, use the printed job ID:

```bash
npm run reveal -- --job "<jobId>" --wallet "$WALLET_PATH"
```

`--wallet` is optional while the wallet remains at the path recorded in the protected manifest. Reveal verifies the wallet and configuration fingerprints, regenerates the matched candidate from the immutable snapshot, and confirms the address with ethers before writing the password to terminal stdout. No plaintext result file is created. Run it in a private terminal and do not redirect, pipe, log, or paste its output.

## Runtime data and permissions

The default runtime root is:

```text
~/Library/Application Support/Ethereum Recovery/
```

It contains the real `patterns.json`, a protected demo keystore, and per-job directories:

```text
jobs/<jobId>/
  manifest.json
  patterns.json
  candidate-index.bin
  checkpoint.json
  benchmark.json
  recovery.lock
  checkpoint.<timestamp>.<nonce>.json   # only after --fresh
```

Runtime directories are enforced as `0700` and files as `0600`. The index map stores integer raw indexes, not candidate strings. Checkpoints store counters, timing, state, and at most the matched unique index—never a candidate or password.

The HTTP service accepts no wallet path, pattern values, mode changes, or reveal request. Mutations require the current per-process session token and same loopback Origin; Host validation, no-CORS behavior, CSP/frame denial, disabled caching, and sanitized API errors are enforced. Do not expose the port through a LAN bind, proxy, tunnel, container port, or cloud deployment.

## Target-cost restart/soak gate

Before using the real wallet, exercise the production KDF cost with the included `N=262144, r=8, p=1` fixture while keeping test state isolated:

```bash
SOAK_ROOT="$(mktemp -d /tmp/ethereum-recovery-soak.XXXXXX)"
chmod 700 "$SOAK_ROOT"
cp test/fixtures/target-cost-v3.json "$SOAK_ROOT/wallet.json"
chmod 600 "$SOAK_ROOT/wallet.json"
RECOVERY_DATA_DIR="$SOAK_ROOT/runtime" npm run config:init
RECOVERY_DATA_DIR="$SOAK_ROOT/runtime" caffeinate -i npm run real -- \
  --wallet "$SOAK_ROOT/wallet.json" \
  --workers auto
```

Run the dashboard long enough to observe stable rate, temperature, memory pressure, and a periodic checkpoint. Record the job ID and committed index, then press `Ctrl-C`. Repeat the identical command, verify the same job ID and nondecreasing committed index, select **Resume**, and exercise Pause and Stop. For a complete found/reveal rehearsal, make a separate protected test-only pattern config whose final candidate is the fixture password documented by the tests (`Alpha1!`), pass it with `--patterns`, interrupt before that index, resume to `found`, and run:

```bash
RECOVERY_DATA_DIR="$SOAK_ROOT/runtime" npm run reveal -- \
  --job "<fixtureJobId>" \
  --wallet "$SOAK_ROOT/wallet.json"
```

Do not begin the real-wallet run until checkpoint restart, dashboard control, worker selection, and terminal reveal all behave as expected on this fixture.

## Operational boundaries

- Keep the machine offline except when installing already-reviewed dependencies.
- Never upload the wallet or patterns to GitHub, cloud storage, issue trackers, AI chats, or browser forms.
- Do not use remote access, tunnels, or browser extensions during recovery.
- After recovery, handle any asset migration separately with a trusted wallet workflow; this project deliberately contains no signing or broadcasting path.
