import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { nip19 } from 'nostr-tools';

import {
  blockedAuthorPubkeys,
  isBlockedAuthorPubkey,
  normalizeAuthorPubkey,
} from './blocked-authors.js';

const blockedNprofile = 'nprofile1qyxhwumn8ghj7mn0wvhxcmmvqy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsz9nhwden5te0wfjkccte9ec8y6tdv9kzumn9wsq3gamnwvaz7tmwdaehgu3wdau8gu3wv3jhvqgcwaehxw309aex2mrp0yhxg6tkd9hx2tnkd9jx2mcqyzg24tqsuqemf50xql2zdlqw42aee25xwgzzrkkc4ccpstwnaldszz9qqn5';
const blockedPubkey = '90aaac10e033b4d1e607d426fc0eaabb9caa86720421dad8ae30182dd3efdb01';

afterEach(() => {
  delete process.env.NOSTUBE_BLOCKED_AUTHORS;
  delete process.env.BLOCKED_AUTHOR_NPUBS;
});

describe('blocked authors', () => {
  it('normalizes nprofile and npub values to hex pubkeys', () => {
    const npub = nip19.npubEncode(blockedPubkey);

    assert.equal(normalizeAuthorPubkey(blockedNprofile), blockedPubkey);
    assert.equal(normalizeAuthorPubkey(npub), blockedPubkey);
    assert.equal(normalizeAuthorPubkey(blockedPubkey.toUpperCase()), blockedPubkey);
  });

  it('includes the known unavailable author by default', () => {
    assert.ok(blockedAuthorPubkeys().includes(blockedPubkey));
    assert.equal(isBlockedAuthorPubkey(blockedPubkey), true);
  });

  it('accepts additional authors from the environment', () => {
    const extraPubkey = '1'.repeat(64);
    process.env.NOSTUBE_BLOCKED_AUTHORS = nip19.npubEncode(extraPubkey);

    assert.ok(blockedAuthorPubkeys().includes(extraPubkey));
  });
});
