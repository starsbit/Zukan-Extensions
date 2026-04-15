import {
  buildApiUrl,
  createAuthHeaders,
  DEFAULT_COBALT_BASE_URL,
  deriveFilename,
  normalizeBaseUrl,
  normalizeOptionalBaseUrl,
  originPatternFromUrl,
} from './helpers.js';
import { isLikesTimelineUrl } from './x.js';
import { saveTweetMedia } from './background-core.js';

const NETWORK_TIMEOUT_MS = 30000;

function debugLog(message, details = null) {
  const timestamp = new Date().toISOString();
  if (details === null || details === undefined) {
    console.log(`[Zukan X Sync][background][${timestamp}] ${message}`);
    return;
  }
  console.log(`[Zukan X Sync][background][${timestamp}] ${message}`, details);
}

async function fetchWithTimeout(input, init = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
  debugLog('Fetching resource', {
    input: typeof input === 'string' ? input : String(input),
    method: init.method || 'GET',
    timeoutMs,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    debugLog('Fetch completed', {
      input: typeof input === 'string' ? input : String(input),
      status: response.status,
      ok: response.ok,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      debugLog('Fetch timed out', { input: typeof input === 'string' ? input : String(input), timeoutMs });
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    debugLog('Fetch failed', {
      input: typeof input === 'string' ? input : String(input),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson(path, apiKey, init = {}, baseUrl) {
  const headers = createAuthHeaders(apiKey, init.headers);
  return fetchWithTimeout(buildApiUrl(baseUrl, path), {
    ...init,
    headers,
  });
}

function getConfig() {
  return chrome.storage.sync.get(['baseUrl', 'apiKey', 'lastUser', 'validatedAt', 'cobaltBaseUrl']);
}

async function updateActionState() {
  const { baseUrl, apiKey } = await getConfig();
  const configured = Boolean(baseUrl && apiKey);
  await chrome.action.setBadgeBackgroundColor({ color: configured ? '#0f766e' : '#b91c1c' });
  await chrome.action.setBadgeText({ text: configured ? '' : '!' });
  await chrome.action.setTitle({
    title: configured
      ? 'Save liked media from X to Zukan'
      : 'X Likes to Zukan setup required',
  });
}

async function ensureOriginPermission(url) {
  const origin = originPatternFromUrl(url);
  debugLog('Checking origin permission', { origin });
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (hasPermission) {
    debugLog('Origin permission already granted', { origin });
    return true;
  }
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    debugLog('Origin permission denied', { origin });
    throw new Error(`Permission required for ${origin}.`);
  }
  debugLog('Origin permission granted', { origin });
  return true;
}

async function showNotification(title, message) {
  await chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-128.png'),
    title,
    message,
  });
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

async function ingestUrl({ srcUrl, apiKey, baseUrl, capturedAt = null }) {
  debugLog('Attempting ingest-url save', { srcUrl, baseUrl, capturedAt });
  const response = await apiJson(
    '/api/v1/media/ingest-url',
    apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: srcUrl,
        captured_at: capturedAt,
        visibility: 'private',
      }),
    },
    baseUrl,
  );
  const payload = await parseJsonResponse(response);
  return { response, payload };
}

async function fetchMediaBlob(srcUrl, preferredFilename = null) {
  debugLog('Downloading media blob', { srcUrl, preferredFilename });
  const response = await fetchWithTimeout(srcUrl, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Media download failed with ${response.status}.`);
  }
  const blob = await response.blob();
  const contentType = response.headers.get('content-type') || blob.type || '';
  const contentDisposition = response.headers.get('content-disposition') || '';
  const filename = preferredFilename || deriveFilename(srcUrl, contentType, contentDisposition);
  debugLog('Downloaded media blob', { srcUrl, filename, contentType, size: blob.size });
  return { blob, filename };
}

async function uploadBlob({ blob, filename, apiKey, baseUrl, capturedAt = null }) {
  debugLog('Uploading blob to Zukan', {
    filename,
    baseUrl,
    size: blob.size,
    type: blob.type || null,
    capturedAt,
  });
  const formData = new FormData();
  formData.append('files', blob, filename);
  formData.append('visibility', 'private');
  if (capturedAt) {
    formData.append('captured_at', capturedAt);
  }
  const response = await apiJson(
    '/api/v1/media',
    apiKey,
    {
      method: 'POST',
      body: formData,
    },
    baseUrl,
  );
  const payload = await parseJsonResponse(response);
  return { response, payload };
}

async function resolveCobaltTweet(tweetUrl, cobaltBaseUrl) {
  debugLog('Resolving tweet via Cobalt', { tweetUrl, cobaltBaseUrl });
  const response = await fetchWithTimeout(normalizeOptionalBaseUrl(cobaltBaseUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: tweetUrl,
      downloadMode: 'auto',
      filenameStyle: 'basic',
    }),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { status: 'error', error: { code: text || `http_${response.status}` } };
  }
  if (!response.ok) {
    const code = payload?.error?.code || `http_${response.status}`;
    debugLog('Cobalt returned error', { tweetUrl, code, status: response.status });
    throw new Error(`Cobalt error: ${code}.`);
  }
  debugLog('Cobalt resolved tweet', { tweetUrl, status: payload?.status ?? null });
  return payload;
}

async function withValidatedConfig() {
  const { baseUrl, apiKey, cobaltBaseUrl } = await getConfig();
  if (!baseUrl || !apiKey) {
    await updateActionState();
    throw new Error('Open the extension options and add your Zukan URL and API key.');
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey: apiKey.trim(),
    cobaltBaseUrl: normalizeOptionalBaseUrl(cobaltBaseUrl || DEFAULT_COBALT_BASE_URL),
  };
}

async function handleSaveLikedTweet(payload) {
  debugLog('Handling liked tweet save request', payload);
  const config = await withValidatedConfig();
  await ensureOriginPermission(config.baseUrl);

  const result = await saveTweetMedia({
    ingestUrl,
    uploadBlob,
    fetchMediaBlob,
    ensureOriginPermission,
    resolveCobaltTweet,
  }, config, payload);

  if (result.hasFailure && result.failureMessage) {
    await showNotification('Save failed', result.failureMessage);
  }

  debugLog('Finished liked tweet save request', result);
  return result;
}

async function handleActionClick(tab) {
  const { baseUrl, apiKey } = await getConfig();
  if (!baseUrl || !apiKey) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  if (tab?.id && tab.url && isLikesTimelineUrl(tab.url)) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'start-manual-likes-scan' });
      if (result?.error) {
        await showNotification('Likes scan failed', result.error);
      }
      return;
    } catch {
      await showNotification('Likes scan failed', 'Open your X Likes tab and try again.');
      return;
    }
  }
  await chrome.runtime.openOptionsPage();
}

chrome.runtime.onInstalled.addListener(() => {
  void updateActionState();
});

chrome.runtime.onStartup.addListener(() => {
  void updateActionState();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') {
    return;
  }
  if (changes.baseUrl || changes.apiKey) {
    void updateActionState();
  }
});

chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'save-liked-tweet') {
    return undefined;
  }

  void handleSaveLikedTweet(message.payload)
    .then((result) => sendResponse(result))
    .catch(async (error) => {
      const messageText = error instanceof Error ? error.message : 'Unexpected error while saving liked media.';
      await showNotification('Save failed', messageText);
      sendResponse({
        duplicateFound: false,
        hasFailure: true,
        failureMessage: messageText,
        summary: { accepted: 0, duplicate: 0, failed: 1 },
      });
    });

  return true;
});

void updateActionState();
