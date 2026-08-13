import os
import sys
import types
import unittest
from unittest.mock import AsyncMock


os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-token")
os.environ.setdefault("ZUKAN_BASE_URL", "https://zukan.example")
os.environ.setdefault("ZUKAN_TOKEN", "zk_test")
os.environ.setdefault("ALLOWED_TELEGRAM_USER_ID", "123")


httpx_module = types.ModuleType("httpx")
httpx_module.AsyncClient = object
httpx_module.RequestError = Exception
sys.modules.setdefault("httpx", httpx_module)

dotenv_module = types.ModuleType("dotenv")
dotenv_module.load_dotenv = lambda: None
sys.modules.setdefault("dotenv", dotenv_module)

telegram_module = types.ModuleType("telegram")
telegram_module.Update = object
sys.modules.setdefault("telegram", telegram_module)

telegram_ext_module = types.ModuleType("telegram.ext")
telegram_ext_module.Application = object
telegram_ext_module.CommandHandler = object
telegram_ext_module.MessageHandler = object
telegram_ext_module.filters = types.SimpleNamespace(TEXT=None, COMMAND=None)
telegram_ext_module.ContextTypes = types.SimpleNamespace(DEFAULT_TYPE=object)
sys.modules.setdefault("telegram.ext", telegram_ext_module)


from bot import build_twitter_external_ref, ingest_media  # noqa: E402


class IngestMediaExternalRefsTests(unittest.IsolatedAsyncioTestCase):
    async def test_ingest_media_patches_external_refs_after_ingest_duplicate(self):
        client = AsyncMock()
        media_id = "00000000-0000-0000-0000-000000000001"
        client.post.return_value = types.SimpleNamespace(
            status_code=202,
            json=lambda: {"results": [{"id": media_id, "status": "duplicate"}]},
        )
        client.get.return_value = types.SimpleNamespace(
            status_code=200,
            json=lambda: {"external_refs": []},
        )
        client.patch.return_value = types.SimpleNamespace(status_code=200)

        external_refs = [{
            "provider": "twitter",
            "external_id": "123",
            "url": "https://x.com/demo/status/123",
        }]

        accepted, duplicate, failed, reasons = await ingest_media(
            client,
            "https://x.com/demo/status/123",
            external_refs,
        )

        self.assertEqual((accepted, duplicate, failed, reasons), (0, 1, 0, []))
        client.patch.assert_awaited_once_with(
            f"https://zukan.example/api/v1/media/{media_id}",
            json={"external_refs": external_refs},
            headers={"Authorization": "Bearer zk_test", "Content-Type": "application/json"},
            timeout=30.0,
        )

    async def test_ingest_media_raises_on_non_202_response(self):
        client = AsyncMock()
        client.post.return_value = types.SimpleNamespace(
            status_code=422,
            json=lambda: {"detail": "URL resolves to a blocked host 192.168.178.102"},
            text='{"detail":"URL resolves to a blocked host 192.168.178.102"}',
        )

        external_refs = [{
            "provider": "twitter",
            "external_id": "123",
            "url": "https://x.com/demo/status/123",
        }]

        with self.assertRaises(ValueError):
            await ingest_media(client, "https://x.com/demo/status/123", external_refs)

    async def test_ingest_media_reports_external_ref_patch_failure(self):
        client = AsyncMock()
        media_id = "00000000-0000-0000-0000-000000000003"
        client.post.return_value = types.SimpleNamespace(
            status_code=202,
            json=lambda: {"results": [{"id": media_id, "status": "duplicate"}]},
        )
        client.get.return_value = types.SimpleNamespace(
            status_code=200,
            json=lambda: {"external_refs": []},
        )
        client.patch.return_value = types.SimpleNamespace(
            status_code=422,
            json=lambda: {"detail": "external refs invalid"},
            text='{"detail":"external refs invalid"}',
        )

        external_refs = [{
            "provider": "twitter",
            "external_id": "123",
            "url": "https://x.com/demo/status/123",
        }]

        accepted, duplicate, failed, reasons = await ingest_media(
            client,
            "https://x.com/demo/status/123",
            external_refs,
        )

        self.assertEqual((accepted, duplicate, failed), (0, 1, 1))
        self.assertEqual(reasons, [
            f"Twitter ref update failed for {media_id}: external refs invalid",
        ])

    async def test_ingest_media_skips_patch_when_external_refs_are_already_present(self):
        client = AsyncMock()
        media_id = "00000000-0000-0000-0000-000000000004"
        external_refs = [{
            "provider": "twitter",
            "external_id": "123",
            "url": "https://x.com/demo/status/123",
        }]
        client.post.return_value = types.SimpleNamespace(
            status_code=202,
            json=lambda: {"results": [{"id": media_id, "status": "accepted"}]},
        )
        client.get.return_value = types.SimpleNamespace(
            status_code=200,
            json=lambda: {"external_refs": external_refs},
        )

        accepted, duplicate, failed, reasons = await ingest_media(
            client,
            "https://x.com/demo/status/123",
            external_refs,
        )

        self.assertEqual((accepted, duplicate, failed, reasons), (1, 0, 0, []))
        client.patch.assert_not_awaited()


class TwitterExternalRefTests(unittest.TestCase):
    def test_build_twitter_external_ref_normalizes_permalink(self):
        self.assertEqual(
            build_twitter_external_ref("https://twitter.com/demo/status/123/photo/1"),
            {
                "provider": "twitter",
                "external_id": "123",
                "url": "https://x.com/demo/status/123",
            },
        )


if __name__ == "__main__":
    unittest.main()
