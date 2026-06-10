import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';

import { filterVerifiedEvents, hasValidEventSignature } from '../nostr-events.js';

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
