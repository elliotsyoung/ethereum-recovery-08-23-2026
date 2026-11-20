# Local Ethereum Password Recovery

A local dashboard for recovering a forgotten Ethereum keystore password from remembered character patterns or explicit letter-fragment hypotheses. Review what each filter excludes, see the exact search size and estimated duration, and reuse completed checks across jobs in a private SQLite database.

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

The questionnaire starts with **unknown structure**, a minimum length of **11**, and a maximum of **64** (the supported length ceiling). Unknown characters include all 95 printable ASCII characters: English letters in either case, digits, punctuation, and space. There is no spelling, dictionary, rhyme, two-word, capitalization, digit-count, or suffix assumption in this mode. The upper length bound and ASCII alphabet are explicit coverage limits.

Start with the memory prompts: possible lengths, exact characters and positions, capitalization, numbers, symbols, arrangement, and spelling alternatives. Keep uncertain recollections in **memory notes**; notes stay in the page and are never sent to the server or used as filters. Leave unknowns broad. Every required restriction can exclude the real password if the recollection is wrong, so the coverage review must be acknowledged before preparing a new search. Adding a plausible alternative expands coverage; replacing an unknown with a guess narrows it.

### Character patterns

Enter one pattern per line. Alternatives form a **union** and overlapping candidates are counted and searched once. Blank patterns search every allowed character at each selected length, without assuming word boundaries.

| Pattern token | Meaning |
| --- | --- |
| `?l` | One lowercase English letter |
| `?u` | One uppercase English letter |
| `?a` | One English letter in either case |
| `?d` | One digit, including zero |
| `?s` | One ASCII punctuation character or space (33 choices) |
| `?x` | One allowed printable ASCII character (95 choices) |
| `??` | A literal question mark |
| `?x{4}` | Four unknown characters |
| `?x{2,5}` | Every unknown-character length from two through five |

Other characters are literal, including braces and backslashes. Repetition attaches only to a named wildcard token. For example, **only if you remember that exact prefix**, `Mispellt?x{3,5}` tries that spelling followed by three through five unknown characters, subject to the total length interval. Include separate patterns for every plausible spelling, case, or placement; do not substitute examples for evidence. Patterns outside the selected length interval are excluded.

Up to 64 patterns are accepted. Expansion is bounded to 4,096 structural alternatives and 100,000 decision-trie nodes. Overly complex unions produce an explicit error; split them into smaller jobs and reuse their completed checks. No candidates are silently discarded to fit these limits.

### Two-fragment hypotheses

Choose **Two letter fragments** only when deliberately testing that structure. These are arbitrary English-letter strings, not dictionary words: invented strings and misspellings are accepted. Supply up to 200 distinct fragments in each list, separated by spaces, commas, or newlines, with 1–32 letters each. Leaving the second list blank tries every pairing from the first, including both orders.

This mode exposes per-fragment lengths, total length, digit and symbol count ranges, a digit-value range, possible symbols, capitalization, placement, repeated/all combinations, and an optional distinct-fragment restriction. Defaults include all supported styles and layouts, 0–12 digits, 0–12 trailing symbols, and every ASCII special character. These are still structural and count limits, and the coverage review states them. New jobs have no shared-ending/rhyme filter.

| Layout | Structure |
| --- | --- |
| Suffix | fragment + fragment + digits + symbols |
| Between | fragment + digits + fragment + symbols |
| Split | fragment + digits + fragment + digits + symbols |

Between requires at least one digit; split requires at least two and includes every nonempty division. Symbols are trailing in these layouts. A selected case style applies to both fragments together; **As entered** preserves their supplied capitalization. Use character patterns for arbitrary mixed case, spaces within fragments, symbols elsewhere, or other arrangements. Repeated mode excludes mixed runs; all-combinations mode includes them and leading zeroes. A digit-value bound applies to each contiguous digit run separately, including each split group.

### Estimates before a job

The preview updates as settings change. It shows the exact candidate count, coverage exclusions, follow-up memory questions, and the time for the **entire selected search**. Before calibration, the durations at 1, 10, and 100 checks/second are clearly labeled illustrative scenarios, not measurements of your wallet.

Enter a local wallet path and select **Measure wallet speed** to benchmark before creating a job, even for a search too large to execute. The measured rate applies only to that exact wallet and is invalidated if the file changes. Preparing a job reuses that calibration. Automatic calibration compares 1, 2, and 4 workers when their estimated memory fits within half of system RAM; override with `npm start -- --workers 1` through `4`.

Counts use exact integer arithmetic even above the executable index limit of **9,007,199,254,740,991** candidates. Such searches can be previewed but cannot be prepared. Add only information you can confidently supply, or divide the work into explicit hypotheses. Unknown answers never trigger an automatic restriction. Estimates before execution conservatively include all selected candidates; reuse removes expensive checks during execution, while candidate generation and database lookups still take time. A match may appear earlier or may be outside the selected space.

Select **Prepare search**, review the measured estimate, then **Start recovery**. Demo mode retains its known 1,000-candidate rehearsal. An exhausted job means the selected candidates were covered, not that every possible password was searched.

## Progress and recovery controls

The dashboard refreshes once per second while visible and shows passwords searched, remaining candidates, current checks per second, active runtime, estimated time left, and expected finish time.

