# Local Ethereum Password Recovery

A local dashboard for recovering a forgotten Ethereum keystore password from likely two-word combinations. Enter what you remember, preview the exact search size, and follow the search with saved progress and a rough completion estimate.

Requires **macOS and Node 24**. macOS supplies `lockf`, which prevents two processes from working on the same job. Node is pinned in `.nvmrc`; if needed, run `nvm install` and `nvm use` once.

## Start

```bash
npm start
```

The launcher installs missing dependencies with `npm ci` on first launch, then serves the dashboard at <http://127.0.0.1:3000>. Dependency installation requires network access; recovery itself runs locally. Open the printed address and choose **Try the demo** for a complete rehearsal, or **Recover my wallet** to configure your search. The guided demo searches 1,000 candidates and finds its known test password.

For a real wallet, use an absolute path to a local keystore JSON file owned by your account with owner-only permissions:

```bash
chmod 600 "/absolute/path/to/wallet.json"
```

The form sends the path and search settings only to the local server. The original wallet is read without modification. Supported files are Ethereum Web3 Secret Storage **V3**, using **scrypt**, **aes-128-ctr**, and **dklen=32**, with a maximum size of 1 MiB. PBKDF2 keystores and symbolic links are unsupported.

To keep macOS awake during a long search:

```bash
caffeinate -i npm start
```

## Set up the search

The form asks for three groups of information:

1. **Wallet:** the local keystore path, or demo mode.
2. **Words and length:** likely first and second words, plus minimum and maximum password length. Supply up to 200 distinct words per list, separated by spaces, commas, or newlines. Leave the second list blank to reuse the first list and try every pairing, including both orders.
3. **Digits and symbols:** minimum and maximum counts, plus the possible symbols. Capitalization, placement, and combination modes are available under the refinement controls.

Words contain English keyboard letters `A–Z` and `a–z`, with 1–32 letters per word. The total password length can be 2–64 characters. Digits are `0–9`; symbols are the shifted US English keyboard characters:

```text
! @ # $ % ^ & * ( ) _ + { } | : " < > ? ~
```

Digit and symbol counts are separate. Defaults are 8–24 total characters, exactly **two digits**, and **two to four symbols**. This accommodates uncertainty between remembering four nonletters and four symbols. Set the symbol minimum to four if you are confident there were at least four symbols. Each count can range from 0 to 12.

**Repeated** mode searches one repeated character per group: `22`, `777`, `!!`, or `####`. **All combinations** also covers mixed groups such as `27` and `!?`, including leading zeroes for numbers. Repeated digits apply separately to each group in the split layout, so its two groups can differ.

| Layout | Structure | Illustrative candidate |
| --- | --- | --- |
| Suffix | word + word + digits + symbols | `RiverStone22!!` |
| Between | word + digits + word + symbols | `River22Stone!!` |
| Split | word + digits + word + digits + symbols | `River2Stone7!!` |

All three layouts are selected by default. Between needs at least one digit; split needs at least two and tries every nonempty division of the digit count. Symbols are a trailing group in these layouts. Title case and lowercase are selected by default; uppercase and “as entered” are also available. A selected case style applies to both words together. “As entered” preserves the spelling and capitalization in your lists.

Select **Preview search** to see the count, then **Prepare search** to validate the wallet and measure its actual verification speed. Review the estimate and select **Start recovery**. Automatic calibration measures 1, 2, and 4 workers when their estimated memory fits within half of system RAM, then selects the fastest measured width. Override it with `npm start -- --workers 1` through `4`.

Coverage is defined by your word lists, case styles, layouts, and combination choices. This is a targeted search; there is no bundled universal dictionary. An exhausted search means every candidate in that selection was checked. Broaden your lists or rules as needed. All-combination searches can grow enormously even though preparation is fast.

## Progress and recovery controls

The dashboard refreshes once per second while visible and shows passwords searched, remaining candidates, current checks per second, active runtime, estimated time left, and expected finish time.

- **Passwords searched** and **Remaining** use the contiguous candidate coverage that can be resumed safely. Out-of-order worker completions join that count when the preceding work finishes. A found match is counted without implying that earlier unfinished work completed.
- **Total verification attempts** in the details includes checks repeated after an interruption. Attempts can exceed the unique candidate count.
- **Current speed** uses a rolling 30-second window. The initial estimate comes from calibration; live measurements take over during recovery. A stalled search reports an unknown estimate. Paused searches can use their historical average as a reference.
- **Time running** uses a monotonic clock and excludes paused and offline time. The ETA estimates the full remaining search at the measured rate, not the time at which a match will appear. It changes with machine load and is only a heuristic.

**Pause** and **Stop** both save a durable checkpoint before acknowledging completion. Resume a paused search with **Resume**; continue a stopped search with **Start recovery**. Neither discards progress. `Ctrl-C` or `SIGTERM` saves a running job as interrupted before shutdown. Periodic checkpoints occur every 15 seconds; work after the last checkpoint may repeat after an abrupt crash, without skipping candidates.

After restarting `npm start`, choose **Restore last search** to load the previous settings and compatible progress. **Edit search** restores the current settings to the form so you can refine them. Pause or stop before changing an active search. A different wallet or configuration creates a different job; the previous job remains on disk.

**Restart from zero** archives the current checkpoint and prepares that same search from its beginning. It is available while the search is inactive. The CLI equivalent is `npm start -- --fresh`, which applies to the first search prepared or restored in that launch.

