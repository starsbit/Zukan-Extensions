import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCobaltAssets, saveTweetMedia } from './background-core.js';

test('resolveCobaltAssets accepts tunnel responses', () => {
  assert.deepEqual(resolveCobaltAssets({
    status: 'tunnel',
    url: 'https://cobalt.example/download.mp4',
    filename: 'tweet.mp4',
  }), [{
    url: 'https://cobalt.example/download.mp4',
    filename: 'tweet.mp4',
  }]);
});

test('saveTweetMedia reports duplicates from direct ingest', async () => {
  const result = await saveTweetMedia({
    ingestUrl: async () => ({
      response: { ok: true },
      payload: { results: [{ status: 'duplicate' }] },
    }),
    uploadBlob: async () => {
      throw new Error('should not upload');
    },
    fetchMediaBlob: async () => {
      throw new Error('should not fetch');
    },
    ensureOriginPermission: async () => true,
    resolveCobaltTweet: async () => {
      throw new Error('should not use cobalt');
    },
  }, {
    baseUrl: 'https://zukan.example',
    apiKey: 'zk_123',
    cobaltBaseUrl: 'https://api.cobalt.tools',
  }, {
    mediaCandidates: [{
      mediaType: 'image',
      strategy: 'direct',
      url: 'https://pbs.twimg.com/media/One?format=jpg&name=orig',
      key: 'one',
    }],
  });

  assert.equal(result.duplicateFound, true);
  assert.deepEqual(result.summary, { accepted: 0, duplicate: 1, failed: 0 });
});

test('saveTweetMedia returns combined duplicate and accepted counts for multi-media tweets', async () => {
  let calls = 0;
  const result = await saveTweetMedia({
    ingestUrl: async () => {
      calls += 1;
      return {
        response: { ok: true },
        payload: { results: [{ status: calls === 1 ? 'duplicate' : 'accepted' }] },
      };
    },
    uploadBlob: async () => {
      throw new Error('should not upload');
    },
    fetchMediaBlob: async () => {
      throw new Error('should not fetch');
    },
    ensureOriginPermission: async () => true,
    resolveCobaltTweet: async () => {
      throw new Error('should not use cobalt');
    },
  }, {
    baseUrl: 'https://zukan.example',
    apiKey: 'zk_123',
    cobaltBaseUrl: 'https://api.cobalt.tools',
  }, {
    mode: 'manual',
    mediaCandidates: [
      {
        mediaType: 'image',
        strategy: 'direct',
        url: 'https://pbs.twimg.com/media/One?format=jpg&name=orig',
        key: 'one',
      },
      {
        mediaType: 'image',
        strategy: 'direct',
        url: 'https://pbs.twimg.com/media/Two?format=jpg&name=orig',
        key: 'two',
      },
    ],
  });

  assert.equal(result.duplicateFound, true);
  assert.deepEqual(result.summary, { accepted: 1, duplicate: 1, failed: 0 });
});

test('saveTweetMedia uploads cobalt-resolved assets', async () => {
  let uploaded = 0;
  const result = await saveTweetMedia({
    ingestUrl: async () => {
      throw new Error('should not ingest cobalt fallback urls');
    },
    uploadBlob: async () => {
      uploaded += 1;
      return {
        response: { ok: true },
        payload: { results: [{ status: 'accepted' }] },
      };
    },
    fetchMediaBlob: async () => ({
      blob: new Blob(['video']),
      filename: 'tweet.mp4',
    }),
    ensureOriginPermission: async () => true,
    resolveCobaltTweet: async () => ({
      status: 'redirect',
      url: 'https://cobalt.example/download.mp4',
      filename: 'tweet.mp4',
    }),
  }, {
    baseUrl: 'https://zukan.example',
    apiKey: 'zk_123',
    cobaltBaseUrl: 'https://api.cobalt.tools',
  }, {
    mediaCandidates: [{
      mediaType: 'video',
      strategy: 'cobalt',
      tweetUrl: 'https://x.com/demo/status/123',
      key: 'two',
    }],
  });

  assert.equal(uploaded, 1);
  assert.equal(result.hasFailure, false);
  assert.deepEqual(result.summary, { accepted: 1, duplicate: 0, failed: 0 });
});

test('saveTweetMedia times out stalled manual video saves and keeps reporting failure', async () => {
  const result = await saveTweetMedia({
    ingestUrl: async () => new Promise(() => {}),
    uploadBlob: async () => {
      throw new Error('should not upload');
    },
    fetchMediaBlob: async () => {
      throw new Error('should not fetch');
    },
    ensureOriginPermission: async () => true,
    resolveCobaltTweet: async () => {
      throw new Error('should not use cobalt');
    },
  }, {
    baseUrl: 'https://zukan.example',
    apiKey: 'zk_123',
    cobaltBaseUrl: 'https://api.cobalt.tools',
  }, {
    mode: 'manual',
    mediaCandidates: [{
      mediaType: 'video',
      strategy: 'direct',
      url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/clip.mp4',
      key: 'slow-video',
    }],
  });

  assert.equal(result.hasFailure, true);
  assert.equal(result.summary.failed, 1);
  assert.match(result.failureMessage, /timed out/i);
});
