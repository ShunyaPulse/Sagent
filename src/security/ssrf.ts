import dns from 'dns/promises';
import { URL } from 'url';

/**
 * Validates that an IP address is a safe, publicly routable IP.
 * Blocks private networks, localhost, link-local, and Cloud metadata endpoints (SSRF Defense).
 */
export function isSafePublicIp(ip: string): boolean {
  // IPv4 Checks (dotted strings containing a colon are IPv6 with an embedded IPv4)
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return false;
    }

    const [a, b] = parts;

    // 0.0.0.0/8 Current network
    if (a === 0) return false;

    // 10.0.0.0/8 Private network
    if (a === 10) return false;

    // 127.0.0.0/8 Loopback
    if (a === 127) return false;

    // 169.254.0.0/16 Link-local & Cloud Metadata Server (169.254.169.254)
    if (a === 169 && b === 254) return false;

    // 172.16.0.0/12 Private network
    if (a === 172 && b >= 16 && b <= 31) return false;

    // 192.168.0.0/16 Private network
    if (a === 192 && b === 168) return false;

    // 224.0.0.0/4 Multicast & 240.0.0.0/4 Reserved
    if (a >= 224) return false;

    return true;
  }

  // IPv6 Checks
  if (ip.includes(':')) {
    const normalized = ip.toLowerCase();
    // Loopback ::1
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return false;
    // Unspecified ::
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return false;
    // Unique local address fc00::/7 (fc.. or fd..)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    // Link-local address fe80::/10
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return false;

    // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254): validate the embedded IPv4
    // address so loopback/metadata targets cannot slip through in IPv6 notation.
    const dottedIpv4 = normalized.match(
      /(?::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/
    );
    if (dottedIpv4) return isSafePublicIp(dottedIpv4[1]);

    // IPv4-mapped IPv6 in hexadecimal form (e.g. ::ffff:7f00:1 => 127.0.0.1)
    const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const high = parseInt(hexMapped[1], 16);
      const low = parseInt(hexMapped[2], 16);
      return isSafePublicIp(
        `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
      );
    }

    return true;
  }

  return false;
}

/**
 * Validates a target URL against SSRF vulnerabilities before fetching.
 * Throws an Error if the URL attempts to contact private infrastructure or metadata endpoints.
 */
export async function assertSafeUrl(urlString: string): Promise<URL> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL format: ${urlString}`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Forbidden protocol "${parsedUrl.protocol}". Only HTTP and HTTPS are permitted.`);
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // Explicit blocklist for known cloud metadata hostnames
  const forbiddenHosts = [
    'metadata.google.internal',
    'metadata',
    'instance-data',
    'localhost'
  ];

  if (forbiddenHosts.includes(hostname) || hostname.endsWith('.internal')) {
    throw new Error(`Access to internal cloud metadata host "${hostname}" is blocked.`);
  }

  // Resolve DNS to verify all destination IPs
  try {
    const lookups = await dns.lookup(hostname, { all: true });
    for (const entry of lookups) {
      if (!isSafePublicIp(entry.address)) {
        throw new Error(
          `SSRF Security Block: Host "${hostname}" resolved to prohibited private/internal IP address "${entry.address}".`
        );
      }
    }
  } catch (err: any) {
    if (err.message.includes('SSRF Security Block')) {
      throw err;
    }
    throw new Error(`DNS resolution failed for host "${hostname}": ${err.message}`);
  }

  return parsedUrl;
}
