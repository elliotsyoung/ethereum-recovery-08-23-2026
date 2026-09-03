Create a small local-only Node.js project for recovering the forgotten password of my own Ethereum V3 keystore.

## Environment

* macOS
* Node.js 24 managed with nvm
* Express.js backend
* Plain HTML + CSS + vanilla JavaScript frontend
* No React, TypeScript, database, authentication system, or unnecessary framework
* Bind the server ONLY to `127.0.0.1`, never `0.0.0.0`
* This application must remain completely local.

My wallet is an Ethereum/Web3 Secret Storage V3 keystore with:

* version: 3
* cipher: aes-128-ctr
* KDF: scrypt
* dklen: 32
* n: 262144
* r: 8
* p: 1

Do NOT ask me to paste the real wallet JSON into source code.

## Goal

Build the initial project infrastructure and dashboard for a long-running password-recovery experiment.

I want to eventually test intelligently generated candidate passwords against my own encrypted Ethereum wallet. For now, prioritize:

1. Correct project setup
2. Safe local wallet handling
3. Candidate-pattern management
4. Progress tracking
5. Benchmarking
6. Checkpoint/resume support
7. A simple visual dashboard

Do not attempt arbitrary private-key generation or Ethereum-network attacks. This project only tests candidate passwords against a locally supplied encrypted keystore that I own.

## Dependencies

Use a minimal dependency set.

Install Express and whatever well-maintained Ethereum/cryptographic Node package is appropriate for safely reading and verifying a standard Ethereum V3 keystore.

Prefer Node's built-in `crypto` module where appropriate.

Use Node's built-in filesystem APIs for persistence rather than adding a database.

Use `nodemon` only as a development dependency.

Create useful npm scripts:

* `npm start`
* `npm run dev`
* `npm run benchmark`
* `npm test`

Do not globally install anything.

## Project structure

Use something approximately like:

```
wallet-recovery/
  package.json
  .gitignore
  README.md

  server/
    index.js
    recovery/
      candidateGenerator.js
      walletVerifier.js
      recoveryEngine.js
      checkpoint.js
      benchmark.js

  public/
    index.html
    styles.css
    app.js

  data/
    patterns.json
    checkpoint.json
    .gitkeep

  wallet/
    .gitkeep

  test/
    candidateGenerator.test.js
    walletVerifier.test.js
```

Feel free to adjust this structure if there is a good technical reason.

## Security requirements

The real keystore must NEVER be committed.

Add appropriate `.gitignore` rules for:

```
wallet/*
!wallet/.gitkeep

data/checkpoint.json

.env

recovered-password*
private-key*
```

The backend may read a wallet from a configurable local filesystem path.

The frontend must NEVER receive:

* ciphertext
* salt
* IV
* MAC
* decrypted private key
* recovered private key
* full keystore JSON

Do not add any endpoint that returns these.

If a password is eventually found, STOP the recovery process immediately.

Do not display the password in the browser automatically. Record only that a match was found and require an explicit local/server-side action to retrieve it.

Never log candidate passwords by default.

## Candidate generator

Implement the candidate generator independently from the expensive wallet verification operation.

I remember using password structures resembling:

```
PickyRicky77&&
InMotions11!!
RealMotions88**
PastaTomaeto44$$
```

Do NOT hardcode those exact examples as actual candidates; they are examples of the grammar.

Represent candidate patterns as configurable data.

Initially support structures such as:

```
{word1}{word2}{number}{suffix}
{word1}{number}{word2}{suffix}
{word1}{symbol}{word2}{number}{suffix}
```

Allow configurable:

* word1 lists
* word2 lists
* number lists/ranges
* suffix lists
* capitalization transformations
* spelling mutations
* pattern ordering

Make generation deterministic.

Given the same configuration and candidate index, it must generate the same candidate.

Do NOT save every failed password.

Instead maintain a monotonically increasing candidate index/checkpoint.

## Checkpointing

Save progress periodically to:

```
data/checkpoint.json
```

Include fields such as:

```
candidateIndex
totalAttempted
startedAt
lastCheckpointAt
elapsedMs
currentPattern
matchesFound
```

Use atomic writes if practical so a crash cannot easily corrupt the checkpoint.

On startup, detect an existing checkpoint and allow the recovery job to resume.

## Recovery engine

Build the engine as a separable module.

