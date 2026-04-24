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
  let ingestArgs = null;
  const result = await saveTweetMedia({
    ingestUrl: async (args) => {
      ingestArgs = args;
      return {
        response: { ok: true },
        payload: { results: [{ status: 'duplicate' }] },
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
    externalRefs: [{
      provider: 'twitter',
      external_id: '123',
      url: 'https://x.com/demo/status/123',
    }],
    mediaCandidates: [{
      mediaType: 'image',
      strategy: 'direct',
      url: 'https://pbs.twimg.com/media/One?format=jpg&name=orig',
      key: 'one',
    }],
  });

  assert.equal(result.duplicateFound, true);
  assert.deepEqual(result.summary, { accepted: 0, duplicate: 1, failed: 0 });
  assert.deepEqual(ingestArgs?.externalRefs, [{
    provider: 'twitter',
    external_id: '123',
    url: 'https://x.com/demo/status/123',
  }]);
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

test('saveTweetMedia uploads cobalt-resolved assets via ingest-url', async () => {
  let ingestCalls = 0;
  const result = await saveTweetMedia({
    ingestUrl: async () => {
      ingestCalls += 1;
      return {
        response: { ok: true },
        payload: { results: [{ status: 'accepted' }] },
      };
    },
    uploadBlob: async () => {
      throw new Error('should not upload when ingest succeeds');
    },
    fetchMediaBlob: async () => {
      throw new Error('should not fetch when ingest succeeds');
    },
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

  assert.equal(ingestCalls, 1);
  assert.equal(result.hasFailure, false);
  assert.deepEqual(result.summary, { accepted: 1, duplicate: 0, failed: 0 });
});

test('saveTweetMedia falls back to blob upload when cobalt ingest fails', async () => {
  let uploaded = 0;
  let uploadArgs = null;
  const result = await saveTweetMedia({
    ingestUrl: async () => ({
      response: { ok: false, status: 415 },
      payload: {},
    }),
    uploadBlob: async (args) => {
      uploaded += 1;
      uploadArgs = args;
      return {
        response: { ok: true },
        payload: { results: [{ status: 'accepted' }] },
      };
    },
    fetchMediaBlob: async () => ({
      blob: new Blob(['gif-bytes']),
      filename: 'tweet.gif',
    }),
    ensureOriginPermission: async () => true,
    resolveCobaltTweet: async () => ({
      status: 'redirect',
      url: 'https://cobalt.example/download.gif',
      filename: 'tweet.gif',
    }),
  }, {
    baseUrl: 'https://zukan.example',
    apiKey: 'zk_123',
    cobaltBaseUrl: 'https://api.cobalt.tools',
  }, {
    externalRefs: [{
      provider: 'twitter',
      external_id: '123',
      url: 'https://x.com/demo/status/123',
    }],
    mediaCandidates: [{
      mediaType: 'video',
      strategy: 'cobalt',
      tweetUrl: 'https://x.com/demo/status/123',
      key: 'cobalt',
    }],
  });

  assert.equal(uploaded, 1);
  assert.equal(result.hasFailure, false);
  assert.deepEqual(result.summary, { accepted: 1, duplicate: 0, failed: 0 });
  assert.deepEqual(uploadArgs?.externalRefs, [{
    provider: 'twitter',
    external_id: '123',
    url: 'https://x.com/demo/status/123',
  }]);
});

test('saveTweetMedia prefers cobalt video and skips direct video once cobalt succeeds', async () => {
  let ingestCalls = 0;
  let uploaded = 0;

  const result = await saveTweetMedia({
    ingestUrl: async () => {
      ingestCalls += 1;
      return {
        response: { ok: true },
        payload: { results: [{ status: 'accepted' }] },
      };
    },
    uploadBlob: async () => {
      uploaded += 1;
      return {
        response: { ok: true },
        payload: { results: [{ status: 'accepted' }] },
      };
    },
    fetchMediaBlob: async () => ({
      blob: new Blob(['gif-bytes']),
      filename: 'tweet.gif',
    }),
    ensureOriginPermission: async () => true,
    resolveCobaltTweet: async () => ({
      status: 'redirect',
      url: 'https://cobalt.example/download.gif',
      filename: 'tweet.gif',
    }),
  }, {
    baseUrl: 'https://zukan.example',
    apiKey: 'zk_123',
    cobaltBaseUrl: 'https://api.cobalt.tools',
  }, {
    mediaCandidates: [
      {
        mediaType: 'video',
        strategy: 'direct',
        url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/clip.mp4',
        key: 'direct-video',
      },
      {
        mediaType: 'video',
        strategy: 'cobalt',
        tweetUrl: 'https://x.com/demo/status/123',
        key: 'cobalt-video',
      },
    ],
  });

  assert.equal(ingestCalls, 1);
  assert.equal(uploaded, 0);
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
