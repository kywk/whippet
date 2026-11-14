import io
import json
import os
import secrets
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import bridge
import set_keychain


class FakeResponse:
    def __init__(self, status, body=b"", content_type="application/json", headers=None):
        self.status = status
        self.body = io.BytesIO(body)
        self.headers = {"Content-Type": content_type, **(headers or {})}

    def read(self, size):
        return self.body.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.token = secrets.token_urlsafe(24)
        self.bridge = bridge.Bridge(
            "http://127.0.0.1:19587/mcp", "fixture", "agent",
            token_reader=lambda *_: self.token,
            opener=self.open,
        )

    def open(self, request, timeout):
        self.sent.append((request, timeout))
        payload = json.loads(request.data)
        if "id" not in payload:
            return FakeResponse(202)
        method = payload["method"]
        if method == "initialize":
            result = {"protocolVersion": "2025-11-25", "capabilities": {}}
        elif method == "tools/call":
            result = {"content": [], "_meta": {"server": "kept"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "catalog_get"}]}
        elif method == "resources/list":
            result = {"resources": []}
        else:
            result = {"contents": []}
        return FakeResponse(200, json.dumps({"jsonrpc": "2.0", "id": payload["id"], "result": result}).encode())

    def test_initialize_lists_resource_and_call_preserve_meta(self):
        methods = ["initialize", "tools/list", "resources/list", "resources/read", "tools/call"]
        for n, method in enumerate(methods):
            request = {"jsonrpc": "2.0", "id": n, "method": method,
                       "params": {"_meta": {"whippet": {"callId": "synthetic"}}}}
            result = self.bridge.process(json.dumps(request).encode())
            self.assertEqual(json.loads(result)["id"], n)
            self.assertEqual(json.loads(self.sent[-1][0].data), request)
            self.assertEqual(self.sent[-1][0].get_header("Authorization"), "Bearer " + self.token)
        self.assertEqual(json.loads(result)["result"]["_meta"], {"server": "kept"})
        self.assertIn("application/json", self.sent[0][0].get_header("Accept"))
        self.assertIn("text/event-stream", self.sent[0][0].get_header("Accept"))

    def test_browser_calls_gain_lease_metadata_without_changing_arguments(self):
        session_id = "11111111-1111-4111-8111-111111111111"
        lease_id = "22222222-2222-4222-8222-222222222222"

        def browser_upstream(request, timeout):
            self.sent.append((request, timeout))
            payload = json.loads(request.data)
            if payload["method"] == "tools/call" and payload["params"]["name"] == "browser_session_open":
                content = {"sessionId": session_id, "leaseId": lease_id,
                           "state": "ready", "reclaimed": False}
                result = {"structuredContent": content,
                          "content": [{"type": "text", "text": json.dumps(content)}]}
            else:
                result = {"content": []}
            body = json.dumps({"jsonrpc": "2.0", "id": payload["id"], "result": result}).encode()
            return FakeResponse(200, body)

        self.bridge.opener = browser_upstream
        def call(request_id, name, arguments):
            return self.bridge.process(json.dumps({"jsonrpc": "2.0", "id": request_id,
                "method": "tools/call", "params": {"name": name, "arguments": arguments}}).encode())

        call(1, "browser_session_open", {"requestId": "33333333-3333-4333-8333-333333333333"})
        args = {"url": "https://example.test/path"}
        call(2, "browser_navigate", args)
        sent = json.loads(self.sent[-1][0].data)
        self.assertEqual(sent["params"]["arguments"], args)
        self.assertEqual(set(sent["params"]["_meta"]), {"whippet"})
        meta = sent["params"]["_meta"]["whippet"]
        self.assertEqual(meta["sessionId"], session_id)
        self.assertEqual(meta["leaseId"], lease_id)
        self.assertEqual(str(uuid.UUID(meta["callId"])), meta["callId"])

        explicit = {"whippet": {"sessionId": session_id, "leaseId": lease_id,
                                "callId": "44444444-4444-4444-8444-444444444444"}}
        request = {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                   "params": {"name": "browser_snapshot", "arguments": {}, "_meta": explicit}}
        self.bridge.process(json.dumps(request).encode())
        self.assertEqual(json.loads(self.sent[-1][0].data), request)

        call(4, "browser_session_close", {"sessionId": session_id, "leaseId": lease_id})
        call(5, "browser_click", {"selector": "text=Go"})
        self.assertNotIn("_meta", json.loads(self.sent[-1][0].data)["params"])

    def test_notification_202_has_no_stdout_frame(self):
        message = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        self.assertIsNone(self.bridge.process(json.dumps(message).encode()))

    def test_malformed_tool_name_does_not_crash_transport(self):
        frame = b'{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":{},"arguments":{}}}'
        result = self.bridge.process(frame)
        self.assertEqual(json.loads(result)["id"], 6)

    def test_stdio_emits_only_jsonrpc_for_request(self):
        request = b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'
        notice = b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
        fake_stdin = io.TextIOWrapper(io.BytesIO(request + notice), encoding="utf-8")
        fake_stdout = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        argv = ["bridge.py", "--url", self.bridge.url,
                "--keychain-service", "fixture", "--keychain-account", "agent"]
        with patch.object(bridge.sys, "argv", argv), patch.object(bridge.sys, "stdin", fake_stdin), \
             patch.object(bridge.sys, "stdout", fake_stdout), \
             patch.object(bridge, "Bridge", return_value=self.bridge):
            self.assertEqual(bridge.main(), 0)
        lines = fake_stdout.buffer.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["id"], 1)
        self.assertEqual(self.sent[1][0].get_header("Mcp-protocol-version"), "2025-11-25")

    def test_http_error_does_not_echo_body_or_secret(self):
        def error(*_, **__):
            return FakeResponse(403, ("private " + self.token).encode())
        self.bridge.opener = error
        result = self.bridge.process(b'{"jsonrpc":"2.0","id":9,"method":"tools/list"}')
        self.assertEqual(json.loads(result)["error"]["message"], "upstream_http_error")
        self.assertNotIn(self.token.encode(), result)
        self.assertNotIn(b"private", result)

    def test_missing_keychain_is_fixed_error_and_no_http(self):
        self.bridge.token_reader = lambda *_: (_ for _ in ()).throw(bridge.BridgeError("keychain_item_missing"))
        result = self.bridge.process(b'{"jsonrpc":"2.0","id":4,"method":"tools/list"}')
        self.assertEqual(json.loads(result)["error"]["message"], "keychain_item_missing")
        self.assertEqual(self.sent, [])

    def test_oversize_frame_is_rejected(self):
        result = self.bridge.process(b"x" * (bridge.MAX_FRAME + 1))
        self.assertEqual(json.loads(result)["error"]["message"], "frame_too_large")
        self.assertEqual(self.sent, [])

    def test_response_limit_and_redirect_are_fixed_errors(self):
        self.bridge.opener = lambda *args, **kwargs: FakeResponse(200, b"x" * (bridge.MAX_RESPONSE + 1))
        frame = b'{"jsonrpc":"2.0","id":5,"method":"tools/list"}'
        self.assertEqual(json.loads(self.bridge.process(frame))["error"]["message"],
                         "upstream_response_too_large")
        self.assertIsNone(bridge.NoRedirect().redirect_request(None, None, 302, "", {},
                                                               "http://elsewhere/mcp"))

    def test_loopback_only(self):
        for url in ("http://localhost:19587/mcp", "https://127.0.0.1:19587/mcp",
                    "http://127.0.0.1:19587/mcp?x=1", "http://127.0.0.1/mcp"):
            with self.assertRaises(bridge.BridgeError):
                bridge.Bridge(url, "fixture", "agent")


