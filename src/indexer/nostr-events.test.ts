import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';

import { deriveVideoTitle, filterVerifiedEvents, hasValidEventSignature, isPlaceholderTitle } from '../nostr-events.js';

describe('nostr event validation', () => {
  it('accepts events with valid signatures', () => {
    const event = finalizeEvent(
      { kind: 1, created_at: 123, tags: [], content: 'hello' },
      generateSecretKey(),
    );

    assert.equal(hasValidEventSignature(event), true);
    assert.deepEqual(filterVerifiedEvents([event], 'test'), [event]);
  });

  it('rejects events whose content no longer matches the signature', () => {
    const event = finalizeEvent(
      { kind: 1, created_at: 123, tags: [], content: 'hello' },
      generateSecretKey(),
    );
    const tampered = {
      ...event,
      content: 'goodbye',
    };

    assert.equal(hasValidEventSignature(tampered), false);
    assert.deepEqual(filterVerifiedEvents([event, tampered], 'test'), [event]);
  });

  it('does not trust a cached verification marker on the input object', () => {
    const event = finalizeEvent(
      { kind: 1, created_at: 123, tags: [], content: 'hello' },
      generateSecretKey(),
    );
    event.content = 'goodbye';

    assert.equal(hasValidEventSignature(event), false);
  });
});

describe('deriveVideoTitle', () => {
  it('prefers title tag, then imeta alt, then content, stripping URLs', () => {
    assert.equal(deriveVideoTitle([['title', 'Real'], ['imeta', 'alt Alt']], 'c'), 'Real');
    assert.equal(deriveVideoTitle([['imeta', 'url https://x.y/v.mp4', 'alt Watch https://x.y/v.mp4 now']], 'c'), 'Watch now');
    assert.equal(deriveVideoTitle([], '跳个舞 https://x.y/v.mp4 #美女'), '跳个舞 #美女');
  });

  it('returns empty instead of a placeholder for URL-only content', () => {
    assert.equal(deriveVideoTitle([], 'https://x.y/only.mp4'), '');
    assert.equal(isPlaceholderTitle(''), true);
    assert.equal(isPlaceholderTitle('Untitled'), true);
    assert.equal(isPlaceholderTitle('Cats'), false);
  });
});