## Reveal a match

When a match is found, the dashboard shows a terminal command. Run it locally to reverify and reveal the recovered password:

```bash
npm run reveal -- --job "<jobId>"
```

The dashboard does not display the password. Reveal reloads the saved configuration, regenerates the matching candidate, checks the exact wallet fingerprint, and confirms the decrypted address with ethers. It writes the password to terminal stdout without creating a plaintext result file. Keep that output private.

If you selected a custom runtime directory, use that same directory for reveal. The guided dashboard includes it in the displayed command:

```bash
npm start -- --runtime-dir "/absolute/private/runtime"
npm run reveal -- --job "<jobId>" --runtime-dir "/absolute/private/runtime"
```

An optional `--wallet "/absolute/path/to/wallet.json"` supplies a moved copy of the exact original wallet.

## Local files and boundaries

Runtime data defaults to `~/Library/Application Support/Ethereum Recovery/`. Set `--runtime-dir` or `RECOVERY_DATA_DIR` to use another location. Runtime directories must be private (`0700`); files use `0600`.

```text
last-setup.json                 # most recently prepared guided settings
demo/demo-keystore.json         # generated demonstration wallet
jobs/<jobId>/
  manifest.json                # wallet/configuration fingerprints and counts
  patterns.json                # immutable configuration snapshot
  candidate-index.bin          # empty guided marker; integer indexes for legacy jobs
  checkpoint.json              # counters, timing, state, and optional matched index
  benchmark.json               # measured speed and chosen worker count
  recovery.lock                # kernel-lock file
  checkpoint.<timestamp>.<nonce>.json  # archived checkpoints after restart from zero
```

Keep an independent backup of your keystore. Keep wallets, actual password hints, runtime files, and recovered passwords out of Git. The service binds only to `127.0.0.1`, with same-origin/session checks on mutations and sensitive setup reads, restricted Host headers, no caching, and a restrictive content security policy. Keep this service local; it is not intended for hosting, proxies, or tunnels. The application has no RPC, transaction signing, broadcasting, or asset-transfer path.

## Codebase map

| Location | Responsibility |
| --- | --- |
| `scripts/start.js`, `package.json`, `.nvmrc` | Single-command launcher, dependency bootstrap, and Node version requirement |
| `server/index.js` | Loopback HTTP server, request protections, API routes, startup and shutdown |
| `server/setupController.js` | Guided validation, preview, job preparation, saved setup, and UI operations |
| `public/index.html`, `public/app.js`, `public/styles.css` | Buildless setup form, live dashboard, controls, and styling |
| `server/recovery/guidedConfig.js` | Keyboard rules, exact counts, deduplicated word groups, and lazy indexed candidates |
| `server/recovery/candidateGenerator.js` | Common candidate API and existing schema-v2 pattern generation |
| `server/recovery/recoveryEngine.js`, `recoveryVerifierWorker.js` | Worker scheduling, contiguous progress, state transitions, speed, and ETA |
| `server/recovery/walletVerifier.js` | Keystore validation, native scrypt/MAC checks, and final ethers confirmation |
| `server/recovery/benchmark.js`, `benchmarkWorker.js` | Memory bounds and synchronized worker throughput measurements |
| `server/recovery/jobStore.js`, `checkpoint.js`, `lockHolder.js` | Immutable jobs, compact plan persistence, atomic checkpoints, and per-job locks |
| `server/runtime.js` | Private runtime directories, bounded file reads, fingerprints, and atomic writes |
| `server/configInit.js`, `server/reveal.js` | Legacy configuration creation and verified terminal reveal |
| `data/patterns.example.json`, `wallet/.gitkeep` | Sanitized example configuration and wallet directory placeholder |
| `test/`, `test/fixtures/`, `scripts/test.js` | Generator, verifier, persistence, HTTP, lifecycle, and recovery tests using isolated fixtures |

Guided searches generate candidates on demand, without enumerating or storing the full search space. Counts remain exact up to JavaScript's safe integer limit, `9,007,199,254,740,991`. Only the bounded word combinations and layout metadata are held in memory. This makes large searches fast to prepare; the wallet's scrypt cost still determines verification speed.

## Existing CLI workflows and validation

Existing schema-v2 pattern JSON, job identities, checkpoints, and reveal commands remain supported. Legacy patterns retain the 10,000,000-raw-candidate bound and their deduplicated integer index maps.

```bash
npm run demo
npm run config:init
npm run real -- --wallet "/absolute/path/to/wallet.json" --workers auto
```

`config:init` creates a protected `patterns.json` in the runtime directory and refuses to overwrite an existing file. Pass `--patterns "/absolute/path/to/patterns.json"` to `npm run real` for a custom configuration. `npm run demo` retains the original sanitized pattern-file demo; the guided demo is available through `npm start`. Use `npm run dev` for dashboard development.

To install the locked dependencies explicitly and run the full suite on the supported platform:

```bash
npm ci
npm test
```

For the guided fixture lifecycle alone:

```bash
node --test test/setupFlow.test.js
```

That integration suite covers preparation, controls, interrupted restart, saved restore, found/reveal, cleanup after errors, and compact plan tamper rejection. Tests use temporary runtime directories; the test runner checks that application runtime data remains unchanged. The production-cost fixture in `test/fixtures/target-cost-v3.json` is also available for a manual long-running rehearsal on the intended machine.
