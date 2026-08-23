const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');

function parseKeystore(input) {
  if (typeof input === 'string') {
    return JSON.parse(input);
  }
  return input;
}

function verifyCandidate(keystore, candidate) {
  try {
    const parsed = parseKeystore(keystore);
    if (!parsed || typeof parsed !== 'object' || !parsed.version || parsed.version !== 3) {
      return false;
    }
    Wallet.fromEncryptedJson(JSON.stringify(parsed), candidate);
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureDemoWallet(walletPath = path.resolve(__dirname, '../../wallet/demo-keystore.json')) {
  fs.mkdirSync(path.dirname(walletPath), { recursive: true });
  if (!fs.existsSync(walletPath)) {
    const wallet = Wallet.createRandom();
    const encrypted = await wallet.encrypt('DemoPass123!');
    fs.writeFileSync(walletPath, encrypted, 'utf8');
  }
  return walletPath;
}

function readKeystoreFile(filePath) {
  const resolved = filePath || path.resolve(__dirname, '../../wallet/demo-keystore.json');
  const content = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(content);
}

module.exports = {
  ensureDemoWallet,
  readKeystoreFile,
  verifyCandidate
};
