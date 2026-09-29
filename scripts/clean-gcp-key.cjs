const fs = require('fs');
const crypto = require('crypto');

function universalKeyExtract(str) {
  if (!str || typeof str !== 'string') {
    throw new Error('Key must be a non-empty string');
  }

  const isPkcs1 = /RSA PRIVATE KEY/i.test(str);

  // 1. Remove all newline representations (both escaped and literal)
  const strippedBreaks = str.replace(/(?:\\+[rn]|\r?\n)+/g, '');

  // 2. Find the ASN.1 DER Base64 payload (starts with MII, min length 100)
  const miiMatch = strippedBreaks.match(/MII[A-Za-z0-9+/=]{100,}/);
  if (!miiMatch) {
    throw new Error('Could not find ASN.1 Base64 key payload (starting with MII)');
  }
  const base64Body = miiMatch[0].replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = (base64Body.match(/.{1,64}/g) || []).join('\n');

  const candidates = isPkcs1
    ? ['RSA PRIVATE KEY', 'PRIVATE KEY']
    : ['PRIVATE KEY', 'RSA PRIVATE KEY'];

  for (const type of candidates) {
    const pem = `-----BEGIN ${type}-----\n${wrapped}\n-----END ${type}-----\n`;
    try {
      crypto.createPrivateKey(pem);
      return pem;
    } catch {}
  }

  throw new Error('Failed to validate key with either PKCS#8 or PKCS#1 framing');
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
