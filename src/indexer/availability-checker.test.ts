import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAvailabilityCandidateUrls } from './availability-checker.js';

const hash = 'a'.repeat(64);

describe('availability checker', () => {
  it('builds HEAD candidates from direct, fallback, and author Blossom URLs', async () => {
    const urls = await buildAvailabilityCandidateUrls(
      {
        videoUrl: `https://origin.example.com/${hash}.webm`,
        fallbackUrls: [
          `https://mirror.example.com/${hash}.webm`,
          `https://origin.example.com/${hash}.webm`,
        ],
        mediaAvailabilityKey: `sha256:${hash}`,
      },
      ['https://author-blossom.example.com/', 'https://mirror.example.com'],
    );

    assert.deepEqual(urls, [
      `https://origin.example.com/${hash}.webm`,
      `https://mirror.example.com/${hash}.webm`,
      `https://author-blossom.example.com/${hash}.webm`,
    ]);
  });

  it('uses mp4 as the author Blossom fallback extension when none is known', async () => {
    const urls = await buildAvailabilityCandidateUrls(
      { hash, videoUrl: 'https://media.example.com/watch?id=123' },
      ['https://author-blossom.example.com'],
    );

    assert.deepEqual(urls, [
      'https://media.example.com/watch?id=123',
      `https://author-blossom.example.com/${hash}.mp4`,
    ]);
  });
});
