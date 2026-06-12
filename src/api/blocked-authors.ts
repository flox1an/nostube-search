import { nip19 } from 'nostr-tools';

const DEFAULT_BLOCKED_AUTHOR_REFS = [
  'npub1jz42cy8qxw6dres86sn0cr42hww24pnjqssa4k9wxqvzm5l0mvqsq2f5ku',
];

const HEX_PUBKEY_RE = /^[a-f0-9]{64}$/i;

export function normalizeAuthorPubkey(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (HEX_PUBKEY_RE.test(trimmed)) return trimmed.toLowerCase();

  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'npub') return decoded.data;
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  } catch {
    return null;
  }

  return null;
}

function envBlockedAuthorRefs(): string[] {
  return (process.env.NOSTUBE_BLOCKED_AUTHORS ?? process.env.BLOCKED_AUTHOR_NPUBS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

export function blockedAuthorPubkeys(): string[] {
  return [...new Set([...DEFAULT_BLOCKED_AUTHOR_REFS, ...envBlockedAuthorRefs()]
    .map(normalizeAuthorPubkey)
    .filter((pubkey): pubkey is string => Boolean(pubkey))
  )];
}

export function isBlockedAuthorPubkey(pubkey: string | undefined | null): boolean {
  return Boolean(pubkey && blockedAuthorPubkeys().includes(pubkey));
}
