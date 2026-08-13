import os
import re
import logging
import sys

import httpx
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

load_dotenv()

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").strip().upper() or "INFO"
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ZUKAN_BASE_URL = os.environ["ZUKAN_BASE_URL"].rstrip("/")
ZUKAN_TOKEN = os.environ["ZUKAN_TOKEN"]
DEFAULT_VISIBILITY = os.environ.get("DEFAULT_VISIBILITY", "private").strip().lower() or "private"
ALLOWED_TELEGRAM_USER_ID = int(os.environ["ALLOWED_TELEGRAM_USER_ID"])

if DEFAULT_VISIBILITY not in {"private", "public"}:
    logger.warning("Invalid DEFAULT_VISIBILITY=%s. Falling back to private.", DEFAULT_VISIBILITY)
    DEFAULT_VISIBILITY = "private"

TWEET_RE = re.compile(
    r"https?://(?:x|twitter)\.com/([^/?\s]+)/status/(\d+)",
    re.IGNORECASE,
)
TIKTOK_LONG_RE = re.compile(
    r"https?://(?:www\.)?tiktok\.com/@([^/?\s]+)/video/(\d+)",
    re.IGNORECASE,
)
TIKTOK_SHORT_RE = re.compile(
    r"https?://(?:vm|vt|m)\.tiktok\.com/([^/?#\s]+)",
    re.IGNORECASE,
)


def normalize_tweet_url(text: str) -> str | None:
    m = TWEET_RE.search(text)
    if not m:
        return None
    return f"https://x.com/{m.group(1)}/status/{m.group(2)}"


def normalize_tiktok_url(text: str) -> str | None:
    m = TIKTOK_LONG_RE.search(text)
    if m:
        return f"https://www.tiktok.com/@{m.group(1)}/video/{m.group(2)}"
    m = TIKTOK_SHORT_RE.search(text)
    if m:
        return m.group(0)
    return None


def build_twitter_external_ref(tweet_url: str) -> dict[str, str] | None:
    normalized = normalize_tweet_url(tweet_url)
    if not normalized:
        return None
    match = TWEET_RE.search(normalized)
    if not match:
        return None
    return {
        "provider": "twitter",
        "external_id": match.group(2),
        "url": normalized,
    }


def build_tiktok_external_ref(tiktok_url: str) -> dict[str, str] | None:
    m = TIKTOK_LONG_RE.search(tiktok_url)
    if m:
        return {
            "provider": "tiktok",
            "external_id": m.group(2),
            "url": f"https://www.tiktok.com/@{m.group(1)}/video/{m.group(2)}",
        }
    m = TIKTOK_SHORT_RE.search(tiktok_url)
    if m:
        return {
            "provider": "tiktok",
            "external_id": m.group(1),
            "url": m.group(0),
        }
    return None


def _extract_result_reason(result: dict) -> str:
    for key in ("detail", "error", "reason", "message"):
        value = result.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "unknown failure"


