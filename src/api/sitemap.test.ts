import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { SitemapAuthorHit, SitemapVideoHit } from './sitemap.js';

import {
  authorHitToSitemapEntry,
  buildSitemapXml,
  canonicalVideoUrl,
  isSitemapVideoEligible,
  videoHitToSitemapEntry,
} from './sitemap.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const pubkey = '0'.repeat(64);
const eventId = '1'.repeat(64);

function eligibleVideo(overrides: Partial<SitemapVideoHit> = {}): SitemapVideoHit {
  return {
    event_id: eventId,
    pubkey,
    kind: 21,
    title: 'Great Nostr Video',
    thumbnail: 'https://cdn.example.com/thumb.jpg',
    playableUrl: 'https://cdn.example.com/video.mp4',
    hasPlayableMedia: true,
    ...overrides,
  };
}

function eligibleAuthor(overrides: Partial<SitemapAuthorHit> = {}): SitemapAuthorHit {
  return {
    pubkey,
    npub: 'npub1' + pubkey.slice(5, 59),
    videoCount: 15,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

const ORIGIN = 'https://nostu.be';

/* ------------------------------------------------------------------ */
/*  canonicalVideoUrl                                                  */
/* ------------------------------------------------------------------ */

describe('canonicalVideoUrl', () => {
  it('generates nevent URL for kind 21 with event_id', () => {
    const url = canonicalVideoUrl(eligibleVideo());
    assert.ok(url?.startsWith('https://nostu.be/v/nevent1'));
    assert.equal(url?.includes('?'), false, 'no query string');
  });

  it('generates short path for kind 22', () => {
    const url = canonicalVideoUrl(eligibleVideo({ kind: 22 }));
    assert.ok(url?.startsWith('https://nostu.be/short/nevent1'));
  });

  it('generates naddr URL for parameterized kind 34235 with identifier', () => {
    const url = canonicalVideoUrl(eligibleVideo({ kind: 34235, identifier: 'abc123', d_tag: 'abc123' }));
    assert.ok(url?.startsWith('https://nostu.be/v/naddr1'));
  });

  it('generates short naddr for kind 34236 with identifier', () => {
    const url = canonicalVideoUrl(eligibleVideo({ kind: 34236, identifier: 'abc123', d_tag: 'abc123' }));
    assert.ok(url?.startsWith('https://nostu.be/short/naddr1'));
  });

  it('returns null for non-video kind', () => {
    assert.equal(canonicalVideoUrl(eligibleVideo({ kind: 1 })), null);
  });

  it('returns null for missing pubkey', () => {
    assert.equal(canonicalVideoUrl(eligibleVideo({ pubkey: '' })), null);
  });

  it('returns null for parameterized kind without identifier', () => {
    assert.equal(canonicalVideoUrl(eligibleVideo({ kind: 34235, identifier: null, d_tag: null })), null);
  });

  it('returns null for non-parameterized kind without event_id', () => {
    assert.equal(canonicalVideoUrl(eligibleVideo({ event_id: '' })), null);
  });

  it('accepts a custom site origin', () => {
    const url = canonicalVideoUrl(eligibleVideo(), 'https://example.com');
    assert.ok(url?.startsWith('https://example.com/v/nevent1'));
  });
});

/* ------------------------------------------------------------------ */
/*  isSitemapVideoEligible                                             */
/* ------------------------------------------------------------------ */

describe('isSitemapVideoEligible', () => {
  it('returns true for a fully eligible video', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo()), true);
  });

  it('returns true for short video kind 22', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ kind: 22 })), true);
  });

  it('returns true for parameterized kind 34235', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ kind: 34235 })), true);
  });

  it('returns true for parameterized kind 34236', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ kind: 34236 })), true);
  });

  it('excludes videos with contentWarning set', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ contentWarning: 'nsfw' })), false);
  });

  it('does not penalize whitespace-only contentWarning', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ contentWarning: '  ' })), true);
  });

  it('excludes videos without hasPlayableMedia', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ hasPlayableMedia: false })), false);
  });

  it('excludes videos with hasPlayableMedia undefined', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ hasPlayableMedia: undefined })), false);
  });

  it('excludes videos with no title', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ title: '' })), false);
  });

  it('excludes videos titled "Untitled"', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ title: 'Untitled' })), false);
  });

  it('excludes videos with whitespace-only title', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ title: '   ' })), false);
  });

  it('excludes videos with no thumbnail', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ thumbnail: '' })), false);
  });

  it('excludes videos with whitespace-only thumbnail', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ thumbnail: '  ' })), false);
  });

  it('excludes videos missing both playableUrl and videoUrl', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ playableUrl: null, videoUrl: null })), false);
  });

  it('accepts video with only videoUrl (no playableUrl)', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ playableUrl: null, videoUrl: 'https://cdn.example.com/video.mp4' })), true);
  });

  it('excludes non-video kinds', () => {
    assert.equal(isSitemapVideoEligible(eligibleVideo({ kind: 1 })), false);
  });
});

