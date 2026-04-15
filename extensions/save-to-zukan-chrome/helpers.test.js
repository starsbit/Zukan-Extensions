import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveFilename,
  normalizeBaseUrl,
  originPatternFromUrl,
  shouldFallbackFromIngest,
  summarizeBatchResult,
} from './helpers.js';

test('normalizeBaseUrl trims path/query/hash noise', () => {
  assert.equal(
    normalizeBaseUrl('https://example.com/zukan/?foo=bar#frag'),
    'https://example.com/zukan',
  );
});

test('originPatternFromUrl converts a server URL into a Chrome origin pattern', () => {
  assert.equal(originPatternFromUrl('https://example.com/zukan'), 'https://example.com/*');
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

test('deriveFilename falls back to the final URL path segment', () => {
  assert.equal(
    deriveFilename('https://cdn.example.com/media/sailor-moon.gif?size=large', 'image/gif'),
    'sailor-moon.gif',
  );
});

test('shouldFallbackFromIngest allows recoverable ingest failures', () => {
  assert.equal(shouldFallbackFromIngest(502, { detail: 'Remote fetch failed' }), true);
  assert.equal(shouldFallbackFromIngest(422, { detail: 'Unsupported media type' }), true);
});

test('shouldFallbackFromIngest does not retry authentication problems', () => {
  assert.equal(shouldFallbackFromIngest(403, { detail: 'Invalid token' }), false);
});

test('summarizeBatchResult maps accepted and duplicate batch results', () => {
  assert.deepEqual(
    summarizeBatchResult({ results: [{ status: 'accepted' }] }),
    { kind: 'saved', message: 'Saved to Zukan.' },
  );
  assert.deepEqual(
    summarizeBatchResult({ results: [{ status: 'duplicate' }] }),
    { kind: 'duplicate', message: 'Already in Zukan.' },
  );
});
