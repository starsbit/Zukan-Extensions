# Zukan Telegram Bot

Telegram bot that accepts Twitter/X tweet URLs and saves their media to a Zukan instance.

**Flow:** tweet URL → Cobalt resolves media → Zukan `ingest-url` (server-side download) or direct upload fallback → reply with result summary.

## Prerequisites

- A running Zukan instance with its API accessible
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Zukan API token (the `ZUKAN_TOKEN` you already have in your Zukan `.env`)
- Python 3.12+ **or** Docker

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```env
TELEGRAM_BOT_TOKEN=   # from BotFather
ZUKAN_BASE_URL=       # e.g. https://zukan.example.com
ZUKAN_TOKEN=          # Bearer token for the Zukan API
COBALT_BASE_URL=https://api.cobalt.tools   # leave as-is unless self-hosting Cobalt
DEFAULT_VISIBILITY=private
```

## Running with Docker (recommended)

```bash
cd bots/telegram
cp .env.example .env
# edit .env

docker build -t zukan-telegram-bot .
docker run -d --restart unless-stopped --env-file .env --name zukan-telegram-bot zukan-telegram-bot
```

### Adding to docker-compose

Add this service to your `docker-compose.yml` or `docker-compose.prod.yml` alongside the API:

```yaml
  telegram-bot:
    build:
      context: ./bots/telegram
    env_file:
      - ./bots/telegram/.env
    restart: unless-stopped
    depends_on:
      api:
        condition: service_started
```

The bot needs network access to:
- The Zukan API (can be the internal Docker network name, e.g. `http://api:8000`)
- Telegram servers (outbound HTTPS)
- `api.cobalt.tools` (outbound HTTPS, or your self-hosted Cobalt instance)

## Running without Docker

```bash
cd bots/telegram
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env
python bot.py
```

## Usage

Send any message containing a tweet URL to the bot:

```
https://x.com/example/status/123456789
```

The bot replies with a summary:

```
3 saved
```
```
2 saved, 1 duplicate
```
```
1 failed
```

Non-tweet messages receive a usage hint.
