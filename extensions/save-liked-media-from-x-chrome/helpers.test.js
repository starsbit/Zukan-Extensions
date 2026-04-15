import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COBALT_BASE_URL,
  createAuthHeaders,
  deriveFilename,
  normalizeOptionalBaseUrl,
  normalizeBaseUrl,
  originPatternFromUrl,
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
