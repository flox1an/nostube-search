import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

export type RelayHintPolicy = {
  maxHints: number; // env RELAY_HINT_MAX, default 4
  allowInsecure: boolean; // env RELAY_HINT_ALLOW_INSECURE === 'true', default false -> only wss:
  allowPrivateHosts: boolean; // env RELAY_HINT_ALLOW_PRIVATE === 'true', default false
};

const DEFAULT_MAX_HINTS = 4;
const DEFAULT_DNS_TIMEOUT_MS = 2000;
const MAX_RELAY_LENGTH = 512;

export function relayHintPolicyFromEnv(): RelayHintPolicy {
  const max = Number(process.env.RELAY_HINT_MAX);
  return {
    maxHints: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_HINTS,
    allowInsecure: process.env.RELAY_HINT_ALLOW_INSECURE === 'true',
    allowPrivateHosts: process.env.RELAY_HINT_ALLOW_PRIVATE === 'true',
  };
}

// ── IP literal classification ─────────────────────────────────────────────────

function parseIPv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets as [number, number, number, number];
}

function isPrivateIPv4(address: string): boolean {
  const octets = parseIPv4Octets(address);
  if (octets === null) return false;
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved (incl. broadcast)
  return false;
}

/**
 * Expand an IPv6 address into its eight 16-bit hextets, handling `::`
 * compression and a trailing dotted-quad IPv4 tail (IPv4-mapped forms).
 * Returns null when the address does not expand to exactly 8 hextets.
 */
function expandIPv6Hextets(address: string): number[] | null {
  let addr = address;
  let ipv4Tail: [number, number, number, number] | null = null;
  const dotMatch = addr.match(/^(.*):(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotMatch) {
    const octets = parseIPv4Octets(dotMatch[2]);
    if (octets === null) return null;
    ipv4Tail = octets;
    addr = dotMatch[1].replace(/:+$/, '');
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : halves[0].split(':').map(part => parseInt(part, 16));
  const right =
    halves.length === 1 || halves[1] === '' ? [] : halves[1].split(':').map(part => parseInt(part, 16));
  const valid = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xffff;
  if (!left.every(valid) || !right.every(valid)) return null;

  const tailHextets = ipv4Tail
    ? [ipv4Tail[0] * 256 + ipv4Tail[1], ipv4Tail[2] * 256 + ipv4Tail[3]]
    : [];
  const missing = 8 - left.length - right.length - tailHextets.length;
  if (missing < 0) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right, ...tailHextets];
}

function isPrivateIPv6(address: string): boolean {
  const hextets = expandIPv6Hextets(address.toLowerCase());
  if (hextets === null) return false;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 0) {
    return true; // :: unspecified
  }
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) {
    return true; // ::1 loopback
  }
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (hextets fc00-fdff)
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast (hextets ff00-ffff)
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    // 64:ff9b::/96 well-known NAT64 prefix — apply IPv4 rules to embedded address
    return isPrivateIPv4(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`);
  }
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    // ::ffff:0:0/96 IPv4-mapped — apply IPv4 rules to embedded address
    return isPrivateIPv4(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`);
  }
  return false;
}

export function isPrivateAddress(address: string): boolean {
  let addr = address.trim();
  // url.hostname keeps IPv6 brackets ([::1]); strip them so both forms classify.
  if (addr.startsWith('[')) {
    const close = addr.indexOf(']');
    if (close !== -1) addr = addr.slice(1, close);
  }
  if (isIPv4(addr)) return isPrivateIPv4(addr);
  if (isIPv6(addr)) return isPrivateIPv6(addr);
  return false; // hostnames are resolved separately — not private by themselves
}

export function isBlockedHostname(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.internal')) return true;
  if (h.endsWith('.home.arpa')) return true;
  if (h.endsWith('.lan')) return true;
  return isPrivateAddress(h);
}

// ── Structural sanitization ────────────────────────────────────────────────────

/**
 * Normalize a parsed relay URL for deduplication the way nostr-tools'
 * normalizeURL does: collapse repeated slashes in the pathname, drop a single
 * trailing slash, clear the hash, and sort search params.
 */
function dedupeKey(url: URL): string {
  url.pathname = url.pathname.replace(/\/+/g, '/');
  if (url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  url.hash = '';
  url.searchParams.sort();
  return url.toString();
}

export function sanitizeRelayHints(
  relays: readonly string[],
  policy?: Partial<RelayHintPolicy>,
): string[] {
  const merged = { ...relayHintPolicyFromEnv(), ...policy };
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of relays) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RELAY_LENGTH) continue;
    let url: URL;
    try {
      url = new URL(raw); // no scheme -> throws; never auto-prefix like nostr-tools would
    } catch {
      continue;
    }
    // Scheme normalization BEFORE the allowlist check (mirrors nostr-tools
    // normalizeURL), so http://127.0.0.1 cannot slip past a naive wss-only test.
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && merged.allowInsecure)) continue;
    if (url.username !== '' || url.password !== '') continue;
    if (!merged.allowPrivateHosts && isBlockedHostname(url.hostname)) continue;
    const key = dedupeKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
    if (result.length >= merged.maxHints) break;
  }
  return result;
}

// ── DNS-stage resolution check (fail closed) ───────────────────────────────────

function isIPLiteral(hostname: string): boolean {
  let h = hostname;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return isIPv4(h) || isIPv6(h);
}

function dnsTimeoutMs(): number {
  const n = Number(process.env.RELAY_HINT_DNS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DNS_TIMEOUT_MS;
}

/** Resolve a hostname, returning null on error or when the timeout elapses. */
function lookupWithTimeout(hostname: string, timeoutMs: number): Promise<string[] | null> {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    lookup(hostname, { all: true, verbatim: true }).then(
      addresses => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(addresses.map(a => a.address));
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export async function resolveSafeRelayHints(
  relays: readonly string[],
  policy?: Partial<RelayHintPolicy>,
): Promise<string[]> {
  const merged = { ...relayHintPolicyFromEnv(), ...policy };
  const sanitized = sanitizeRelayHints(relays, merged);
  if (merged.allowPrivateHosts) return sanitized;

  const hostToRelays = new Map<string, string[]>();
  for (const relay of sanitized) {
    const hostname = new URL(relay).hostname;
    const list = hostToRelays.get(hostname) ?? [];
    list.push(relay);
    hostToRelays.set(hostname, list);
  }

  const timeoutMs = dnsTimeoutMs();
  const outcomes = await Promise.all(
    [...hostToRelays.keys()].map(async hostname => {
      if (isIPLiteral(hostname)) return { hostname, ok: true }; // IPs already vetted by sanitize
      const addresses = await lookupWithTimeout(hostname, timeoutMs);
      if (addresses === null) return { hostname, ok: false }; // resolution error or timeout
      if (addresses.some(address => isPrivateAddress(address))) return { hostname, ok: false };
      return { hostname, ok: true };
    }),
  );

  const keptHosts = new Set(outcomes.filter(o => o.ok).map(o => o.hostname));
  return sanitized.filter(relay => keptHosts.has(new URL(relay).hostname));
}