- **Passwords searched** and **Remaining** use the contiguous candidate coverage that can be resumed safely. Out-of-order worker completions join that count when the preceding work finishes. A found match is counted without implying that earlier unfinished work completed.
- **Total verification attempts** counts actual worker checks for this job. **Checks reused** counts candidates satisfied by completed results in the shared history. Coverage can therefore exceed this job’s verification attempts. A replayed checkpoint may revisit cached candidates without repeating their expensive verification. The reused-check counter counts cache hits, including repeat visits after interrupted progress; it is not a unique-password count.
- **Current speed** uses a rolling 30-second window. The initial estimate comes from calibration; live measurements take over during recovery. A stalled search reports an unknown estimate. Paused searches can use their historical average as a reference.
- **Time running** uses a monotonic clock and excludes paused and offline time. The ETA estimates the full remaining search at the measured rate, not the time at which a match will appear. It changes with machine load and is only a heuristic.

**Pause** and **Stop** both save a durable checkpoint before acknowledging completion. Resume a paused search with **Resume**; continue a stopped search with **Start recovery**. Neither discards progress. `Ctrl-C` or `SIGTERM` saves a running job as interrupted before shutdown. Periodic checkpoints occur every 15 seconds. Each completed verification result is committed to SQLite before progress advances, so replaying a stale checkpoint reuses those results. Work interrupted before its result was committed may be retried; uncertain work is never treated as completed.

After restarting `npm start`, choose **Restore last search** to load the previous settings and compatible progress. **Edit search** restores the current settings to the form so you can refine them. Pause or stop before changing an active search. A different wallet or configuration creates a different job; the previous job remains on disk. Jobs for the exact same wallet share completed candidate checks even when filters, candidate order, or generator mode differ.

**Restart from zero** archives the current checkpoint and resets its progress display. Shared completed results remain available, so already checked candidates are reused as the search walks its indexes again. It is available while the search is inactive. The CLI equivalent is `npm start -- --fresh`, which applies to the first search prepared or restored in that launch.

## Shared search history

Node 24’s built-in SQLite stores completed outcomes under the private runtime directory. The key is the **exact wallet-file SHA-256 fingerprint plus an HMAC-SHA256 digest of the candidate’s verifier-normalized UTF-8 bytes (NFKC)**; candidate text is not stored in this database. Job IDs, filters, and candidate indexes are not part of this identity. Different wallets cannot reuse negative results, because their verification answers can differ. Use the same runtime directory for jobs that should share history.

Database transactions claim work before dispatch and commit completed outcomes before checkpoint advancement. Concurrent jobs wait for an existing live claim instead of checking it again. A dead process’s unfinished claim can be reclaimed. Crashes cannot provide a strict exactly-once guarantee for checks whose result never reached durable storage; those may be repeated to preserve coverage. Cached matches still undergo independent wallet/address confirmation, and terminal reveal also verifies the result.

On initialization, validated existing jobs and archived checkpoints for the same wallet are imported in batches. Only their contiguous completed frontier and recorded matches count; attempts and unfinished positions do not. Invalid legacy jobs are left untouched and supply no reusable coverage. Migration can take time for a large historical search, but it does not rerun scrypt. New jobs use history automatically.

SQLite uses WAL mode and full synchronization. Disk use grows with the number of distinct completed candidates and the database is not automatically pruned: deleting history loses reuse. Keep the entire private `search-history` directory together, including its digest key; copy it only while recovery is shut down so SQLite’s main file and WAL remain consistent. Settings snapshots still contain your private hints and should be protected along with the wallet.

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
search-history/
  checks.sqlite                # shared completed checks, live claims, migration progress
  checks.sqlite-wal, checks.sqlite-shm # SQLite files while in use
  digest-key.bin               # private HMAC key (keep with the database)
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
| `server/recovery/guidedConfig.js`, `maskSearch.js`, `searchAdvice.js` | Versioned rules, exact pattern-union counts, indexed candidates, coverage review, and duration advice |
| `server/recovery/candidateGenerator.js` | Common candidate API and existing schema-v2 pattern generation |
| `server/recovery/recoveryEngine.js`, `recoveryVerifierWorker.js` | Worker scheduling, contiguous progress, state transitions, speed, and ETA |
| `server/recovery/walletVerifier.js` | Keystore validation, native scrypt/MAC checks, and final ethers confirmation |
| `server/recovery/benchmark.js`, `benchmarkWorker.js` | Memory bounds and synchronized worker throughput measurements |
| `server/recovery/jobStore.js`, `checkpoint.js`, `lockHolder.js`, `searchLedger.js` | Immutable jobs, checkpoints, per-job locks, SQLite reuse, concurrent claims, and historical migration |
| `server/runtime.js` | Private runtime directories, bounded file reads, fingerprints, and atomic writes |
| `server/configInit.js`, `server/reveal.js` | Legacy configuration creation and verified terminal reveal |
| `data/patterns.example.json`, `wallet/.gitkeep` | Sanitized example configuration and wallet directory placeholder |
| `test/`, `test/fixtures/`, `scripts/test.js` | Generator, verifier, persistence, HTTP, lifecycle, and recovery tests using isolated fixtures |

Guided searches generate candidates on demand without materializing the entire search space. Pattern unions use a bounded decision trie and BigInt counts; fragment jobs keep bounded pair/layout metadata. Executable indexes are limited to JavaScript’s safe integer range. The shared database stores only completed candidate outcomes, so storage grows with actual search work, not with the preview count.

## Existing CLI workflows and validation

Existing schema-v2 pattern JSON and guided configurations, job identities, candidate order, checkpoints, and reveal commands remain supported. New questionnaire jobs use schema v3. Restoring an old job preserves its rules; editing it into a new job explicitly removes the legacy shared-ending restriction and presents the new coverage review. Legacy patterns retain the 10,000,000-raw-candidate bound and their deduplicated integer index maps.

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