class KeychainHelperTests(unittest.TestCase):
    def test_create_only_reports_fixed_enum(self):
        class FakeAdd:
            def __init__(self, status):
                self.status = status

            def __call__(self, *_):
                return self.status

        class FakeSecurity:
            SecKeychainAddGenericPassword = FakeAdd(-25299)

        with patch.object(set_keychain.ctypes, "CDLL", return_value=FakeSecurity()):
            self.assertEqual(set_keychain.add_new("fixture", "agent", secrets.token_urlsafe(24)),
                             "item_exists")

    def test_reader_never_passes_secret_on_argv(self):
        token = secrets.token_urlsafe(24)

        class Completed:
            returncode = 0
            stdout = token.encode() + b"\n"

        with patch.object(bridge.subprocess, "run", return_value=Completed()) as run:
            self.assertEqual(bridge.read_keychain("fixture", "agent"), token)
            self.assertEqual(run.call_args.args[0][-1], "-w")
            self.assertNotIn(token, run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs["stderr"], bridge.subprocess.DEVNULL)


class SecretFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.tmp.cleanup)
        os.chmod(self.tmp.name, 0o700)
        self.path = os.path.join(self.tmp.name, "agent-token")
        self.token = secrets.token_urlsafe(24)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(self.token.encode())

    def test_read_and_bridge_file_mode(self):
        self.assertEqual(bridge.read_secret_file(self.path), self.token)
        adapter = bridge.Bridge("http://127.0.0.1:19587/mcp", None, None,
                                secret_file=self.path, opener=lambda *a, **k: FakeResponse(
                                    200, b'{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'))
        result = adapter.process(b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
        self.assertEqual(json.loads(result)["result"], {"tools": []})

    def test_rejects_weak_file_or_parent_permissions(self):
        os.chmod(self.path, 0o644)
        with self.assertRaises(bridge.BridgeError):
            bridge.read_secret_file(self.path)
        os.chmod(self.path, 0o600)
        os.chmod(self.tmp.name, 0o755)
        with self.assertRaises(bridge.BridgeError):
            bridge.read_secret_file(self.path)

    def test_rejects_file_and_parent_symlinks(self):
        link = os.path.join(self.tmp.name, "link")
        os.symlink(self.path, link)
        with self.assertRaises(bridge.BridgeError):
            bridge.read_secret_file(link)
        parent_link = os.path.join(Path(self.tmp.name).parent, Path(self.tmp.name).name + "-link")
        os.symlink(self.tmp.name, parent_link)
        self.addCleanup(os.unlink, parent_link)
        with self.assertRaises(bridge.BridgeError):
            bridge.read_secret_file(os.path.join(parent_link, "agent-token"))

    def test_rejects_fifo_without_blocking(self):
        fifo = os.path.join(self.tmp.name, "fifo")
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(bridge.BridgeError):
            bridge.read_secret_file(fifo)

    def test_rejects_relative_path_and_mixed_sources(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.read_secret_file("relative")
        with self.assertRaises(bridge.BridgeError):
            bridge.Bridge("http://127.0.0.1:19587/mcp", "fixture", "agent",
                          secret_file=self.path)


if __name__ == "__main__":
    unittest.main()
