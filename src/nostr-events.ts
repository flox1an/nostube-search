import { validateEvent, verifyEvent, type Event } from 'nostr-tools';

function cleanEventForVerification(event: Event): Event {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };
}

export function hasValidEventSignature(event: Event): boolean {
  if (!validateEvent(event)) return false;
  return verifyEvent(cleanEventForVerification(event));
}

export function filterVerifiedEvents(events: Event[], source: string): Event[] {
  const verified = events.filter(hasValidEventSignature);
  const rejected = events.length - verified.length;

  if (rejected > 0) {
    console.warn(`[NostrEvents] Rejected ${rejected}/${events.length} event(s) with invalid signatures from ${source}`);
  }

  return verified;
}

const URL_IN_TEXT_REGEX = /https?:\/\/[^\s)]+/g;

// Mirrors nostube's title derivation (packages/core/src/video-event.ts): `title` tag,
// else first imeta `alt`, else content, with URLs stripped. Empty instead of a placeholder.
export function deriveVideoTitle(tags: string[][], content: string | null): string {
  const titleTag = tags.find(tag => tag[0] === 'title')?.[1];
  if (titleTag) return titleTag;
  const alt = tags.find(tag => tag[0] === 'imeta')
    ?.find(entry => entry.startsWith('alt '))
    ?.slice(4)
    .trim();
  return (alt || content || '').replace(URL_IN_TEXT_REGEX, ' ').replace(/\s+/g, ' ').trim();
}

const PLACEHOLDER_TITLES: Record<string, true> = { untitled: true, 'untitled video': true };

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  const normalized = title?.trim().toLowerCase();
  return !normalized || PLACEHOLDER_TITLES[normalized] === true;
}
