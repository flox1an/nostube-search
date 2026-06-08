import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractBlossomHash,
  mediaAvailabilityKey,
  snapshotFromAvailability,
} from './media-availability.js';

const hash = 'a'.repeat(64);

describe('media availability helpers', () => {
  it('uses sha256 keys when a hash is available', () => {
    assert.equal(
      mediaAvailabilityKey({
        hash,
        videoUrl: 'https://videos.example.com/watch?id=123',
      }),
      `sha256:${hash}`,
    );
  });

  it('extracts sha256 keys from Blossom-style URLs', () => {
    const url = `https://blossom.example.com/${hash}.mp4`;

    assert.equal(extractBlossomHash(url), hash);
    assert.equal(mediaAvailabilityKey({ videoUrl: url }), `sha256:${hash}`);
  });

  it('falls back to normalized URL keys for non-Blossom media', () => {
    assert.equal(
      mediaAvailabilityKey({ videoUrl: 'HTTPS://Media.Example.com/video.mp4#frag' }),
      'url:https://media.example.com/video.mp4',
    );
  });

  it('turns durable availability docs into video snapshots', () => {
    assert.deepEqual(
      snapshotFromAvailability(`sha256:${hash}`, {
        id: `sha256:${hash}`,
        mediaKey: `sha256:${hash}`,
        status: 'available',
        playableUrl: `https://mirror.example.com/${hash}.mp4`,
        checkedAt: 10,
        retryAfter: null,
        attempts: 2,
        checkedUrls: [],
        sourceUrlCount: 3,
      }),
      {
        mediaAvailabilityKey: `sha256:${hash}`,
        availabilityStatus: 'available',
        hasPlayableMedia: true,
        playableUrl: `https://mirror.example.com/${hash}.mp4`,
        mediaCheckedAt: 10,
        mediaRetryAfter: null,
      },
    );
  });
});
