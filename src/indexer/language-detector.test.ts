import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectLanguageLocally } from './language-detector.js';

describe('local language detector', () => {
  it('detects clear metadata language without external services', () => {
    assert.equal(
      detectLanguageLocally({
        title: 'Dies ist ein Video ueber Nostr und Bitcoin',
        summary: 'Eine laengere Beschreibung hilft dabei, die Sprache eindeutig zu erkennen.',
        content: null,
      })?.language,
      'de',
    );

    assert.equal(
      detectLanguageLocally({
        title: 'This is a video about Nostr and Bitcoin',
        summary: 'A longer description helps the detector identify the language reliably.',
        content: null,
      })?.language,
      'en',
    );
  });

  it('does not guess from short ambiguous metadata', () => {
    assert.equal(
      detectLanguageLocally({
        title: 'Nostr update',
        summary: '',
        content: null,
      }),
      null,
    );
  });
});
