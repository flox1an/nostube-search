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
