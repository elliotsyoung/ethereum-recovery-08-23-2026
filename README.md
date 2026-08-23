# Local Ethereum Keystore Password Recovery

This repository is a small, local-only Node.js dashboard and recovery engine for testing password candidates against a locally stored Ethereum Web3 Secret Storage V3 keystore.

Important:
- This app is intentionally local-only and binds to 127.0.0.1.
- The real wallet must never be committed, uploaded, pasted into AI chats, or exposed publicly.
- The app defaults to DEMO mode and will not run against a real wallet unless you explicitly switch to REAL mode and provide a valid local path.
- Candidate passwords are never logged by default.
- If a password is eventually found, the engine stops immediately and requires a local server-side action to reveal it.

## Installation

Use nvm for Node.js 24:

```bash
nvm use
npm install
```

## Development

```bash
npm run dev
```

Then open http://127.0.0.1:3000

## Benchmark

```bash
npm run benchmark
```

This loads the DEMO keystore and measures throughput for a sample candidate space.

## Tests

```bash
npm test
```

## Real wallet placement

The app is designed to use a local wallet file that you place on your machine, outside the repo, or in a local `wallet/` directory that remains ignored by Git.

Example:

```bash
mkdir -p wallet
cp /path/to/your-wallet.json wallet/real-keystore.json
```

If you use `REAL` mode, the app will look at:
- `process.env.WALLET_PATH` if set
- otherwise a `wallet/real-keystore.json` file in the project root

Do not commit the real wallet file. Keep it on a secure local disk and back up the original keystore with a secure method.

## DEMO vs REAL mode

The app ships with DEMO mode enabled by default.

- DEMO mode uses a generated local test keystore with a known test password.
- REAL mode expects a local keystore file that you own and control.
- Switching to REAL mode should be explicit and local only.

## Checkpoints

Recovery progress is periodically saved to `data/checkpoint.json`.

Each checkpoint includes:
- `candidateIndex`
- `totalAttempted`
- `startedAt`
- `lastCheckpointAt`
- `elapsedMs`
- `currentPattern`
- `matchesFound`

The app will resume from the last checkpoint automatically if one exists.

## Safe backup guidance

Before using a real wallet:
- keep a copy of the original keystore in an encrypted backup
- store it outside Git and outside browser localStorage
- do not upload to GitHub, Google Drive, Dropbox, or AI chat tools

## Security warnings

Do not:
- commit the wallet
- upload it to GitHub
- paste it into AI chats
- expose the Express server publicly
- use ngrok or other tunneling tools
- deploy this application to a networked environment
- store the recovered password or private key in browser localStorage

## Project structure

```text
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
      recoveryWorker.js
      checkpoint.js
      benchmark.js
  public/
    index.html
    styles.css
    app.js
  data/
    patterns.json
    checkpoint.json
  wallet/
    .gitkeep
  test/
    candidateGenerator.test.js
    walletVerifier.test.js
```
