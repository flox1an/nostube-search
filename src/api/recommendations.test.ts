import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nip19 } from 'nostr-tools';

import {
  AsyncTtlCache,
  buildUserRecommendationProfile,
  getKindAffinity,
  getTagAffinity,
  mapRecommendationHit,
  parseVideoRef,
  scoreRecommendation,
  type RecommendationSearchHit,
} from './recommendations.js';

const pubkey = '0'.repeat(64);
const eventId = '1'.repeat(64);

describe('parseVideoRef', () => {
  it('resolves raw event ids as event_id lookups', () => {
    assert.deepEqual(parseVideoRef(eventId), {
      type: 'event',
      eventId,
      relays: [],
    });
  });

  it('resolves nevent references as event_id lookups', () => {
    const nevent = nip19.neventEncode({
      id: eventId,
      author: pubkey,
      kind: 21,
      relays: ['wss://relay.example.com'],
    });

    assert.deepEqual(parseVideoRef(nevent), {
      type: 'event',
      eventId,
      relays: ['wss://relay.example.com'],
    });
  });

  it('resolves naddr references as address lookups', () => {
    const naddr = nip19.naddrEncode({
      kind: 34235,
      pubkey,
      identifier: 'intro',
      relays: ['wss://relay.example.com'],
    });

    assert.deepEqual(parseVideoRef(naddr), {
      type: 'address',
      kind: 34235,
      pubkey,
      identifier: 'intro',
      relays: ['wss://relay.example.com'],
    });
  });
});

describe('mapRecommendationHit', () => {
  it('returns the minimal shape used by Nostube suggestions', () => {
    const hit: RecommendationSearchHit = {
      event_id: eventId,
      kind: 34235,
      identifier: 'intro',
      pubkey,
      title: 'Intro to Nostr video',
      created_at: 100,
      published_at: 120,
      duration: 300,
      thumbnail: 'https://example.com/thumb.webp',
      thumbnailBlurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
      videoUrl: 'https://example.com/video.mp4',
      fallbackUrls: ['https://mirror.example.com/video.mp4'],
      mediaType: 'video',
      contentWarning: null,
      rankingScore: 0.7,
      reactionsCount: 2,
      commentsCount: 1,
      zapsCount: 0,
    };

    const mapped = mapRecommendationHit(hit, 0.42);

    assert.deepEqual(mapped, {
      id: eventId,
      kind: 34235,
      identifier: 'intro',
      pubkey,
      title: 'Intro to Nostr video',
      images: ['https://example.com/thumb.webp'],
      urls: ['https://example.com/video.mp4', 'https://mirror.example.com/video.mp4'],
      duration: 300,
      created_at: 100,
      published_at: 120,
      link: nip19.naddrEncode({ kind: 34235, pubkey, identifier: 'intro' }),
      type: 'videos',
      mediaType: 'video',
      contentWarning: null,
      thumbnailVariants: [
        {
          url: 'https://example.com/thumb.webp',
          fallbackUrls: [],
          mediaType: 'image',
          blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        },
      ],
      recommendationScore: 0.42,
    });
  });
});

describe('scoreRecommendation', () => {
  it('keeps author affinity lightweight for logged-in users', () => {
    const scoreWithoutAuthor = scoreRecommendation({
      candidate: { rankingScore: 0.5, reactionsCount: 0, commentsCount: 0, zapsCount: 0 },
      contentSimilarity: 0.5,
      tagAffinity: 0,
      authorAffinity: 0,
      loggedIn: true,
    });
    const scoreWithAuthor = scoreRecommendation({
      candidate: { rankingScore: 0.5, reactionsCount: 0, commentsCount: 0, zapsCount: 0 },
      contentSimilarity: 0.5,
      tagAffinity: 0,
      authorAffinity: 1,
      loggedIn: true,
    });

    assert.equal(Number((scoreWithAuthor - scoreWithoutAuthor).toFixed(2)), 0.05);
  });

  it('keeps kind affinity tiny for logged-in users', () => {
    const scoreWithoutKind = scoreRecommendation({
      candidate: { rankingScore: 0.5, reactionsCount: 0, commentsCount: 0, zapsCount: 0 },
      contentSimilarity: 0.5,
      tagAffinity: 0,
      authorAffinity: 0,
      kindAffinity: 0,
      loggedIn: true,
    });
    const scoreWithKind = scoreRecommendation({
      candidate: { rankingScore: 0.5, reactionsCount: 0, commentsCount: 0, zapsCount: 0 },
      contentSimilarity: 0.5,
      tagAffinity: 0,
      authorAffinity: 0,
      kindAffinity: 1,
      loggedIn: true,
    });

    assert.equal(Number((scoreWithKind - scoreWithoutKind).toFixed(2)), 0.03);
  });
});

describe('user recommendation profile', () => {
  it('turns visible user reactions into tag affinity', () => {
    const profile = buildUserRecommendationProfile(
      pubkey,
      [{ kind: 7, tags: [['e', eventId]] }],
      [{ event_id: eventId, pubkey: '2'.repeat(64), kind: 21, tags: ['nostr', 'music'] }],
    );

    assert.equal(getTagAffinity({ tags: ['nostr'] }, profile), 1);
    assert.equal(getTagAffinity({ tags: ['cooking'] }, profile), 0);
    assert.equal(getKindAffinity({ kind: 21 }, profile), 1);
    assert.equal(getKindAffinity({ kind: 22 }, profile), 0);
  });
});

describe('AsyncTtlCache', () => {
  it('deduplicates concurrent cache misses and then serves cached values', async () => {
    const cache = new AsyncTtlCache<string, number>();
    let calls = 0;
    const factory = async () => {
      calls++;
      return 7;
    };

    const [first, second] = await Promise.all([
      cache.getOrCreate('score', factory, 1_000),
      cache.getOrCreate('score', factory, 1_000),
    ]);
    const third = await cache.getOrCreate('score', factory, 1_000);

    assert.equal(first, 7);
    assert.equal(second, 7);
    assert.equal(third, 7);
    assert.equal(calls, 1);
  });
});
