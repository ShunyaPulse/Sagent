const fs = require('fs');
const crypto = require('crypto');

function universalKeyExtract(str) {
  if (!str || typeof str !== 'string') {
    throw new Error('Key must be a non-empty string');
  }

  // 1. Remove all whitespace (spaces, tabs, actual newlines), escaped newlines (\n, \r), quotes, and backslashes
  const cleaned = str
    .replace(/\s+/g, '')
    .replace(/\\+[rn]/g, '')
    .replace(/["'\\]/g, '');

  // 2. Find the Base64 key payload (RSA starts with MII, EC with MIG, Ed25519 with MC4)
  const keyMatch = cleaned.match(/(?:MII|MIG|MC4)[A-Za-z0-9+/=]{100,}/);
  if (!keyMatch) {
    throw new Error('Could not find ASN.1 Base64 key payload (starting with MII, MIG, or MC4). Key raw length: ' + str.length);
  }

  const base64Body = keyMatch[0].replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = (base64Body.match(/.{1,64}/g) || []).join('\n');

  // 3. Try standard PKCS#8 first, then PKCS#1 (RSA), then EC
  const candidateTypes = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY'];
  for (const type of candidateTypes) {
    const pem = `-----BEGIN ${type}-----\n${wrapped}\n-----END ${type}-----\n`;
    try {
      crypto.createPrivateKey(pem);
      return pem;
    } catch {}
  }

  throw new Error('Failed to validate key with standard OpenSSL decoders');
}

function main() {
  const candidates = [process.env.GCP_CREDENTIALS, process.env.GCP_SA_KEY].filter(Boolean);
  let obj = null;

  for (const cand of candidates) {
    try {
      let parsed;
      try {
        parsed = JSON.parse(cand);
      } catch {
        parsed = JSON.parse(Buffer.from(cand, 'base64').toString('utf8'));
      }
      if (parsed && (parsed.private_key || parsed.client_email)) {
        obj = parsed;
        break;
      }
    } catch {}
  }

  if (!obj) {
    console.error('ERROR: No valid GCP credentials JSON found in GCP_CREDENTIALS or GCP_SA_KEY');
    process.exit(1);
  }

  if (obj.private_key && typeof obj.private_key === 'string') {
    try {
      obj.private_key = universalKeyExtract(obj.private_key);
      console.log('Successfully extracted and validated Service Account private key with OpenSSL crypto engine.');
    } catch (err) {
      console.error('ERROR: Failed to validate reconstructed private key:', err.message);
      process.exit(1);
    }
  }

  const outputPath = process.argv[2] || '/tmp/gcp-sa-key.json';
  fs.writeFileSync(outputPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
  console.log(`GCP Service Account credentials written to ${outputPath}`);
}

main();
