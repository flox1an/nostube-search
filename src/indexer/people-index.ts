/**
 * MeiliSearch `people` index — stores author profiles for full-text people search.
 *
 * Only authors who have at least one video indexed are present. The `videoCount`
 * field is set to the exact count during a full re-index and to the batch count
 * during incremental updates (corrected on the next full run).
 */

import { nip19 } from 'nostr-tools';
import type { MeiliSearch } from 'meilisearch';

import type { AuthorProfile } from './scoring.js';

export const PEOPLE_INDEX_UID = 'people';

export type PeopleDocument = {
  /** Primary key */
  pubkey: string;
  npub: string;
  name: string | null;
  display_name: string | null;
  username: string | null;
  about: string | null;
  picture: string | null;
  nip05: string | null;
  lud16: string | null;
  videoCount: number;
  globalTrustScore: number;
  updatedAt: number;
};

export async function applyPeopleIndexSettings(client: MeiliSearch, uid: string): Promise<void> {
  const task = await client.index(uid).updateSettings({
    searchableAttributes: [
      'name', 'display_name', 'username', 'about', 'nip05', 'npub', 'pubkey',
    ],
    filterableAttributes: ['pubkey', 'videoCount'],
    sortableAttributes: ['videoCount', 'globalTrustScore', 'updatedAt'],
    rankingRules: [
      'words', 'typo', 'proximity', 'attribute', 'exactness',
      'videoCount:desc', 'globalTrustScore:desc',
    ],
  });
  await client.waitForTask(task.taskUid);
}

export async function ensurePeopleIndex(client: MeiliSearch): Promise<void> {
  try {
    await client.getIndex(PEOPLE_INDEX_UID);
    await applyPeopleIndexSettings(client, PEOPLE_INDEX_UID);
  } catch {
    const task = await client.createIndex(PEOPLE_INDEX_UID, { primaryKey: 'pubkey' });
    await client.waitForTask(task.taskUid);
    await applyPeopleIndexSettings(client, PEOPLE_INDEX_UID);
  }
}

export function buildPeopleDocuments(
  pubkeyVideoCount: Map<string, number>,
  profileByPubkey: Map<string, AuthorProfile>,
  trustScoreByPubkey: Map<string, number>,
): PeopleDocument[] {
  const now = Math.floor(Date.now() / 1000);
  const docs: PeopleDocument[] = [];

  for (const [pubkey, videoCount] of pubkeyVideoCount) {
    const profile = profileByPubkey.get(pubkey);

    let npub = pubkey;
    try { npub = nip19.npubEncode(pubkey); } catch { /* keep hex fallback */ }

    docs.push({
      pubkey,
      npub,
      name: profile?.name ?? null,
      display_name: profile?.display_name ?? null,
      username: profile?.username ?? null,
      about: profile?.about ?? null,
      picture: profile?.picture ?? null,
      nip05: profile?.nip05 ?? null,
      lud16: profile?.lud16 ?? null,
      videoCount,
      globalTrustScore: trustScoreByPubkey.get(pubkey) ?? 0.5,
      updatedAt: now,
    });
  }

  return docs;
}

const UPSERT_BATCH = 500;

export async function upsertPeopleDocuments(
  client: MeiliSearch,
  docs: PeopleDocument[],
): Promise<void> {
  if (docs.length === 0) return;

  for (let i = 0; i < docs.length; i += UPSERT_BATCH) {
    const batch = docs.slice(i, i + UPSERT_BATCH);
    const task = await client.index(PEOPLE_INDEX_UID).addDocuments(batch, { primaryKey: 'pubkey' });
    await client.waitForTask(task.taskUid);
    console.log(`[People] Upserted ${Math.min(i + UPSERT_BATCH, docs.length)}/${docs.length} people`);
  }
}
