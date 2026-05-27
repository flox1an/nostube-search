import { SimplePool, type Event } from 'nostr-tools';

import type { AuthorProfile } from './scoring.js';
import * as profileCache from './profile-cache.js';

export function parseAuthorProfile(content: string | null): AuthorProfile | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const displayName =
      typeof parsed.display_name === 'string'
        ? parsed.display_name
        : typeof parsed.displayName === 'string'
          ? parsed.displayName
          : undefined;

    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      display_name: displayName,
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      about: typeof parsed.about === 'string' ? parsed.about : undefined,
      picture: typeof parsed.picture === 'string' ? parsed.picture : undefined,
      nip05: typeof parsed.nip05 === 'string' ? parsed.nip05 : undefined,
      lud16: typeof parsed.lud16 === 'string' ? parsed.lud16 : undefined,
    };
  } catch {
    return null;
  }
}

function relayUrlsFromEnv(): string[] {
  return (process.env.NOSTR_INDEX_RELAYS ?? process.env.NOSTR_INDEX_NRELAY ?? '')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);
}

function latestProfileEventsByPubkey(events: Event[]): Map<string, Event> {
  const latest = new Map<string, Event>();

  for (const event of events) {
    const existing = latest.get(event.pubkey);
    if (!existing || event.created_at > existing.created_at) {
      latest.set(event.pubkey, event);
    }
  }

  return latest;
}

async function fetchProfilesFromRelay(pubkeys: string[]): Promise<Map<string, AuthorProfile>> {
  const relays = relayUrlsFromEnv();
  if (relays.length === 0 || pubkeys.length === 0) return new Map<string, AuthorProfile>();

  const pool = new SimplePool({ enablePing: true, enableReconnect: false });
  const maxWait = Number(process.env.NOSTR_INDEX_PROFILE_FETCH_MAX_WAIT_MS) || 6_000;

  try {
    const events = await pool.querySync(
      relays,
      {
        kinds: [0],
        authors: pubkeys,
        limit: pubkeys.length,
      },
      {
        maxWait,
        label: 'nostube-search-profiles',
      },
    );

    const profiles = new Map<string, AuthorProfile>();
    for (const [pubkey, event] of latestProfileEventsByPubkey(events)) {
      const profile = parseAuthorProfile(event.content);
      if (profile) {
        profiles.set(pubkey, profile);
      }
    }

    return profiles;
  } finally {
    pool.destroy();
  }
}

export async function fetchAuthorProfiles(pubkeys: string[]): Promise<Map<string, AuthorProfile>> {
  const uniquePubkeys = Array.from(new Set(pubkeys.filter(Boolean)));
  const cached = profileCache.getMany(uniquePubkeys);
  const profiles = new Map(cached.profiles);

  const relays = relayUrlsFromEnv();
  if (cached.missingPubkeys.length === 0) return profiles;
  if (relays.length === 0) {
    console.log('[Profiles] NOSTR_INDEX_RELAYS not configured; using database profiles only for cache misses');
    return profiles;
  }

  const fetchStart = Date.now();
  let relayProfiles: Map<string, AuthorProfile>;
  try {
    relayProfiles = await fetchProfilesFromRelay(cached.missingPubkeys);
  } catch (err) {
    console.warn('[Profiles] Failed to fetch profiles from Nostr relay; using database profiles for cache misses:', err);
    return profiles;
  }

  const relayMisses = cached.missingPubkeys.filter(pubkey => !relayProfiles.has(pubkey));

  for (const [pubkey, profile] of relayProfiles) {
    profiles.set(pubkey, profile);
  }

  profileCache.setMany(relayProfiles, relayMisses);
  console.log(`[Profiles] Fetched ${relayProfiles.size}/${cached.missingPubkeys.length} profiles from ${relays.join(', ')} (${Date.now() - fetchStart}ms)`);

  return profiles;
}

export { profileCache };
