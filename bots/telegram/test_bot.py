import os
import sys
import types
import unittest
from unittest.mock import AsyncMock


os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-token")
os.environ.setdefault("ZUKAN_BASE_URL", "https://zukan.example")
os.environ.setdefault("ZUKAN_TOKEN", "zk_test")
os.environ.setdefault("ALLOWED_TELEGRAM_USER_ID", "123")


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


from bot import build_twitter_external_ref, upload_asset  # noqa: E402


class UploadAssetExternalRefsTests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_asset_patches_external_refs_after_ingest_duplicate(self):
        client = AsyncMock()
        media_id = "00000000-0000-0000-0000-000000000001"
        client.post.return_value = types.SimpleNamespace(
            status_code=202,
            json=lambda: {"results": [{"id": media_id, "status": "duplicate"}]},
        )
        client.patch.return_value = types.SimpleNamespace(status_code=200)

        external_refs = [{
            "provider": "twitter",
            "external_id": "123",
            "url": "https://x.com/demo/status/123",
        }]

        accepted, duplicate, failed, reasons = await upload_asset(
            client,
            {"url": "https://pbs.twimg.com/media/example.jpg?format=jpg&name=orig"},
            external_refs,
        )

        self.assertEqual((accepted, duplicate, failed, reasons), (0, 1, 0, []))
        client.get.assert_not_awaited()
        client.patch.assert_awaited_once_with(
            f"https://zukan.example/api/v1/media/{media_id}",
            json={"external_refs": external_refs},
            headers={"Authorization": "Bearer zk_test", "Content-Type": "application/json"},
            timeout=30.0,
        )

    async def test_upload_asset_sends_external_refs_to_ingest_and_fallback_upload(self):
        client = AsyncMock()
        media_id = "00000000-0000-0000-0000-000000000002"
        client.post.side_effect = [
            types.SimpleNamespace(status_code=415, json=lambda: {}, is_success=False),
            types.SimpleNamespace(status_code=202, json=lambda: {"results": [{"id": media_id, "status": "accepted"}]}),
        ]
        client.patch.return_value = types.SimpleNamespace(status_code=200)
        client.get.return_value = types.SimpleNamespace(
            headers={"content-type": "image/jpeg", "content-disposition": ""},
            content=b"image-bytes",
            raise_for_status=lambda: None,
        )

        external_refs = [{
            "provider": "twitter",
            "external_id": "123",
            "url": "https://x.com/demo/status/123",
        }]

        accepted, duplicate, failed, reasons = await upload_asset(
            client,
            {"url": "https://pbs.twimg.com/media/example.jpg?format=jpg&name=orig"},
            external_refs,
        )

        self.assertEqual((accepted, duplicate, failed, reasons), (1, 0, 0, []))
        self.assertEqual(client.post.await_args_list[0].kwargs["json"]["external_refs"], external_refs)
        self.assertEqual(client.post.await_args_list[1].kwargs["data"]["external_refs"], '[{"provider": "twitter", "external_id": "123", "url": "https://x.com/demo/status/123"}]')
        self.assertEqual(client.post.await_args_list[1].kwargs["data"]["external_refs_values"], '[{"provider": "twitter", "external_id": "123", "url": "https://x.com/demo/status/123"}]')
        client.patch.assert_awaited_once_with(
            f"https://zukan.example/api/v1/media/{media_id}",
            json={"external_refs": external_refs},
            headers={"Authorization": "Bearer zk_test", "Content-Type": "application/json"},
            timeout=30.0,
        )


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
