import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMediaCandidatesFromArticle,
  extractTweetCapturedAt,
  isLikesTimelineUrl,
  normalizeTweetPermalink,
  normalizeXImageUrl,
} from './x.js';

function fakeArticle(markupBySelector) {
  return {
    querySelector(selector) {
      const value = markupBySelector[selector];
      if (!value) return null;
      return Array.isArray(value) ? value[0] : value;
    },
    querySelectorAll(selector) {
      const value = markupBySelector[selector];
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    },
  };
}

function fakeNode(attributes = {}) {
  return {
    getAttribute(name) {
      return attributes[name] ?? null;
    },
  };
}

test('isLikesTimelineUrl matches x likes pages', () => {
  assert.equal(isLikesTimelineUrl('https://x.com/starsbit/likes'), true);
  assert.equal(isLikesTimelineUrl('https://x.com/home'), false);
});

test('normalizeTweetPermalink reduces photo urls to the tweet permalink', () => {
  assert.equal(
    normalizeTweetPermalink('https://twitter.com/starsbit/status/123/photo/1'),
    'https://x.com/starsbit/status/123',
  );
});

test('normalizeXImageUrl upgrades pbs.twimg media urls to orig size', () => {
  assert.equal(
    normalizeXImageUrl('https://pbs.twimg.com/media/Abc123?format=jpg&name=small'),
    'https://pbs.twimg.com/media/Abc123?format=jpg&name=orig',
  );
});

test('extractTweetCapturedAt reads the tweet time datetime', () => {
  const article = fakeArticle({
    'time[datetime]': fakeNode({ datetime: '2024-02-03T04:05:06.000Z' }),
  });

  assert.equal(extractTweetCapturedAt(article), '2024-02-03T04:05:06.000Z');
});

test('extractMediaCandidatesFromArticle returns direct images and fallback video candidate', () => {
  const article = fakeArticle({
    'img[src]': [
      fakeNode({ src: 'https://pbs.twimg.com/media/One?format=jpg&name=small' }),
      fakeNode({ src: 'https://pbs.twimg.com/media/Two?format=png&name=small' }),
    ],
    'video[src], video source[src]': [],
    '[data-testid="videoPlayer"], video, [aria-label*="Embedded video"]': fakeNode(),
  });

  const candidates = extractMediaCandidatesFromArticle(article, 'https://x.com/demo/status/123', '2024-02-03T04:05:06.000Z');
  assert.deepEqual(candidates, [
    {
      mediaType: 'image',
      strategy: 'direct',
      url: 'https://pbs.twimg.com/media/One?format=jpg&name=orig',
      capturedAt: '2024-02-03T04:05:06.000Z',
      key: 'image:https://pbs.twimg.com/media/One?format=jpg&name=orig',
    },
    {
      mediaType: 'image',
      strategy: 'direct',
      url: 'https://pbs.twimg.com/media/Two?format=png&name=orig',
      capturedAt: '2024-02-03T04:05:06.000Z',
      key: 'image:https://pbs.twimg.com/media/Two?format=png&name=orig',
    },
    {
      mediaType: 'video',
      strategy: 'cobalt',
      tweetUrl: 'https://x.com/demo/status/123',
      capturedAt: '2024-02-03T04:05:06.000Z',
      key: 'cobalt:https://x.com/demo/status/123',
    },
  ]);
});

test('extractMediaCandidatesFromArticle prefers direct video urls when present', () => {
  const article = fakeArticle({
    'img[src]': [],
    'video[src], video source[src]': [
      fakeNode({ src: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/clip.mp4' }),
    ],
    '[data-testid="videoPlayer"], video, [aria-label*="Embedded video"]': fakeNode(),
  });

  const candidates = extractMediaCandidatesFromArticle(article, 'https://x.com/demo/status/999');
  assert.equal(candidates[0].strategy, 'direct');
  assert.equal(candidates[0].url, 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/clip.mp4');
});
