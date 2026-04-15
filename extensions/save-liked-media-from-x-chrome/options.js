import {
  buildApiUrl,
  createAuthHeaders,
  DEFAULT_COBALT_BASE_URL,
  normalizeBaseUrl,
  normalizeOptionalBaseUrl,
  originPatternFromUrl,
} from './helpers.js';

const form = document.querySelector('#options-form');
const baseUrlInput = document.querySelector('#base-url');
const apiKeyInput = document.querySelector('#api-key');
const cobaltBaseUrlInput = document.querySelector('#cobalt-base-url');
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
  const stored = await chrome.storage.sync.get(['baseUrl', 'apiKey', 'lastUser', 'validatedAt', 'cobaltBaseUrl']);
  if (stored.baseUrl) {
    baseUrlInput.value = stored.baseUrl;
  }
  if (stored.apiKey) {
    apiKeyInput.value = stored.apiKey;
  }
  cobaltBaseUrlInput.value = stored.cobaltBaseUrl || DEFAULT_COBALT_BASE_URL;
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
    const cobaltBaseUrl = normalizeOptionalBaseUrl(cobaltBaseUrlInput.value, DEFAULT_COBALT_BASE_URL);
    if (!apiKey) {
      throw new Error('Enter your Zukan API key.');
    }

    const permissions = [originPatternFromUrl(baseUrl), originPatternFromUrl(cobaltBaseUrl)];
    const granted = await chrome.permissions.request({ origins: permissions });
    if (!granted) {
      throw new Error('Permission to access your Zukan server and Cobalt host is required before the extension can save media.');
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
      cobaltBaseUrl,
      lastUser: payload.username,
      validatedAt,
    });

    setStatus('Saved and validated. Like tweets on X to save media automatically.', 'success');
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
