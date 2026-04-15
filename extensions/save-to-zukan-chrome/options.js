import {
  buildApiUrl,
  createAuthHeaders,
  normalizeBaseUrl,
  originPatternFromUrl,
} from './helpers.js';

const form = document.querySelector('#options-form');
const baseUrlInput = document.querySelector('#base-url');
const apiKeyInput = document.querySelector('#api-key');
const statusElement = document.querySelector('#status');
const metaElement = document.querySelector('#meta');
const saveButton = document.querySelector('#save-button');

function setStatus(message, state = '') {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

function setMeta(message = '') {
  metaElement.textContent = message;
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return date.toLocaleString();
}

async function loadSavedConfig() {
  const stored = await chrome.storage.sync.get(['baseUrl', 'apiKey', 'lastUser', 'validatedAt']);
  if (stored.baseUrl) {
    baseUrlInput.value = stored.baseUrl;
  }
  if (stored.apiKey) {
    apiKeyInput.value = stored.apiKey;
  }
  if (stored.validatedAt || stored.lastUser) {
    const parts = [];
    if (stored.lastUser) {
      parts.push(`Connected as ${stored.lastUser}.`);
    }
    if (stored.validatedAt) {
      parts.push(`Validated ${formatTimestamp(stored.validatedAt)}.`);
    }
    setMeta(parts.join(' '));
  }
}

async function validateAndSave(event) {
  event.preventDefault();
  saveButton.disabled = true;
  setStatus('Validating your Zukan server...', '');
  setMeta('');

  try {
    const baseUrl = normalizeBaseUrl(baseUrlInput.value);
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      throw new Error('Enter your Zukan API key.');
    }

    const originPermission = originPatternFromUrl(baseUrl);
    const granted = await chrome.permissions.request({ origins: [originPermission] });
    if (!granted) {
      throw new Error('Permission to access your Zukan server is required before the extension can save media.');
    }

    const response = await fetch(buildApiUrl(baseUrl, '/api/v1/me'), {
      headers: createAuthHeaders(apiKey),
    });
    const payload = response.ok ? await response.json() : await response.text();
    if (!response.ok) {
      const detail = typeof payload === 'string' ? payload : payload?.detail;
      throw new Error(detail || 'The Zukan server rejected that API key.');
    }

    const validatedAt = new Date().toISOString();
    await chrome.storage.sync.set({
      baseUrl,
      apiKey,
      lastUser: payload.username,
      validatedAt,
    });

    setStatus('Saved and validated. Right-click an image or video to send it to Zukan.', 'success');
    setMeta(`Connected as ${payload.username}. Validated ${formatTimestamp(validatedAt)}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to validate the extension settings.';
    setStatus(message, 'error');
  } finally {
    saveButton.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  void validateAndSave(event);
});

void loadSavedConfig();
