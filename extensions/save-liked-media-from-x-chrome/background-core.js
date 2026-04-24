import {
  describeCobaltError,
  isHttpUrl,
  rebaseCobaltAssetUrl,
  shouldFallbackFromIngest,
  summarizeBatchResult,
  summarizeBatchResults,
} from './helpers.js';

function parseApiError(payload, fallback) {
  if (typeof payload?.detail === 'string' && payload.detail.trim()) {
    return payload.detail;
  }
  return fallback;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export function resolveCobaltAssets(payload) {
  if (payload?.status === 'redirect' || payload?.status === 'tunnel') {
    return [{ url: payload.url, filename: payload.filename ?? null }];
  }
  if (payload?.status === 'picker' && Array.isArray(payload.picker)) {
    return payload.picker
      .filter((item) => isHttpUrl(item?.url))
      .map((item) => ({
        url: item.url,
        filename: item.filename ?? null,
      }));
  }
  throw new Error(describeCobaltError(payload));
}

async function saveResolvedRemoteUrl(deps, candidate, config, externalRefs = []) {
  const { response: ingestResponse, payload: ingestPayload } = await deps.ingestUrl({
    srcUrl: candidate.url,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    capturedAt: candidate.capturedAt ?? null,
    visibility: config.mediaVisibility,
    externalRefs,
  });

  if (ingestResponse.ok) {
    return summarizeBatchResults(ingestPayload);
  }

  if (!shouldFallbackFromIngest(ingestResponse.status, ingestPayload)) {
    throw new Error(parseApiError(ingestPayload, `Zukan ingest failed with ${ingestResponse.status}.`));
  }

  await deps.ensureOriginPermission(candidate.url);
  const { blob, filename } = await deps.fetchMediaBlob(candidate.url, candidate.filename ?? null);
  const { response: uploadResponse, payload: uploadPayload } = await deps.uploadBlob({
    blob,
    filename,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    capturedAt: candidate.capturedAt ?? null,
    visibility: config.mediaVisibility,
    externalRefs,
  });

  if (!uploadResponse.ok) {
    throw new Error(parseApiError(uploadPayload, `Upload failed with ${uploadResponse.status}.`));
  }

  return summarizeBatchResults(uploadPayload);
}

async function saveViaCobalt(deps, candidate, config, externalRefs = []) {
  await deps.ensureOriginPermission(config.cobaltBaseUrl);
  const cobaltPayload = await deps.resolveCobaltTweet(candidate.tweetUrl, config.cobaltBaseUrl);
  const assets = resolveCobaltAssets(cobaltPayload);
  const summary = { accepted: 0, duplicate: 0, failed: 0 };

  for (const asset of assets) {
    const assetUrl = rebaseCobaltAssetUrl(asset.url, config.cobaltBaseUrl);
    const itemSummary = await saveResolvedRemoteUrl(deps, {
      url: assetUrl,
      filename: asset.filename ?? null,
      capturedAt: candidate.capturedAt ?? null,
    }, config, externalRefs);
    summary.accepted += itemSummary.accepted;
    summary.duplicate += itemSummary.duplicate;
    summary.failed += itemSummary.failed;
  }

  return summary;
}

function sortMediaCandidates(candidates = []) {
  return [...candidates].sort((left, right) => {
    const leftPriority = left?.mediaType === 'video' && left?.strategy === 'cobalt' ? 0 : 1;
    const rightPriority = right?.mediaType === 'video' && right?.strategy === 'cobalt' ? 0 : 1;
    return leftPriority - rightPriority;
  });
}

export async function saveTweetMedia(deps, config, request) {
  const aggregate = { accepted: 0, duplicate: 0, failed: 0 };
  const failures = [];
  const candidateTimeoutMs = request.mode === 'manual' ? 30000 : 45000;
  const externalRefs = Array.isArray(request.externalRefs) ? request.externalRefs : [];
  let videoHandledByCobalt = false;
  const hasCobaltGifCandidate = request.mediaCandidates?.some(
    (candidate) => candidate?.mediaType === 'gif' && candidate?.strategy === 'cobalt',
  );

  for (const candidate of sortMediaCandidates(request.mediaCandidates)) {
    if (hasCobaltGifCandidate && candidate.mediaType === 'gif' && candidate.strategy === 'direct') {
      continue;
    }
    if (videoHandledByCobalt && candidate.mediaType === 'video' && candidate.strategy === 'direct') {
      continue;
    }

    try {
      const result = await withTimeout(
        candidate.strategy === 'cobalt'
          ? saveViaCobalt(deps, candidate, config, externalRefs)
          : saveResolvedRemoteUrl(deps, candidate, config, externalRefs),
        candidateTimeoutMs,
        candidate.mediaType === 'video' ? 'Video save' : 'Media save',
      );
      aggregate.accepted += result.accepted;
      aggregate.duplicate += result.duplicate;
      aggregate.failed += result.failed;
      if (candidate.mediaType === 'video' && candidate.strategy === 'cobalt' && (result.accepted > 0 || result.duplicate > 0)) {
        videoHandledByCobalt = true;
      }
    } catch (error) {
      aggregate.failed += 1;
      failures.push(error instanceof Error ? error.message : 'Unexpected media save failure.');
    }
  }

  const firstFailure = failures[0] ?? null;
  return {
    duplicateFound: aggregate.duplicate > 0,
    hasFailure: aggregate.failed > 0,
    failureMessage: firstFailure,
    summary: aggregate,
  };
}

export function summarizeSingleUpload(payload) {
  return summarizeBatchResult(payload);
}
