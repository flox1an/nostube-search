import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  isBlockedHostname,
  isPrivateAddress,
  relayHintPolicyFromEnv,
  resolveSafeRelayHints,
  sanitizeRelayHints,
} from './relay-hints.js';

const RELAY_ENV_KEYS = [
  'RELAY_HINT_MAX',
  'RELAY_HINT_ALLOW_INSECURE',
  'RELAY_HINT_ALLOW_PRIVATE',
  'RELAY_HINT_DNS_TIMEOUT_MS',
];

afterEach(() => {
  for (const key of RELAY_ENV_KEYS) delete process.env[key];
});

describe('relayHintPolicyFromEnv', () => {
  it('returns defaults when no env vars are set', () => {
    assert.deepEqual(relayHintPolicyFromEnv(), {
      maxHints: 4,
      allowInsecure: false,
      allowPrivateHosts: false,
    });
  });

  it('honours RELAY_HINT_MAX and the allow flags', () => {
    process.env.RELAY_HINT_MAX = '7';
    process.env.RELAY_HINT_ALLOW_INSECURE = 'true';
    process.env.RELAY_HINT_ALLOW_PRIVATE = 'true';

    assert.deepEqual(relayHintPolicyFromEnv(), {
      maxHints: 7,
      allowInsecure: true,
      allowPrivateHosts: true,
    });
  });

  it('falls back to the default max for missing, non-finite, and non-positive values', () => {
    for (const value of [undefined, 'abc', '-3', '0']) {
      if (value === undefined) delete process.env.RELAY_HINT_MAX;
      else process.env.RELAY_HINT_MAX = value;
      assert.equal(relayHintPolicyFromEnv().maxHints, 4, `RELAY_HINT_MAX=${value}`);
    }
  });

  it('floors fractional positive values', () => {
    process.env.RELAY_HINT_MAX = '2.5';
    assert.equal(relayHintPolicyFromEnv().maxHints, 2);
  });

  it('only accepts the exact string "true" for the allow flags', () => {
    process.env.RELAY_HINT_ALLOW_INSECURE = 'TRUE';
    process.env.RELAY_HINT_ALLOW_PRIVATE = '1';
    assert.equal(relayHintPolicyFromEnv().allowInsecure, false);
    assert.equal(relayHintPolicyFromEnv().allowPrivateHosts, false);
  });
});

describe('isPrivateAddress', () => {
  it('blocks IPv4 private, loopback, link-local, CGNAT, multicast, reserved, and broadcast ranges', () => {
    const privateAddrs = [
      '0.0.0.0',
      '0.255.255.255',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '127.255.255.255',
      '169.254.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.0.1',
      '192.168.255.255',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
    ];
    for (const addr of privateAddrs) {
      assert.equal(isPrivateAddress(addr), true, addr);
    }
  });

  it('allows public IPv4 addresses and range boundaries just outside the private blocks', () => {
    const publicAddrs = [
      '8.8.8.8',
      '1.1.1.1',
      '100.63.255.255',
      '100.128.0.1',
      '169.253.0.1',
      '172.15.0.1',
      '172.32.0.1',
      '192.0.1.1',
      '192.0.3.1',
      '198.20.0.1',
      '203.0.114.1',
      '223.255.255.255',
    ];
    for (const addr of publicAddrs) {
      assert.equal(isPrivateAddress(addr), false, addr);
    }
  });

  it('blocks IPv6 loopback, ULA, link-local, multicast, documentation, and IPv4-embedded forms', () => {
    const privateAddrs = [
      '::',
      '::1',
      'fc00::1',
      'fd00::1',
      'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'fe80::1',
      'febf::1',
      'ff00::1',
      'ff02::1',
      '2001:db8::1',
      '2001:db8:0:0:0:0:0:1',
      '64:ff9b::127.0.0.1',
      '64:ff9b::10.0.0.5',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.5',
      '::ffff:169.254.169.254',
      '::ffff:7f00:1',
      '[::1]',
      '[::ffff:127.0.0.1]',
    ];
    for (const addr of privateAddrs) {
      assert.equal(isPrivateAddress(addr), true, addr);
    }
  });

  it('allows public IPv6 addresses and public embedded IPv4 tails', () => {
    const publicAddrs = [
      '2606:4700::1111',
      '2001:4860:4860::8888',
      '2400:cb00::1',
      '::ffff:8.8.8.8',
      '64:ff9b::1.1.1.1',
    ];
    for (const addr of publicAddrs) {
      assert.equal(isPrivateAddress(addr), false, addr);
    }
  });

  it('returns false for anything that is not a valid IP literal', () => {
    for (const value of ['', 'localhost', 'relay.example.com', '10.0.0', '999.1.1.1', '1:2:3:4:5:6:7']) {
      assert.equal(isPrivateAddress(value), false, value);
    }
  });
});

