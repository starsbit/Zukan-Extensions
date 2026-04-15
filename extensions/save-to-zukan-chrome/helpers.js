const MEDIA_CONTEXT_TYPES = new Set(['image', 'video']);
const EXTENSION_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
};
const FALLBACK_INGEST_STATUSES = new Set([400, 403, 404, 415, 422, 502]);

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isSupportedContextType(type) {
  return MEDIA_CONTEXT_TYPES.has(type);
}

export function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeBaseUrl(value) {
  if (!isHttpUrl(value)) {
    throw new Error('Enter a valid http:// or https:// Zukan URL.');
  }

  const url = new URL(value);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function originPatternFromUrl(value) {
  const url = new URL(value);
  return `${url.origin}/*`;
}

export function buildApiUrl(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);
  return new URL(path, `${base}/`).toString();
}

export function createAuthHeaders(apiKey, extraHeaders = {}) {
  return {
    ...extraHeaders,
    Authorization: `Bearer ${apiKey}`,
  };
}

export function shouldFallbackFromIngest(status, payload) {
  if (!FALLBACK_INGEST_STATUSES.has(status)) {
    return false;
  }

  const detail = typeof payload?.detail === 'string' ? payload.detail.toLowerCase() : '';
  if (status === 403 && detail.includes('not authenticated')) {
    return false;
  }
  if (status === 403 && detail.includes('invalid token')) {
    return false;
  }
  if (status === 422 && detail.includes('not authenticated')) {
    return false;
  }

  return true;
}

export function extensionFromContentType(contentType) {
  if (!contentType) return '';
  return EXTENSION_BY_CONTENT_TYPE[contentType.split(';', 1)[0].toLowerCase()] ?? '';
}

export function sanitizeFilename(filename) {
  const trimmed = safeDecodeURIComponent(filename).trim();
  const normalized = trimmed.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ');
  return normalized || 'zukan-media';
}

export function filenameFromContentDisposition(header) {
  if (!header) return null;
  const starMatch = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (starMatch) {
    return sanitizeFilename(starMatch[1]);
  }
  const plainMatch = header.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  const filename = plainMatch?.[1] ?? plainMatch?.[2];
  return filename ? sanitizeFilename(filename) : null;
}

export function deriveFilename(srcUrl, contentType = '', contentDisposition = '') {
  const fromHeader = filenameFromContentDisposition(contentDisposition);
  if (fromHeader) {
    return ensureFilenameExtension(fromHeader, contentType);
  }

  try {
    const url = new URL(srcUrl);
    const lastPath = url.pathname.split('/').filter(Boolean).pop();
    if (lastPath) {
      return ensureFilenameExtension(sanitizeFilename(lastPath), contentType);
    }
  } catch {
    // Ignore bad URLs here; caller validates earlier.
  }

  const extension = extensionFromContentType(contentType);
  return extension ? `zukan-media.${extension}` : 'zukan-media';
}

export function ensureFilenameExtension(filename, contentType = '') {
  if (/\.[A-Za-z0-9]{2,5}$/.test(filename)) {
    return filename;
  }
  const extension = extensionFromContentType(contentType);
  return extension ? `${filename}.${extension}` : filename;
}

export function summarizeBatchResult(payload) {
  const first = payload?.results?.[0];
  if (first?.status === 'accepted') {
    return {
      kind: 'saved',
      message: 'Saved to Zukan.',
    };
  }
  if (first?.status === 'duplicate') {
    return {
      kind: 'duplicate',
      message: 'Already in Zukan.',
    };
  }
  if (first?.status === 'error') {
    return {
      kind: 'failed',
      message: first.message || 'Zukan rejected this media.',
    };
  }
  return {
    kind: 'failed',
    message: 'Zukan returned an unexpected upload response.',
  };
}
