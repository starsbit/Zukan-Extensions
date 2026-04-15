import os
import re
from urllib.parse import urlparse, unquote

import httpx
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

load_dotenv()

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ZUKAN_BASE_URL = os.environ["ZUKAN_BASE_URL"].rstrip("/")
ZUKAN_TOKEN = os.environ["ZUKAN_TOKEN"]
COBALT_BASE_URL = os.environ.get("COBALT_BASE_URL", "https://api.cobalt.tools").rstrip("/")
DEFAULT_VISIBILITY = os.environ.get("DEFAULT_VISIBILITY", "private")
ALLOWED_TELEGRAM_USER_ID = int(os.environ["ALLOWED_TELEGRAM_USER_ID"])

TWEET_RE = re.compile(
    r"https?://(?:x|twitter)\.com/([^/?\s]+)/status/(\d+)",
    re.IGNORECASE,
)

CONTENT_TYPE_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
}

INGEST_FALLBACK_STATUSES = {400, 403, 404, 415, 422, 502}


def normalize_tweet_url(text: str) -> str | None:
    m = TWEET_RE.search(text)
    if not m:
        return None
    return f"https://x.com/{m.group(1)}/status/{m.group(2)}"


def _ext_from_content_type(content_type: str) -> str:
    base = content_type.split(";", 1)[0].strip().lower()
    return CONTENT_TYPE_EXT.get(base, "")


def _filename_from_disposition(header: str | None) -> str | None:
    if not header:
        return None
    m = re.search(r"filename\*\s*=\s*UTF-8''([^;]+)", header, re.IGNORECASE)
    if m:
        return unquote(m.group(1)).strip()
    m = re.search(r'filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)', header, re.IGNORECASE)
    raw = m.group(1) or m.group(2) if m else None
    return raw.strip() if raw else None


def _ensure_ext(filename: str, content_type: str = "") -> str:
    if re.search(r"\.[A-Za-z0-9]{2,5}$", filename):
        return filename
    ext = _ext_from_content_type(content_type)
    return f"{filename}.{ext}" if ext else filename


def derive_filename(
    url: str,
    content_type: str = "",
    content_disposition: str = "",
) -> str:
    from_header = _filename_from_disposition(content_disposition)
    if from_header:
        return _ensure_ext(from_header, content_type)
    try:
        path = urlparse(url).path
        last = [p for p in path.split("/") if p][-1]
        if last:
            return _ensure_ext(unquote(last), content_type)
    except Exception:
        pass
    ext = _ext_from_content_type(content_type)
    return f"zukan-media.{ext}" if ext else "zukan-media"


def _should_fallback(status: int, payload: dict) -> bool:
    if status not in INGEST_FALLBACK_STATUSES:
        return False
    detail = (payload.get("detail") or "").lower() if isinstance(payload, dict) else ""
    if status == 403 and ("not authenticated" in detail or "invalid token" in detail):
        return False
    if status == 422 and "not authenticated" in detail:
        return False
    return True


def _summarize(results: list[dict]) -> tuple[int, int, int]:
    accepted = sum(1 for r in results if r.get("status") == "accepted")
    duplicate = sum(1 for r in results if r.get("status") == "duplicate")
    failed = sum(1 for r in results if r.get("status") not in ("accepted", "duplicate"))
    return accepted, duplicate, failed


async def resolve_cobalt(client: httpx.AsyncClient, tweet_url: str) -> list[dict]:
    resp = await client.post(
        f"{COBALT_BASE_URL}/",
        json={"url": tweet_url, "downloadMode": "auto", "filenameStyle": "basic"},
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        timeout=30.0,
    )
    try:
        payload = resp.json()
    except Exception:
        payload = {"status": "error", "error": {"code": f"http_{resp.status_code}"}}

    if not resp.is_success:
        code = payload.get("error", {}).get("code", f"http_{resp.status_code}")
        raise ValueError(f"Cobalt error: {code}")

    status = payload.get("status")
    if status in ("redirect", "tunnel"):
        return [{"url": payload["url"], "filename": payload.get("filename")}]
    if status == "picker":
        return [
            {"url": item["url"], "filename": item.get("filename")}
            for item in payload.get("picker", [])
            if item.get("url")
        ]
    if status == "error":
        code = payload.get("error", {}).get("code", "unknown")
        raise ValueError(f"Cobalt error: {code}")
    raise ValueError(f"Unexpected Cobalt response: {status}")


async def upload_asset(client: httpx.AsyncClient, asset: dict) -> tuple[int, int, int]:
    url = asset["url"]
    preferred_filename = asset.get("filename")
    auth = {"Authorization": f"Bearer {ZUKAN_TOKEN}"}

    ingest_resp = await client.post(
        f"{ZUKAN_BASE_URL}/api/v1/media/ingest-url",
        json={"url": url, "visibility": DEFAULT_VISIBILITY, "captured_at": None},
        headers={**auth, "Content-Type": "application/json"},
        timeout=60.0,
    )
    try:
        ingest_payload = ingest_resp.json()
    except Exception:
        ingest_payload = {}

    if ingest_resp.status_code == 202:
        return _summarize(ingest_payload.get("results", []))

    if not _should_fallback(ingest_resp.status_code, ingest_payload):
        detail = (ingest_payload.get("detail") or f"status {ingest_resp.status_code}")
        raise ValueError(f"Zukan ingest failed: {detail}")

    media_resp = await client.get(url, timeout=30.0, follow_redirects=True)
    media_resp.raise_for_status()

    content_type = media_resp.headers.get("content-type", "")
    content_disposition = media_resp.headers.get("content-disposition", "")
    filename = preferred_filename or derive_filename(url, content_type, content_disposition)

    upload_resp = await client.post(
        f"{ZUKAN_BASE_URL}/api/v1/media",
        files=[("files", (filename, media_resp.content, content_type))],
        data={"visibility": DEFAULT_VISIBILITY},
        headers=auth,
        timeout=120.0,
    )
    try:
        upload_payload = upload_resp.json()
    except Exception:
        upload_payload = {}

    if upload_resp.status_code == 202:
        return _summarize(upload_payload.get("results", []))

    detail = (upload_payload.get("detail") or f"status {upload_resp.status_code}")
    raise ValueError(f"Upload failed: {detail}")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_authorized(update):
        return

    text = update.message.text or ""
    tweet_url = normalize_tweet_url(text)

    if not tweet_url:
        await update.message.reply_text("Send me a Twitter/X tweet URL and I'll save the media to Zukan.")
        return

    await update.message.reply_text("Fetching media\u2026")

    try:
        async with httpx.AsyncClient() as client:
            assets = await resolve_cobalt(client, tweet_url)

            total_accepted = total_duplicate = total_failed = 0

            for asset in assets:
                try:
                    a, d, f = await upload_asset(client, asset)
                    total_accepted += a
                    total_duplicate += d
                    total_failed += f
                except Exception as exc:
                    total_failed += 1

            parts = []
            if total_accepted:
                parts.append(f"{total_accepted} saved")
            if total_duplicate:
                parts.append(f"{total_duplicate} duplicate")
            if total_failed:
                parts.append(f"{total_failed} failed")

            await update.message.reply_text(", ".join(parts) if parts else "No media found.")

    except Exception as exc:
        await update.message.reply_text(f"Error: {exc}")


def _is_authorized(update: Update) -> bool:
    user = update.effective_user
    return bool(user and user.id == ALLOWED_TELEGRAM_USER_ID)


async def health(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_authorized(update):
        return
    await update.message.reply_text("ok")


def main() -> None:
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("health", health))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.run_polling()


if __name__ == "__main__":
    main()
