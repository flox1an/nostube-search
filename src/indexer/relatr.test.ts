import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { connectTrustScoreClient, disconnectTrustScoreClient, fetchTrustScores } from './relatr.js';
import { setCachePath } from './trust-cache.js';

const COOLDOWN_MS = 200;
const pk = (n: number) => n.toString(16).padStart(64, '0');

const requested: string[][] = [];
let respond: (pubkeys: string[]) => Promise<unknown> = () => new Promise(() => {});

function scoresFor(pubkeys: string[]) {
  return {
    structuredContent: {
      trustScores: pubkeys.map(targetPubkey => ({
        targetPubkey,
        components: { validators: { video_creator_activity: { score: 0.8 } } },
      })),
    },
  };
}

describe('relatr trust score cooldown', () => {
  before(async () => {
    process.env.TRUST_SCORE_CHUNK_TIMEOUT_MS = '30';
    process.env.TRUST_SCORE_COOLDOWN_MS = String(COOLDOWN_MS);
    process.env.TRUST_SCORE_CHUNK_SIZE = '1';
    process.env.TRUST_SCORE_DISCONNECT_TIMEOUT_MS = '50';
    setCachePath(join(mkdtempSync(join(tmpdir(), 'nostube-trust-')), 'trust-cache.json'));

    mock.method(Client.prototype, 'connect', async () => {});
    mock.method(Client.prototype, 'close', async () => {});
    mock.method(Client.prototype, 'callTool', async (params: { arguments: { targetPubkeys: string[] } }) => {
      requested.push(params.arguments.targetPubkeys);
      return respond(params.arguments.targetPubkeys);
    });
    await connectTrustScoreClient();
  });

  after(async () => {
    await disconnectTrustScoreClient();
    mock.restoreAll();
  });

  it('backs off after one timed-out chunk and retries once the cooldown expires', async () => {
    requested.length = 0;
    respond = () => new Promise(() => {});

    assert.equal((await fetchTrustScores([pk(1)])).has(pk(1)), false);
    assert.equal(requested.length, 1);

    assert.equal((await fetchTrustScores([pk(1)])).has(pk(1)), false);
    assert.equal(requested.length, 1, 'repeated single fetch during cooldown must not hit relatr');

    await sleep(COOLDOWN_MS + 50);
    respond = pubkeys => Promise.resolve(scoresFor(pubkeys));
    assert.equal((await fetchTrustScores([pk(1)])).get(pk(1)), 0.8);
    assert.deepEqual(requested, [[pk(1)], [pk(1)]]);
  });

  it('stops remaining chunks of concurrent fetches and keeps the cooldown across reconnect', async () => {
    await sleep(COOLDOWN_MS + 50);
    requested.length = 0;
    respond = () => new Promise(() => {});

    await Promise.all([fetchTrustScores([pk(2), pk(3)]), fetchTrustScores([pk(4), pk(5)])]);
    assert.deepEqual(requested, [[pk(2)], [pk(4)]]);

    await disconnectTrustScoreClient();
    await connectTrustScoreClient();
    await fetchTrustScores([pk(6)]);
    assert.equal(requested.length, 2, 'disconnect must not reset the cooldown');
  });

  it('treats the MCP SDK request timeout as a timeout', async () => {
    await sleep(COOLDOWN_MS + 50);
    requested.length = 0;
    respond = () => Promise.reject(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));

    await fetchTrustScores([pk(7), pk(8)]);
    await fetchTrustScores([pk(9)]);
    assert.deepEqual(requested, [[pk(7)]]);
  });
});
