import {
  buildApiUrl,
  createAuthHeaders,
  deriveFilename,
  isHttpUrl,
  isSupportedContextType,
  normalizeBaseUrl,
  originPatternFromUrl,
  shouldFallbackFromIngest,
  summarizeBatchResult,
} from './helpers.js';

const MENU_ID = 'save-to-zukan';

function apiJson(path, apiKey, init = {}, baseUrl) {
  const headers = createAuthHeaders(apiKey, init.headers);
  return fetch(buildApiUrl(baseUrl, path), {
    ...init,
    headers,
  });
}

function getConfig() {
  return chrome.storage.sync.get(['baseUrl', 'apiKey', 'lastUser', 'validatedAt']);
}

async function updateActionState() {
  const { baseUrl, apiKey } = await getConfig();
  const configured = Boolean(baseUrl && apiKey);
  await chrome.action.setBadgeBackgroundColor({ color: configured ? '#0f766e' : '#b91c1c' });
  await chrome.action.setBadgeText({ text: configured ? '' : '!' });
  await chrome.action.setTitle({
    title: configured
      ? 'Save to Zukan'
      : 'Save to Zukan setup required',
  });
}

async function ensureOriginPermission(url) {
  const origin = originPatternFromUrl(url);
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (hasPermission) {
    return true;
  }
  return chrome.permissions.request({ origins: [origin] });
}

async function showNotification(title, message) {
  await chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-128.png'),
    title,
    message,
  });
}

async function createContextMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Save to Zukan',
    contexts: ['image', 'video'],
  });
}

async function openSetup(message = null) {
  if (message) {
    await showNotification('Extension setup required', message);
  }
  await chrome.runtime.openOptionsPage();
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

async function ingestUrl({ srcUrl, apiKey, baseUrl }) {
  const response = await apiJson(
    '/api/v1/media/ingest-url',
    apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: srcUrl,
        visibility: 'private',
      }),
    },
    baseUrl,
  );
  const payload = await parseJsonResponse(response);
  return { response, payload };
}

async function fetchMediaBlob(srcUrl) {
  const response = await fetch(srcUrl, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Media download failed with ${response.status}.`);
  }
  const blob = await response.blob();
  const contentType = response.headers.get('content-type') || blob.type || '';
  const contentDisposition = response.headers.get('content-disposition') || '';
  const filename = deriveFilename(srcUrl, contentType, contentDisposition);
  return { blob, filename };
}

async function uploadBlob({ blob, filename, apiKey, baseUrl }) {
  const formData = new FormData();
  formData.append('files', blob, filename);
  formData.append('visibility', 'private');
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

async function notifyBatchResult(payload) {
  const result = summarizeBatchResult(payload);
  if (result.kind === 'saved') {
    await showNotification('Saved to Zukan', result.message);
    return;
  }
  if (result.kind === 'duplicate') {
    await showNotification('Already in Zukan', result.message);
    return;
  }
  await showNotification('Save failed', result.message);
}

async function handleSaveClick(info) {
  if (!isSupportedContextType(info.mediaType) || !isHttpUrl(info.srcUrl)) {
    await showNotification('Save failed', 'This media source is not supported by the extension.');
    return;
  }

  const { baseUrl, apiKey } = await getConfig();
  if (!baseUrl || !apiKey) {
    await updateActionState();
    await openSetup('Open the extension options and add your Zukan URL and API key.');
    return;
  }

  try {
    normalizeBaseUrl(baseUrl);
  } catch (error) {
    await updateActionState();
    await openSetup(
      error instanceof Error ? error.message : 'Enter a valid Zukan URL in the extension options.',
    );
    return;
  }

  const canReachZukan = await ensureOriginPermission(baseUrl);
  if (!canReachZukan) {
    await showNotification('Permission required', 'Allow access to your Zukan host in the extension options to save media.');
    return;
  }

  const { response: ingestResponse, payload: ingestPayload } = await ingestUrl({ srcUrl: info.srcUrl, apiKey, baseUrl });
  if (ingestResponse.ok) {
    await notifyBatchResult(ingestPayload);
    return;
  }

  if (ingestResponse.status === 401 || ingestResponse.status === 403) {
    await updateActionState();
    await showNotification('Authentication failed', 'Your API key was rejected. Update it in the extension options.');
    chrome.runtime.openOptionsPage();
    return;
  }

  if (!shouldFallbackFromIngest(ingestResponse.status, ingestPayload)) {
    const message = ingestPayload?.detail || `Zukan ingest failed with ${ingestResponse.status}.`;
    await showNotification('Save failed', message);
    return;
  }

  const canFetchSource = await ensureOriginPermission(info.srcUrl);
  if (!canFetchSource) {
    await showNotification('Source permission required', 'Allow access to this media host to retry the save as a direct upload.');
    return;
  }

  const { blob, filename } = await fetchMediaBlob(info.srcUrl);
  const { response: uploadResponse, payload: uploadPayload } = await uploadBlob({ blob, filename, apiKey, baseUrl });
  if (uploadResponse.ok) {
    await notifyBatchResult(uploadPayload);
    return;
  }

  const message = uploadPayload?.detail || `Upload failed with ${uploadResponse.status}.`;
  await showNotification('Save failed', message);
}

chrome.runtime.onInstalled.addListener(() => {
  void createContextMenu();
  void updateActionState();
});

chrome.runtime.onStartup.addListener(() => {
  void createContextMenu();
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

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }
  void handleSaveClick(info).catch(async (error) => {
    const message = error instanceof Error ? error.message : 'Unexpected error while saving media.';
    await showNotification('Save failed', message);
  });
});

void createContextMenu();
void updateActionState();