def _response_detail(resp, payload: dict | None = None) -> str:
    if isinstance(payload, dict):
        for key in ("detail", "error", "reason", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    text = getattr(resp, "text", "") or ""
    if text.strip():
        return text.strip()[:500]
    return f"status {getattr(resp, 'status_code', 'unknown')}"


def _json_or_empty(resp) -> dict:
    try:
        payload = resp.json()
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _external_ref_matches(existing: dict, desired: dict[str, str]) -> bool:
    if existing.get("provider") != desired.get("provider"):
        return False
    desired_external_id = desired.get("external_id")
    if desired_external_id and existing.get("external_id") == desired_external_id:
        return True
    desired_url = desired.get("url")
    return bool(desired_url and existing.get("url") == desired_url)


def _merge_external_refs(existing_refs: list[dict], desired_refs: list[dict[str, str]]) -> list[dict]:
    merged = list(existing_refs)
    for desired in desired_refs:
        if not any(_external_ref_matches(existing, desired) for existing in merged):
            merged.append(desired)
    return merged


def _summarize(results: list[dict]) -> tuple[int, int, int, list[str]]:
    accepted = sum(1 for r in results if r.get("status") == "accepted")
    duplicate = sum(1 for r in results if r.get("status") == "duplicate")
    failed_results = [r for r in results if r.get("status") not in ("accepted", "duplicate")]
    failed = len(failed_results)
    failure_reasons = [_extract_result_reason(r) for r in failed_results]
    return accepted, duplicate, failed, failure_reasons


async def _apply_external_refs_to_results(
    client: httpx.AsyncClient,
    results: list[dict],
    external_refs: list[dict[str, str]],
    auth: dict[str, str],
) -> list[str]:
    failures: list[str] = []
    if not external_refs:
        return failures

    seen: set[str] = set()
    for result in results:
        media_id = result.get("id")
        if result.get("status") not in {"accepted", "duplicate"}:
            continue
        if not media_id:
            failures.append("Zukan did not return a media id for external ref update")
            logger.warning("Cannot apply Twitter external refs because upload result has no id: %s", result)
            continue
        if media_id in seen:
            continue
        seen.add(media_id)
        try:
            patch_refs = external_refs
            try:
                verify_resp = await client.get(
                    f"{ZUKAN_BASE_URL}/api/v1/media/{media_id}",
                    headers=auth,
                    timeout=30.0,
                )
                if 200 <= verify_resp.status_code < 300:
                    media_detail = _json_or_empty(verify_resp)
                    existing_refs = media_detail.get("external_refs", [])
                    if not isinstance(existing_refs, list):
                        existing_refs = []
                    has_all_refs = all(
                        any(_external_ref_matches(existing, desired) for existing in existing_refs)
                        for desired in external_refs
                    )
                    if has_all_refs:
                        logger.info("Verified Twitter external refs on media_id=%s", media_id)
                        continue
                    patch_refs = _merge_external_refs(existing_refs, external_refs)
                else:
                    logger.warning(
                        "Could not verify Twitter external refs before patch media_id=%s status=%s detail=%s",
                        media_id,
                        verify_resp.status_code,
                        _response_detail(verify_resp, _json_or_empty(verify_resp)),
                    )
            except Exception:
                logger.exception(
                    "Could not verify Twitter external refs before patch media_id=%s; attempting patch",
                    media_id,
                )

            resp = await client.patch(
                f"{ZUKAN_BASE_URL}/api/v1/media/{media_id}",
                json={"external_refs": patch_refs},
                headers={**auth, "Content-Type": "application/json"},
                timeout=30.0,
            )
            if not (200 <= resp.status_code < 300):
                detail = _response_detail(resp, _json_or_empty(resp))
                failures.append(f"Twitter ref update failed for {media_id}: {detail}")
                logger.warning(
                    "Failed to apply Twitter external refs to media_id=%s status=%s detail=%s",
                    media_id,
                    resp.status_code,
                    detail,
                )
            else:
                logger.info("Applied Twitter external refs to media_id=%s", media_id)
        except Exception as exc:
            failures.append(f"Twitter ref update failed for {media_id}: {exc}")
            logger.exception("Failed to apply Twitter external refs to media_id=%s", media_id)
    return failures


async def ingest_media(
    client: httpx.AsyncClient,
    media_url: str,
    external_refs: list[dict[str, str]] | None = None,
) -> tuple[int, int, int, list[str]]:
    auth = {"Authorization": f"Bearer {ZUKAN_TOKEN}"}
    external_refs = external_refs or []
    ingest_payload = {"url": media_url, "visibility": DEFAULT_VISIBILITY, "captured_at": None}
    if external_refs:
        ingest_payload["external_refs"] = external_refs

    ingest_resp = await client.post(
        f"{ZUKAN_BASE_URL}/api/v1/media/ingest-url",
        json=ingest_payload,
        headers={**auth, "Content-Type": "application/json"},
        timeout=60.0,
    )
    ingest_result = _json_or_empty(ingest_resp)
    logger.info(
        "Zukan ingest-url response status=%s external_ref_count=%s",
        ingest_resp.status_code,
        len(external_refs),
    )

    if ingest_resp.status_code != 202:
        detail = _response_detail(ingest_resp, ingest_result)
        raise ValueError(f"Zukan ingest failed: {detail}")

    results = ingest_result.get("results", [])
    accepted, duplicate, failed, failure_reasons = _summarize(results)
    ref_failures = await _apply_external_refs_to_results(client, results, external_refs, auth)
    failure_reasons.extend(ref_failures)
    return accepted, duplicate, failed + len(ref_failures), failure_reasons


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_authorized(update):
        return

    text = update.message.text or ""
    tweet_url = normalize_tweet_url(text)
    tiktok_url = normalize_tiktok_url(text)

    if not tweet_url and not tiktok_url:
        await update.message.reply_text(
            "Send me a Twitter/X or TikTok URL and I'll save the media to Zukan."
        )
        return

    await update.message.reply_text("Fetching media\u2026")

    try:
        async with httpx.AsyncClient() as client:
            if tweet_url:
                media_url = tweet_url
                external_ref = build_twitter_external_ref(tweet_url)
            else:
                media_url = tiktok_url
                external_ref = build_tiktok_external_ref(tiktok_url)

            external_refs = [external_ref] if external_ref else []
            accepted, duplicate, failed, failure_reasons = await ingest_media(client, media_url, external_refs)

            parts = []
            if accepted:
                parts.append(f"{accepted} saved")
            if duplicate:
                parts.append(f"{duplicate} duplicate")
            if failed:
                parts.append(f"{failed} failed")
            if failure_reasons:
                first_reason = failure_reasons[0]
                if len(first_reason) > 180:
                    first_reason = first_reason[:177] + "..."
                parts.append(f"reason: {first_reason}")

            await update.message.reply_text(", ".join(parts) if parts else "No media found.")

    except Exception as exc:
        await update.message.reply_text(f"Error: {exc}")


def _is_authorized(update: Update) -> bool:
    user = update.effective_user
    return bool(user and user.id == ALLOWED_TELEGRAM_USER_ID)


async def is_zukan_reachable(client: httpx.AsyncClient) -> tuple[bool, str]:
    try:
        resp = await client.get(
            f"{ZUKAN_BASE_URL}/api/v1/config/setup-required",
            timeout=8.0,
        )
        return resp.is_success, f"status={resp.status_code}"
    except httpx.RequestError as exc:
        return False, str(exc)


async def health(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_authorized(update):
        return

    async with httpx.AsyncClient() as client:
        reachable, detail = await is_zukan_reachable(client)

    if reachable:
        await update.message.reply_text("ok")
    else:
        await update.message.reply_text(f"unhealthy: zukan unreachable ({detail})")


def main() -> None:
    logger.info(
        "Starting Zukan Telegram bot zukan_base_url=%s default_visibility=%s",
        ZUKAN_BASE_URL,
        DEFAULT_VISIBILITY,
    )
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("health", health))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.run_polling()


if __name__ == "__main__":
    main()