/* ------------------------------------------------------------------ */
/*  videoHitToSitemapEntry                                             */
/* ------------------------------------------------------------------ */

describe('videoHitToSitemapEntry', () => {
  it('returns a SitemapEntry for an eligible video', () => {
    const entry = videoHitToSitemapEntry(eligibleVideo({ published_at: 1_700_000_000 }));
    assert.ok(entry);
    assert.equal(entry.loc.startsWith('https://nostu.be/v/nevent1'), true);
    assert.ok(entry.lastmod);
    assert.ok(entry.video);
    assert.equal(entry.video.title, 'Great Nostr Video');
    assert.equal(entry.video.thumbnail, 'https://cdn.example.com/thumb.jpg');
    assert.equal(entry.video.contentUrl, 'https://cdn.example.com/video.mp4');
  });

  it('returns null for ineligible video (contentWarning)', () => {
    assert.equal(videoHitToSitemapEntry(eligibleVideo({ contentWarning: 'nsfw' })), null);
  });

  it('returns null for ineligible video (missing pubkey)', () => {
    assert.equal(videoHitToSitemapEntry(eligibleVideo({ pubkey: '' })), null);
  });

  it('includes publicationDate from published_at', () => {
    const entry = videoHitToSitemapEntry(eligibleVideo({ published_at: 1_700_000_000 }));
    assert.ok(entry?.video?.publicationDate);
  });

  it('includes duration when positive', () => {
    const entry = videoHitToSitemapEntry(eligibleVideo({ duration: 124.7 }));
    assert.equal(entry?.video?.duration, 124);
  });

  it('omits duration when zero', () => {
    const entry = videoHitToSitemapEntry(eligibleVideo({ duration: 0 }));
    assert.equal(entry?.video?.duration, undefined);
  });

  it('prefers playableUrl over videoUrl as contentUrl', () => {
    const entry = videoHitToSitemapEntry(eligibleVideo({
      playableUrl: 'https://cdn.example.com/playable.mp4',
      videoUrl: 'https://cdn.example.com/original.mp4',
    }));
    assert.equal(entry?.video?.contentUrl, 'https://cdn.example.com/playable.mp4');
  });

  it('falls back to videoUrl when playableUrl is absent', () => {
    const entry = videoHitToSitemapEntry(eligibleVideo({ playableUrl: null, videoUrl: 'https://cdn.example.com/video.mp4' }));
    assert.equal(entry?.video?.contentUrl, 'https://cdn.example.com/video.mp4');
  });

  it('uses effectivePublishedAt for lastmod when available', () => {
    const entry = videoHitToSitemapEntry(eligibleVideo({ effectivePublishedAt: 1_800_000_000, published_at: 1_700_000_000 }));
    assert.ok(entry?.lastmod?.startsWith('2027'));
  });
});

/* ------------------------------------------------------------------ */
/*  authorHitToSitemapEntry                                            */
/* ------------------------------------------------------------------ */

describe('authorHitToSitemapEntry', () => {
  it('returns an entry when videoCount > 10', () => {
    const entry = authorHitToSitemapEntry(eligibleAuthor());
    assert.ok(entry);
    assert.ok(entry.loc.startsWith('https://nostu.be/p/'));
    assert.ok(entry.lastmod);
  });

  it('returns null when videoCount is exactly 10', () => {
    assert.equal(authorHitToSitemapEntry(eligibleAuthor({ videoCount: 10 })), null);
  });

  it('returns null when videoCount is below 10', () => {
    assert.equal(authorHitToSitemapEntry(eligibleAuthor({ videoCount: 5 })), null);
  });

  it('returns null when videoCount is 0', () => {
    assert.equal(authorHitToSitemapEntry(eligibleAuthor({ videoCount: 0 })), null);
  });

  it('returns null when videoCount is undefined', () => {
    assert.equal(authorHitToSitemapEntry(eligibleAuthor({ videoCount: undefined })), null);
  });

  it('returns entry when videoCount exceeds custom minVideos', () => {
    const entry = authorHitToSitemapEntry(eligibleAuthor({ videoCount: 50 }), ORIGIN, 25);
    assert.ok(entry);
  });

  it('returns null when videoCount is at custom minVideos', () => {
    assert.equal(authorHitToSitemapEntry(eligibleAuthor({ videoCount: 25 }), ORIGIN, 25), null);
  });

  it('uses existing nprofile when npub starts with nprofile', () => {
    const entry = authorHitToSitemapEntry(eligibleAuthor({ npub: 'nprofile1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs4d2jr' }));
    assert.ok(entry);
    assert.equal(entry.loc, 'https://nostu.be/p/nprofile1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs4d2jr');
  });

  it('uses custom site origin', () => {
    const entry = authorHitToSitemapEntry(eligibleAuthor(), 'https://example.com');
    assert.ok(entry?.loc.startsWith('https://example.com/p/'));
  });

  it('omits video section for author entries', () => {
    const entry = authorHitToSitemapEntry(eligibleAuthor());
    assert.equal(entry?.video, undefined);
  });
});