It should support:

* start
* pause
* resume
* stop
* current status
* configurable checkpoint interval

Do not block the Express event loop with a giant synchronous loop.

Use a worker thread or another appropriate Node mechanism for CPU-intensive recovery work.

The UI must remain responsive while recovery is running.

Start with a SAFE DEMO MODE that uses a test keystore generated specifically for this project and a known test password.

Do not automatically run against my real wallet.

There should be an explicit configuration switch between:

```
DEMO
REAL
```

Default to DEMO.

## Wallet verifier

Implement a verifier for a standard Ethereum V3 keystore.

Do not invent cryptographic algorithms.

Use an established implementation or carefully follow the standard keystore verification process.

The verifier should expose something conceptually like:

```
verifyCandidate(keystore, candidate) -> boolean
```

The normal failed-password path should avoid throwing expensive exceptions if possible.

Never print candidates during high-speed operation.

## Benchmark

Create a benchmark command:

```
npm run benchmark
```

It should load the DEMO wallet and perform enough failed candidate checks to estimate:

* guesses/second
* milliseconds/guess
* estimated guesses/hour
* estimated guesses/day

Also calculate estimated completion times for hypothetical spaces:

```
10,000
100,000
1,000,000
10,000,000
100,000,000
1,000,000,000
```

Do not assume a performance number ahead of time.

Measure it.

## Express API

Create endpoints approximately like:

```
GET  /api/status
POST /api/recovery/start
POST /api/recovery/pause
POST /api/recovery/resume
POST /api/recovery/stop

GET  /api/patterns
PUT  /api/patterns

POST /api/benchmark
```

Validate inputs.

Keep all routes local.

## Dashboard

Create a clean single-page dashboard using plain HTML/CSS/JS.

Show:

* mode: DEMO or REAL
* state: idle/running/paused/stopped/found
* total guesses
* guesses/second
* guesses/hour
* elapsed time
* current candidate index
* current pattern name
* total candidate-space size
* percentage complete
* estimated time remaining
* last checkpoint time

Include Start, Pause, Resume, and Stop buttons.

Add a progress bar.

Add a small live chart showing guesses completed over time using plain browser JavaScript. Do not add a large charting dependency unless genuinely necessary.

## Pattern editor

Add a basic editor where I can maintain likely:

* first words
* second words
* numbers
* suffixes
* pattern templates

The dashboard should calculate the approximate number of candidates produced by the configuration BEFORE starting recovery.

This is extremely important because I want to understand when a pattern accidentally creates billions or trillions of combinations.

For example, show something like:

```
Pattern: word1 + word2 + number + suffix

100 word1
100 word2
100 numbers
8 suffixes

Estimated candidates:
8,000,000
```

Also estimate runtime using the most recent benchmark:

```
At 12.4 guesses/sec:
~7.5 days
```

Do not treat that example speed as real; use the measured benchmark.

## Tests

Create a small known-password test wallet.

Tests should verify:

1. Wrong password fails.
2. Correct password succeeds.
3. Candidate generation is deterministic.
4. Checkpoint save/load works.
5. Resume begins at the expected candidate index.
6. Candidate-space calculation is correct.

Never use my real wallet in automated tests.

## README

Document:

* installation
* `nvm use`
* `npm install`
* development startup
* benchmark command
* test command
* where the real wallet eventually goes
* how DEMO vs REAL mode works
* how checkpoints work
* how to safely back up the original keystore

Explicitly warn not to:

* commit the wallet
* upload it to GitHub
* paste it into AI chats
* expose the Express server publicly
* use ngrok
* deploy this application
* store the recovered password/private key in browser localStorage

## Implementation approach

Work incrementally.

First inspect the empty/current repository.

Then:

1. Initialize the Node project if necessary.
2. Install dependencies.
3. Create the folder structure.
4. Implement DEMO wallet verification.
5. Add tests.
6. Implement deterministic candidate generation.
7. Implement checkpointing.
8. Implement worker-based recovery.
9. Implement Express API.
10. Implement dashboard.
11. Implement benchmarking.
12. Run tests.
13. Start the server and verify that it works.
14. Fix any errors encountered.

Do not merely describe the implementation.

Actually create the files, install the dependencies, run the tests, and fix failures.

Keep the implementation intentionally small and readable because I want to understand and modify the candidate-generation strategy myself later.
