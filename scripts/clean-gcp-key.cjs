const fs = require('fs');
const crypto = require('crypto');

function cleanKey(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Key must be a non-empty string');
  }

  // Ensure boundary markers are separated from surrounding content
  let str = raw
    .replace(/(-{5}BEGIN [A-Z0-9 ]+-{5})/g, '\n$1\n')
    .replace(/(-{5}END [A-Z0-9 ]+-{5})/g, '\n$1\n');

  // Split on all forms of line breaks: literal \r\n, \n, \\n, or actual linefeeds
  const lines = str.split(/(?:\\+[rn]|\r?\n)+/).map((l) => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex((l) => l.startsWith('-----BEGIN'));
  const footerIdx = lines.findIndex((l) => l.startsWith('-----END'));

  if (headerIdx === -1 || footerIdx === -1) {
    throw new Error('Missing PEM header (-----BEGIN) or footer (-----END)');
  }

  const header = lines[headerIdx];
  const footer = lines[footerIdx];
  const base64Lines = lines.slice(headerIdx + 1, footerIdx);

  // Keep only valid Base64 characters in the body
  const fullBase64 = base64Lines.join('').replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = (fullBase64.match(/.{1,64}/g) || []).join('\n');

  return `${header}\n${wrapped}\n${footer}\n`;
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
      obj.private_key = cleanKey(obj.private_key);
      // Validate key with Node.js crypto module to ensure OpenSSL compatibility
      crypto.createPrivateKey(obj.private_key);
      console.log('Successfully validated Service Account private key with OpenSSL crypto engine.');
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