describe('isBlockedHostname', () => {
  it('blocks localhost and the reserved/suffix domains, case-insensitively and with a trailing dot', () => {
    const blocked = [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'foo.localhost',
      'foo.local',
      'foo.LOCAL.',
      'foo.internal',
      'foo.home.arpa',
      'foo.lan',
      'foo.lan.',
    ];
    for (const name of blocked) {
      assert.equal(isBlockedHostname(name), true, name);
    }
  });

  it('blocks private and loopback IP literals via isPrivateAddress', () => {
    assert.equal(isBlockedHostname('127.0.0.1'), true);
    assert.equal(isBlockedHostname('169.254.169.254'), true);
    assert.equal(isBlockedHostname('[::1]'), true);
  });

  it('allows public hostnames and public IP literals', () => {
    for (const name of ['relay.nostu.be', 'relay.example.com', '8.8.8.8', '']) {
      assert.equal(isBlockedHostname(name), false, name);
    }
  });
});

describe('sanitizeRelayHints', () => {
  it('drops private, loopback, metadata, credential, scheme-less, and oversized entries', () => {
    const oversized = `wss://relay.example.com/${'x'.repeat(600)}`;
    const result = sanitizeRelayHints([
      'ws://127.0.0.1:7700/probe',
      'http://169.254.169.254/latest/meta-data',
      'https://[::1]/',
      'wss://localhost/',
      'wss://foo.internal/',
      'wss://10.0.0.5/',
      'wss://user:pw@relay.example/',
      'relay.example.com',
      oversized,
    ]);
    assert.deepEqual(result, []);
  });

  it('rejects non-string and empty entries', () => {
    const result = sanitizeRelayHints(['wss://relay.nostu.be', 42 as unknown as string, '']);
    assert.deepEqual(result, ['wss://relay.nostu.be/']);
  });

  it('keeps valid public wss relays', () => {
    const result = sanitizeRelayHints(['wss://relay.nostu.be', 'wss://relay.damus.io/']);
    assert.deepEqual(result, ['wss://relay.nostu.be/', 'wss://relay.damus.io/']);
  });

  it('normalizes http: to ws: and drops it by default but keeps it with allowInsecure', () => {
    assert.deepEqual(sanitizeRelayHints(['http://relay.example.com']), []);
    assert.deepEqual(sanitizeRelayHints(['http://relay.example.com'], { allowInsecure: true }), [
      'ws://relay.example.com/',
    ]);
  });

  it('caps the result at the default 4 hints for 100 distinct relays', () => {
    const relays = Array.from({ length: 100 }, (_, i) => `wss://relay-${i}.example.com`);
    assert.equal(sanitizeRelayHints(relays).length, 4);
  });

  it('respects an explicit maxHints override', () => {
    const relays = Array.from({ length: 10 }, (_, i) => `wss://relay-${i}.example.com`);
    assert.equal(sanitizeRelayHints(relays, { maxHints: 2 }).length, 2);
  });

  it('dedupes entries differing only by trailing slash, hash, or query order', () => {
    // bare / trailing-slash / hash variants collapse to one entry
    assert.deepEqual(
      sanitizeRelayHints(['wss://relay.example.com/', 'wss://relay.example.com', 'wss://relay.example.com/#frag']),
      ['wss://relay.example.com/'],
    );
    // query-order variants collapse to one sorted-query entry
    assert.deepEqual(
      sanitizeRelayHints(['wss://relay.example.com/?b=2&a=1', 'wss://relay.example.com/?a=1&b=2']),
      ['wss://relay.example.com/?a=1&b=2'],
    );
    // a query-bearing URL stays distinct from the bare URL
    assert.deepEqual(
      sanitizeRelayHints(['wss://relay.example.com/', 'wss://relay.example.com/?a=1&b=2']),
      ['wss://relay.example.com/', 'wss://relay.example.com/?a=1&b=2'],
    );
  });

  it('keeps insecure and private entries when the policy opts in', () => {
    const result = sanitizeRelayHints(
      ['ws://127.0.0.1:7700/probe', 'wss://10.0.0.5/', 'wss://foo.internal/'],
      { allowInsecure: true, allowPrivateHosts: true },
    );
    assert.deepEqual(result, ['ws://127.0.0.1:7700/probe', 'wss://10.0.0.5/', 'wss://foo.internal/']);
  });
});

describe('resolveSafeRelayHints', () => {
  it('returns the sanitized list unchanged when allowPrivateHosts skips DNS', async () => {
    const result = await resolveSafeRelayHints(['wss://relay.nostu.be', 'wss://relay.damus.io/'], {
      allowPrivateHosts: true,
    });
    assert.deepEqual(result, ['wss://relay.nostu.be/', 'wss://relay.damus.io/']);
  });

  it('drops hostnames that fail to resolve (fail closed)', async () => {
    const result = await resolveSafeRelayHints(['wss://this-host-does-not-exist.invalid/']);
    assert.deepEqual(result, []);
  });

  it('keeps public IP literals without touching DNS', async () => {
    const result = await resolveSafeRelayHints(['wss://8.8.8.8/', 'wss://[2606:4700::1111]/']);
    assert.deepEqual(result, ['wss://8.8.8.8/', 'wss://[2606:4700::1111]/']);
  });
});
