import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COBALT_BASE_URL,
  createAuthHeaders,
  deriveFilename,
  normalizeOptionalBaseUrl,
  normalizeBaseUrl,
  normalizeMediaVisibility,
  originPatternFromUrl,
  rebaseCobaltAssetUrl,
  shouldFallbackFromIngest,
  summarizeBatchResults,
} from './helpers.js';

test('normalizeBaseUrl trims path/query/hash noise', () => {
  assert.equal(
    normalizeBaseUrl('https://example.com/zukan/?foo=bar#frag'),
    'https://example.com/zukan',
  );
});

test('normalizeOptionalBaseUrl falls back to the default cobalt instance', () => {
  assert.equal(normalizeOptionalBaseUrl('', DEFAULT_COBALT_BASE_URL), 'https://api.cobalt.tools/');
});

test('normalizeMediaVisibility only accepts private or public', () => {
  assert.equal(normalizeMediaVisibility('private'), 'private');
  assert.equal(normalizeMediaVisibility('public'), 'public');
  assert.equal(normalizeMediaVisibility('PUBLIC'), 'public');
  assert.equal(normalizeMediaVisibility('friends-only'), 'private');
});

test('originPatternFromUrl converts a server URL into a Chrome origin pattern', () => {
  assert.equal(originPatternFromUrl('https://example.com/zukan'), 'https://example.com/*');
});

test('createAuthHeaders uses bearer auth', () => {
  assert.deepEqual(createAuthHeaders('zk_123', { Accept: 'application/json' }), {
    Accept: 'application/json',
    Authorization: 'Bearer zk_123',
  });
});

test('deriveFilename prefers content-disposition and appends a missing extension', () => {
  assert.equal(
    deriveFilename(
      'https://cdn.example.com/asset',
      'image/webp',
      `attachment; filename*=UTF-8''Pretty%20Image`,
    ),
    'Pretty Image.webp',
  );
});

test('shouldFallbackFromIngest allows recoverable ingest failures', () => {
  assert.equal(shouldFallbackFromIngest(502, { detail: 'Remote fetch failed' }), true);
  assert.equal(shouldFallbackFromIngest(422, { detail: 'Unsupported media type' }), true);
});

test('summarizeBatchResults counts accepted duplicate and failed items', () => {
  assert.deepEqual(
    summarizeBatchResults({ results: [{ status: 'accepted' }, { status: 'duplicate' }, { status: 'error' }] }),
    { accepted: 1, duplicate: 1, failed: 1 },
  );
});

test('rebaseCobaltAssetUrl replaces private IP origin with configured cobalt hostname', () => {
  assert.equal(
    rebaseCobaltAssetUrl(
      'http://192.168.178.102:9000/tunnel?id=abc&sig=xyz',
      'http://cobalt.home.arpa/',
    ),
    'http://cobalt.home.arpa/tunnel?id=abc&sig=xyz',
  );
});

test('rebaseCobaltAssetUrl leaves public CDN redirect URLs unchanged', () => {
  const cdnUrl = 'https://video.twimg.com/ext_tw_video/123/pu/vid/clip.mp4';
  assert.equal(rebaseCobaltAssetUrl(cdnUrl, 'http://cobalt.home.arpa/'), cdnUrl);
});

test('rebaseCobaltAssetUrl is a no-op when origins already match', () => {
  const url = 'http://cobalt.home.arpa/tunnel?id=abc';
  assert.equal(rebaseCobaltAssetUrl(url, 'http://cobalt.home.arpa/'), url);
});
