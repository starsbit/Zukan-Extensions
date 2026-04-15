function toAbsoluteUrl(value, origin = 'https://x.com') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  try {
    return new URL(value, origin).toString();
  } catch {
    return null;
  }
}

export function isLikesTimelineUrl(value) {
  return /https:\/\/(?:x|twitter)\.com\/[^/]+\/likes(?:\/)?(?:[?#].*)?$/i.test(value || '');
}

export function normalizeTweetPermalink(value) {
  const absolute = toAbsoluteUrl(value);
  if (!absolute) return null;

  try {
    const url = new URL(absolute);
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
    if (!match) return null;
    return `https://x.com/${match[1]}/status/${match[2]}`;
  } catch {
    return null;
  }
}

export function normalizeXImageUrl(value) {
  const absolute = toAbsoluteUrl(value);
  if (!absolute) return null;

  try {
    const url = new URL(absolute);
    if (!/pbs\.twimg\.com$/i.test(url.hostname) || !/\/media\//i.test(url.pathname)) {
      return null;
    }
    const format = url.searchParams.get('format');
    url.search = '';
    if (format) {
      url.searchParams.set('format', format);
    }
    url.searchParams.set('name', 'orig');
    return url.toString();
  } catch {
    return null;
  }
}

function directVideoUrl(value) {
  const absolute = toAbsoluteUrl(value);
  if (!absolute) return null;
  try {
    const url = new URL(absolute);
    if (!/https?:/.test(url.protocol)) return null;
    if (!/video\.twimg\.com$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function uniqueBy(items, keyFn) {
  const output = [];
  const seen = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function findTweetAnchorCandidates(article) {
  return Array.from(article.querySelectorAll('a[href*="/status/"]'));
}

export function extractTweetPermalinkFromArticle(article) {
  const anchors = findTweetAnchorCandidates(article);
  for (const anchor of anchors) {
    const permalink = normalizeTweetPermalink(anchor.getAttribute('href'));
    if (permalink) {
      return permalink;
    }
  }
  return null;
}

export function extractTweetCapturedAt(article) {
  const timeElement = article.querySelector('time[datetime]');
  const value = timeElement?.getAttribute('datetime');
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toISOString();
}

export function extractMediaCandidatesFromArticle(article, tweetUrl, capturedAt = null) {
  const imageCandidates = Array.from(article.querySelectorAll('img[src]'))
    .map((image) => normalizeXImageUrl(image.getAttribute('src')))
    .filter(Boolean)
    .map((url) => ({
      mediaType: 'image',
      strategy: 'direct',
      url,
      capturedAt,
      key: `image:${url}`,
    }));

  const directVideoCandidates = Array.from(article.querySelectorAll('video[src], video source[src]'))
    .map((node) => directVideoUrl(node.getAttribute('src')))
    .filter(Boolean)
    .map((url) => ({
      mediaType: 'video',
      strategy: 'direct',
      url,
      capturedAt,
      key: `video:${url}`,
    }));

  const hasVideoShell = Boolean(
    article.querySelector('[data-testid="videoPlayer"], video, [aria-label*="Embedded video"]'),
  );
  const fallbackCandidate = hasVideoShell && tweetUrl
    ? [{
        mediaType: 'video',
        strategy: 'cobalt',
        tweetUrl,
        capturedAt,
        key: `cobalt:${tweetUrl}`,
      }]
    : [];

  return uniqueBy(
    [...imageCandidates, ...directVideoCandidates, ...fallbackCandidate],
    (candidate) => candidate.key,
  );
}

export function isLikedArticle(article) {
  return Boolean(article.querySelector('[data-testid="unlike"]'));
}

export function getLikedTweetArticles(root = document) {
  return uniqueBy(
    Array.from(root.querySelectorAll('article')).filter((article) => {
      return isLikedArticle(article) && extractTweetPermalinkFromArticle(article);
    }),
    (article) => extractTweetPermalinkFromArticle(article),
  );
}

export function createXContentController({
  runtime = chrome.runtime,
  windowObject = window,
  documentObject = document,
  delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
} = {}) {
  const autoSavedTweets = new Set();
  const manuallyProcessedTweets = new Set();
  let manualScanRunning = false;
  let syncSurface = null;
  let syncButton = null;
  let syncStatus = null;
  let snoozeInput = null;
  let lastStatusMessage = '';
  let duplicateSnoozeRemaining = 0;

  function debugLog(message, details = null) {
    const timestamp = new Date().toISOString();
    if (details === null || details === undefined) {
      console.log(`[Zukan X Sync][content][${timestamp}] ${message}`);
      return;
    }
    console.log(`[Zukan X Sync][content][${timestamp}] ${message}`, details);
  }

  function withTimeout(promise, ms, label) {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = windowObject.setTimeout(() => {
        reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`));
      }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer !== null) {
        windowObject.clearTimeout(timer);
      }
    });
  }

  function isLikesTimelineActive() {
    return isLikesTimelineUrl(windowObject.location?.href || '');
  }

  function setStatus(message, tone = 'neutral') {
    lastStatusMessage = message;
    if (!syncStatus) {
      return;
    }
    syncStatus.textContent = message;
    syncStatus.dataset.tone = tone;
    syncStatus.style.color = ({
      neutral: 'rgb(113, 118, 123)',
      info: 'rgb(29, 155, 240)',
      success: 'rgb(0, 186, 124)',
      warning: 'rgb(255, 212, 0)',
      error: 'rgb(244, 33, 46)',
    })[tone] || 'rgb(113, 118, 123)';
  }

  function updateSyncButtonState() {
    if (!syncButton || !syncSurface || !snoozeInput) {
      return;
    }
    const active = isLikesTimelineActive();
    syncSurface.hidden = !active;
    syncButton.disabled = manualScanRunning;
    snoozeInput.disabled = manualScanRunning;
    syncButton.textContent = manualScanRunning ? 'Syncing likes...' : 'Sync Likes';

    if (!active) {
      setStatus('', 'neutral');
      return;
    }

    if (manualScanRunning) {
      if (!lastStatusMessage) {
        setStatus('Scanning visible liked tweets and auto-scrolling for more...', 'info');
      }
      return;
    }

    setStatus(
      duplicateSnoozeRemaining > 0
        ? `Scan your Likes timeline. ${duplicateSnoozeRemaining} duplicate prompt${duplicateSnoozeRemaining === 1 ? '' : 's'} currently snoozed.`
        : 'Scan your Likes timeline and keep going when duplicates appear.',
      'neutral',
    );
  }

  function findSurfaceMountPoint() {
    return (
      documentObject.querySelector('[data-testid="primaryColumn"] section') ||
      documentObject.querySelector('[data-testid="primaryColumn"]') ||
      documentObject.querySelector('main')
    );
  }

  function ensureSyncSurface() {
    const mountPoint = findSurfaceMountPoint();
    if (!mountPoint) {
      return null;
    }

    if (syncSurface?.isConnected) {
      if (!mountPoint.contains(syncSurface)) {
        mountPoint.prepend(syncSurface);
      }
      updateSyncButtonState();
      return syncSurface;
    }

    syncSurface = documentObject.createElement('section');
    syncSurface.dataset.zukanSyncSurface = 'true';
    Object.assign(syncSurface.style, {
      margin: '12px 16px',
      padding: '12px 16px',
      border: '1px solid rgb(47, 51, 54)',
      borderRadius: '16px',
      background: 'rgba(15, 20, 25, 0.96)',
      color: 'rgb(231, 233, 234)',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
    });

    const title = documentObject.createElement('div');
    title.textContent = 'Zukan Likes Sync';
    Object.assign(title.style, {
      fontSize: '15px',
      fontWeight: '700',
      lineHeight: '20px',
      marginBottom: '4px',
    });

    const description = documentObject.createElement('p');
    description.textContent = 'Import older liked tweets from this timeline into Zukan.';
    Object.assign(description.style, {
      margin: '0 0 12px',
      color: 'rgb(113, 118, 123)',
      fontSize: '13px',
      lineHeight: '18px',
    });

    const actions = documentObject.createElement('div');
    Object.assign(actions.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      flexWrap: 'wrap',
    });

    syncButton = documentObject.createElement('button');
    syncButton.type = 'button';
    syncButton.dataset.zukanSyncButton = 'true';
    Object.assign(syncButton.style, {
      padding: '0 16px',
      minHeight: '36px',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: '999px',
      background: 'rgb(29, 155, 240)',
      color: 'rgb(255, 255, 255)',
      font: '700 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      cursor: 'pointer',
    });
    syncButton.addEventListener('click', () => {
      void runManualScan();
    });

    syncStatus = documentObject.createElement('span');
    syncStatus.dataset.zukanSyncStatus = 'true';
    Object.assign(syncStatus.style, {
      fontSize: '13px',
      lineHeight: '18px',
      color: 'rgb(113, 118, 123)',
    });

    const snoozeLabel = documentObject.createElement('label');
    Object.assign(snoozeLabel.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      color: 'rgb(113, 118, 123)',
      fontSize: '13px',
      lineHeight: '18px',
    });

    const snoozeText = documentObject.createElement('span');
    snoozeText.textContent = 'Snooze duplicate prompts for';

    snoozeInput = documentObject.createElement('input');
    snoozeInput.type = 'number';
    snoozeInput.min = '0';
    snoozeInput.step = '1';
    snoozeInput.value = '0';
    snoozeInput.inputMode = 'numeric';
    snoozeInput.setAttribute('aria-label', 'Snooze duplicate prompts');
    Object.assign(snoozeInput.style, {
      width: '72px',
      minHeight: '36px',
      padding: '0 10px',
      borderRadius: '10px',
      border: '1px solid rgb(47, 51, 54)',
      background: 'rgb(0, 0, 0)',
      color: 'rgb(231, 233, 234)',
      font: '600 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });
    snoozeInput.addEventListener('change', () => {
      const value = Number.parseInt(snoozeInput.value, 10);
      duplicateSnoozeRemaining = Number.isFinite(value) && value > 0 ? value : 0;
      snoozeInput.value = String(duplicateSnoozeRemaining);
      debugLog('Updated duplicate prompt snooze', { duplicateSnoozeRemaining });
      updateSyncButtonState();
    });

    const snoozeSuffix = documentObject.createElement('span');
    snoozeSuffix.textContent = 'duplicate(s)';

    snoozeLabel.append(snoozeText, snoozeInput, snoozeSuffix);
    actions.append(syncButton, snoozeLabel, syncStatus);
    syncSurface.append(title, description, actions);
    mountPoint.prepend(syncSurface);
    updateSyncButtonState();
    return syncSurface;
  }

  async function autoScrollForMore() {
    const articles = getLikedTweetArticles(documentObject);
    const lastArticle = articles[articles.length - 1];
    debugLog('Auto-scrolling for more tweets', {
      visibleLikedTweets: articles.length,
      targetTweet: lastArticle ? extractTweetPermalinkFromArticle(lastArticle) : null,
    });
    if (lastArticle?.scrollIntoView) {
      lastArticle.scrollIntoView({ block: 'end', behavior: 'smooth' });
    } else {
      windowObject.scrollBy({ top: Math.max(windowObject.innerHeight, 900), behavior: 'smooth' });
    }
    setStatus('Scrolling for more liked tweets...', 'info');
    await delay(1400);
    return documentObject.body?.scrollHeight ?? 0;
  }

  function summarizeManualResult(result) {
    const accepted = result?.summary?.accepted ?? 0;
    const duplicates = result?.summary?.duplicate ?? 0;
    const failed = result?.summary?.failed ?? 0;
    const parts = [];
    if (accepted > 0) parts.push(`${accepted} saved`);
    if (duplicates > 0) parts.push(`${duplicates} duplicate`);
    if (failed > 0) parts.push(`${failed} failed`);
    return parts.join(', ') || 'nothing changed';
  }

  async function saveArticle(article, mode) {
    const tweetUrl = extractTweetPermalinkFromArticle(article);
    if (!tweetUrl) {
      debugLog('Skipping article without tweet URL');
      return { skipped: true, duplicateFound: false };
    }

    if (mode === 'click') {
      if (autoSavedTweets.has(tweetUrl)) {
        debugLog('Skipping already auto-saved tweet', { tweetUrl });
        return { skipped: true, duplicateFound: false };
      }
      autoSavedTweets.add(tweetUrl);
    } else {
      if (manuallyProcessedTweets.has(tweetUrl)) {
        debugLog('Skipping already manually processed tweet', { tweetUrl });
        return { skipped: true, duplicateFound: false };
      }
      manuallyProcessedTweets.add(tweetUrl);
    }

    const capturedAt = extractTweetCapturedAt(article);
    const mediaCandidates = extractMediaCandidatesFromArticle(article, tweetUrl, capturedAt);
    if (mediaCandidates.length === 0) {
      debugLog('Skipping tweet without media candidates', { tweetUrl });
      return { skipped: true, duplicateFound: false };
    }

    debugLog('Sending save request for tweet', {
      mode,
      tweetUrl,
      capturedAt,
      mediaCandidates,
    });

    const response = await withTimeout(
      runtime.sendMessage({
        type: 'save-liked-tweet',
        payload: {
          mode,
          tweetUrl,
          capturedAt,
          mediaCandidates,
        },
      }),
      mode === 'manual' ? 35000 : 50000,
      'Save request',
    );

    debugLog('Received save response for tweet', {
      tweetUrl,
      response,
    });
    return response ?? { skipped: false, duplicateFound: false };
  }

  async function maybeHandleLikeClick(target) {
    const button = target instanceof Element ? target.closest('[data-testid="like"]') : null;
    if (!button) return;

    const article = button.closest('article');
    if (!article) return;

    await delay(350);
    if (!article.isConnected || !isLikedArticle(article)) {
      return;
    }
    debugLog('Detected like click on tweet', {
      tweetUrl: extractTweetPermalinkFromArticle(article),
    });
    await saveArticle(article, 'click');
  }

  async function runManualScan() {
    if (manualScanRunning) {
      debugLog('Manual scan already running');
      return { started: false, reason: 'already-running' };
    }

    debugLog('Starting manual likes scan', {
      duplicateSnoozeRemaining,
      location: windowObject.location?.href || '',
    });
    manualScanRunning = true;
    ensureSyncSurface();
    updateSyncButtonState();
    let idlePasses = 0;
    let lastHeight = 0;
    let processedTweets = 0;

    try {
      while (idlePasses < 4) {
        const queue = getLikedTweetArticles(documentObject).filter((article) => {
          const tweetUrl = extractTweetPermalinkFromArticle(article);
          return tweetUrl && !manuallyProcessedTweets.has(tweetUrl);
        });

        debugLog('Collected visible liked tweet queue', {
          queueLength: queue.length,
          idlePasses,
        });

        if (queue.length > 0) {
          idlePasses = 0;
          setStatus(`Found ${queue.length} liked tweet${queue.length === 1 ? '' : 's'} on screen.`, 'info');
        }

        for (const article of queue) {
          processedTweets += 1;
          setStatus(`Syncing liked tweet ${processedTweets}...`, 'info');
          let result;
          try {
            result = await saveArticle(article, 'manual');
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Tweet sync failed.';
            setStatus(`Tweet ${processedTweets} skipped: ${message}`, 'error');
            continue;
          }
          const resultSummary = summarizeManualResult(result);
          if (resultSummary) {
            setStatus(`Tweet ${processedTweets}: ${resultSummary}.`, result?.hasFailure ? 'error' : 'info');
          }
          if (result?.duplicateFound) {
            debugLog('Duplicate detected while scanning', {
              tweetIndex: processedTweets,
              duplicateSnoozeRemaining,
            });
            if (duplicateSnoozeRemaining > 0) {
              duplicateSnoozeRemaining -= 1;
              if (snoozeInput) {
                snoozeInput.value = String(duplicateSnoozeRemaining);
              }
              setStatus(`Duplicate skipped automatically. ${duplicateSnoozeRemaining} snoozed duplicate prompt${duplicateSnoozeRemaining === 1 ? '' : 's'} left.`, 'warning');
              continue;
            }

            setStatus('Duplicate detected. Decide whether to keep scanning older likes.', 'warning');
            const shouldContinue = windowObject.confirm(
              'Zukan reported a duplicate while scanning your Likes.\n\nPress OK to skip it and keep scanning older likes.\nPress Cancel to stop here.',
            );
            if (!shouldContinue) {
              debugLog('User stopped manual scan at duplicate', { tweetIndex: processedTweets });
              return { started: true, stoppedAfterDuplicate: true };
            }
            debugLog('User chose to continue after duplicate', { tweetIndex: processedTweets });
            setStatus('Duplicate skipped. Continuing to older likes...', 'info');
          }
        }

        const currentHeight = documentObject.body?.scrollHeight ?? 0;
        const nextHeight = await autoScrollForMore();
        if (queue.length === 0 && nextHeight <= currentHeight && currentHeight === lastHeight) {
          idlePasses += 1;
        } else if (queue.length === 0) {
          idlePasses += 1;
        }
        lastHeight = nextHeight;
      }

      setStatus(`Likes sync finished. Processed ${processedTweets} tweet${processedTweets === 1 ? '' : 's'}.`, 'success');
      debugLog('Finished manual likes scan', {
        processedTweets,
        duplicateSnoozeRemaining,
      });
      return { started: true, completed: true };
    } finally {
      manualScanRunning = false;
      updateSyncButtonState();
    }
  }

  function attach() {
    ensureSyncSurface();

    documentObject.addEventListener('click', (event) => {
      void maybeHandleLikeClick(event.target).catch(() => {});
    }, true);

    windowObject.addEventListener('popstate', () => {
      updateSyncButtonState();
    });

    const refreshButton = () => {
      ensureSyncSurface();
      updateSyncButtonState();
    };
    const { history } = windowObject;
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    history.pushState = (...args) => {
      const result = originalPushState(...args);
      refreshButton();
      return result;
    };
    history.replaceState = (...args) => {
      const result = originalReplaceState(...args);
      refreshButton();
      return result;
    };
    windowObject.setInterval(() => {
      ensureSyncSurface();
    }, 1500);

    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== 'start-manual-likes-scan') {
        return undefined;
      }

      void runManualScan()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({
          started: true,
          error: error instanceof Error ? error.message : 'Manual scan failed.',
        }));
      return true;
    });
  }

  return {
    attach,
    maybeHandleLikeClick,
    runManualScan,
  };
}