/* ------------------------------------------------------------------ */
/*  buildSitemapXml                                                    */
/* ------------------------------------------------------------------ */

describe('buildSitemapXml', () => {
  it('produces a valid XML envelope with one entry', () => {
    const xml = buildSitemapXml([
      { loc: 'https://nostu.be/v/nevent1', lastmod: '2026-01-15T12:00:00.000Z' },
    ]);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<loc>https://nostu.be/v/nevent1</loc>'));
    assert.ok(xml.includes('<lastmod>2026-01-15T12:00:00.000Z</lastmod>'));
    assert.ok(xml.includes('</urlset>'));
  });

  it('includes video extensions when present', () => {
    const xml = buildSitemapXml([{
      loc: 'https://nostu.be/v/nevent1',
      video: {
        title: 'My Video',
        description: 'A description',
        thumbnail: 'https://cdn.example.com/thumb.jpg',
        contentUrl: 'https://cdn.example.com/video.mp4',
        publicationDate: '2026-01-15T12:00:00.000Z',
      },
    }]);

    assert.ok(xml.includes('<video:video>'));
    assert.ok(xml.includes('<video:title>My Video</video:title>'));
    assert.ok(xml.includes('<video:description>A description</video:description>'));
    assert.ok(xml.includes('<video:thumbnail_loc>https://cdn.example.com/thumb.jpg</video:thumbnail_loc>'));
    assert.ok(xml.includes('<video:content_loc>https://cdn.example.com/video.mp4</video:content_loc>'));
    assert.ok(xml.includes('<video:publication_date>2026-01-15T12:00:00.000Z</video:publication_date>'));
    assert.ok(xml.includes('</video:video>'));
  });

  it('escapes XML special characters in titles', () => {
    const xml = buildSitemapXml([{
      loc: 'https://nostu.be/v/nevent1',
      video: {
        title: 'Video & "Fun" <Test>',
        description: 'A > B & C < D',
        thumbnail: 'https://cdn.example.com/thumb.jpg?foo=1&bar=2',
        contentUrl: 'https://cdn.example.com/video.mp4',
      },
    }]);

    assert.ok(xml.includes('<video:title>Video &amp; &quot;Fun&quot; &lt;Test&gt;</video:title>'));
    assert.ok(xml.includes('<video:description>A &gt; B &amp; C &lt; D</video:description>'));
  });

  it('includes duration when present', () => {
    const xml = buildSitemapXml([{
      loc: 'https://nostu.be/v/nevent1',
      video: {
        title: 'T',
        description: 'D',
        thumbnail: 'https://cdn.example.com/thumb.jpg',
        contentUrl: 'https://cdn.example.com/video.mp4',
        duration: 125,
      },
    }]);

    assert.ok(xml.includes('<video:duration>125</video:duration>'));
  });

  it('handles empty entry list', () => {
    const xml = buildSitemapXml([]);
    assert.ok(xml.includes('<urlset'));
    assert.ok(xml.includes('</urlset>'));
    assert.ok(!xml.includes('<url>'));
  });

  it('uses description fallback to title when description is empty', () => {
    const xml = buildSitemapXml([{
      loc: 'https://nostu.be/v/nevent1',
      video: {
        title: 'Fallback Title',
        description: '',
        thumbnail: 'https://cdn.example.com/thumb.jpg',
        contentUrl: 'https://cdn.example.com/video.mp4',
      },
    }]);

    assert.ok(xml.includes('<video:description>Fallback Title</video:description>'));
  });
});
