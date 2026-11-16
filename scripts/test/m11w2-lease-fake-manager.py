"""Isolated M11 Wave2 Server lease QA with a controlled fake Manager.

This checks MCP/Server authorization, dedupe and reconciliation wire behavior.
The fake Manager does not launch Docker; the separate Docker E2E owns that proof.
No existing deployment environment, secret, database, artifact or journal is read.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import select
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid


class CheckFailed(Exception):
    pass


def ensure(condition, label, checks):
    checks[label] = bool(condition)
    if not condition:
        raise CheckFailed(label)


def free_port():
    while True:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        if port not in (19287, 19587):
            return port


class FakeManager:
    def __init__(self, port, token, manager_id, initial_sessions=()):
        self.port, self.token, self.manager_id = port, token, manager_id
        self.sock = None
        self.buffer = b""
        self.lock = threading.Lock()
        self.events = []
        self.sessions = {x["sessionId"]: dict(x) for x in initial_sessions}
        self.reply_calls = True
        self.reply_closes = False
        self.running = False
        self.thread = None

    def connect(self):
        self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        request = ("GET /api/manager/connect HTTP/1.1\r\n"
                   f"Host: 127.0.0.1:{self.port}\r\n"
                   "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                   f"Authorization: Bearer {self.token}\r\n\r\n")
        self.sock.sendall(request.encode())
        while b"\r\n\r\n" not in self.buffer and len(self.buffer) < 8192:
            self.buffer += self.sock.recv(8192)
        header, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
        if not header.startswith(b"HTTP/1.1 101 "):
            raise CheckFailed("manager_websocket_upgrade")
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        if b"Sec-Websocket-Accept: " + accept not in header and b"Sec-WebSocket-Accept: " + accept not in header:
            raise CheckFailed("manager_websocket_accept")
        self.sock.settimeout(5)
        self.running = True
        self.send("hello", {"capacity": 1})
        self.send_heartbeat()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def send(self, kind, payload):
        envelope = {"protocolVersion": 1, "messageId": str(uuid.uuid4()),
                    "type": kind, "managerId": self.manager_id, "payload": payload}
        data = json.dumps(envelope, separators=(",", ":")).encode()
        mask = secrets.token_bytes(4)
        size = len(data)
        length = bytes([size]) if size < 126 else (b"\x7e" + struct.pack("!H", size)) if size < 65536 else (b"\x7f" + struct.pack("!Q", size))
        frame = b"\x81" + bytes([length[0] | 0x80]) + length[1:] + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(data))
        with self.lock:
            self.sock.sendall(frame)

    def send_heartbeat(self, omit_sessions=False):
        with self.lock:
            sessions = [] if omit_sessions else [{"sessionId": x["sessionId"], "leaseId": x["leaseId"], "state": x["state"]} for x in self.sessions.values()]
        self.send("heartbeat", {"active": [], "sessions": sessions})

    def closed(self, session_id, reason="closed"):
        with self.lock:
            item = self.sessions.pop(session_id, None)
        if item:
            self.send("session.closed", {"sessionId": session_id, "leaseId": item["leaseId"], "reason": reason, "reclaimed": True})

    def count(self, kind):
        with self.lock:
            return sum(event["type"] == kind for event in self.events)

    def wait_event(self, kind, count=1, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                found = [e for e in self.events if e["type"] == kind]
            if len(found) >= count:
                return found[count - 1]
            time.sleep(0.05)
        raise CheckFailed("wire_timeout_" + kind.replace(".", "_"))

    def _loop(self):
        next_heartbeat = time.monotonic() + 5
        while self.running:
            try:
                if time.monotonic() >= next_heartbeat:
                    self.send_heartbeat()
                    next_heartbeat = time.monotonic() + 5
                readable, _, _ = select.select([self.sock], [], [], 0.2)
                if readable:
                    chunk = self.sock.recv(262144)
                    if not chunk:
                        break
                    self.buffer += chunk
                while len(self.buffer) >= 2:
                    b0, b1 = self.buffer[:2]
                    length, offset = b1 & 127, 2
                    if length == 126:
                        if len(self.buffer) < 4:
                            break
                        length, offset = struct.unpack("!H", self.buffer[2:4])[0], 4
                    elif length == 127:
                        if len(self.buffer) < 10:
                            break
                        length, offset = struct.unpack("!Q", self.buffer[2:10])[0], 10
                    if len(self.buffer) < offset + length:
                        break
                    data, self.buffer = self.buffer[offset:offset + length], self.buffer[offset + length:]
                    if b0 & 15 == 8:
                        self.running = False
                        break
                    if b0 & 15 != 1:
                        continue
                    event = json.loads(data)
                    with self.lock:
                        self.events.append(event)
                    self._respond(event)
            except (OSError, ValueError, KeyError, json.JSONDecodeError):
                break
        self.running = False

    def _respond(self, event):
        kind, p = event.get("type"), event.get("payload") or {}
        if kind == "session.open":
            with self.lock:
                self.sessions[p["sessionId"]] = {"sessionId": p["sessionId"], "leaseId": p["leaseId"], "state": "ready"}
            self.send("session.ready", {"sessionId": p["sessionId"], "leaseId": p["leaseId"]})
        elif kind == "session.call" and self.reply_calls:
            self.send("session.reply", {"sessionId": p["sessionId"], "leaseId": p["leaseId"],
                                        "callId": p["callId"], "result": {"snapshot": "fake-manager-ack", "selectorHints": []}})
        elif kind == "session.close" and self.reply_closes:
            self.closed(p["sessionId"])

    def disconnect(self):
        self.running = False
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()
        if self.thread:
            self.thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-binary", required=True)
    parser.add_argument("--postgres-container", required=True)
    parser.add_argument("--postgres-port", type=int, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    schema = "m11w2_lease_" + uuid.uuid4().hex
    checks = {}
    server = None
    managers = []
    created = False

    def sql(statement):
        subprocess.run(["docker", "exec", args.postgres_container, "psql", "-X", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", statement],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        sql("CREATE SCHEMA " + schema)
        created = True
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        admin, manager_key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        manager_id = "m11w2-lease-" + uuid.uuid4().hex
        sequence = 0
        last_mcp = {}
        http_client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def request(path, method="GET", body=None, headers=None):
            raw = None if body is None else json.dumps(body, separators=(",", ":")).encode()
            req = urllib.request.Request(base + path, data=raw, method=method)
            req.add_header("Content-Type", "application/json")
            for key, value in (headers or {}).items():
                req.add_header(key, value)
            try:
                response = http_client.open(req, timeout=20)
            except urllib.error.HTTPError as exc:
                response = exc
            with response:
                data = response.read(1 << 20)
                try:
                    parsed = json.loads(data) if data else None
                except (ValueError, UnicodeDecodeError):
                    parsed = None
                return response.status, parsed

        def admin_request(path, method="GET", body=None):
            return request(path, method, body, {"X-Whippet-Admin-Token": admin})

        def mcp(token, name, arguments, meta=None):
            nonlocal sequence
            previous = last_mcp.get(token, 0)
            delay = 1.05 - (time.monotonic() - previous)
            if delay > 0:
                time.sleep(delay)
            last_mcp[token] = time.monotonic()
            sequence += 1
            params = {"name": name, "arguments": arguments}
            if meta is not None:
                params["_meta"] = meta
            body = {"jsonrpc": "2.0", "id": sequence, "method": "tools/call", "params": params}
            headers = {"Authorization": "Bearer " + token, "Accept": "application/json, text/event-stream"}
            for attempt in range(3):
                response = request("/mcp", "POST", body, headers)
                if response[0] != 429 or attempt == 2:
                    return response
                # 429 is emitted by the Token bucket before the tool is accepted.
                # No other failed or unknown browser operation is retried here.
                time.sleep(1.1)
            raise CheckFailed("rate_limit_retry_bound")

        def success(response):
            status, data = response
            return status == 200 and isinstance(data, dict) and isinstance(data.get("result"), dict) and not data["result"].get("isError", False)

        def rejected(response):
            status, data = response
            return status in (400, 401, 403, 404, 409) or (status == 200 and isinstance(data, dict) and
                   ("error" in data or isinstance(data.get("result"), dict) and data["result"].get("isError") is True))

        def lease(response):
            if not success(response):
                raise CheckFailed("open_result")
            value = response[1]["result"].get("structuredContent")
            if not isinstance(value, dict) or set(value) != {"sessionId", "leaseId", "state", "reclaimed"}:
                raise CheckFailed("lease_result_shape")
            if not all(isinstance(value[k], str) and uuid.UUID(value[k]) for k in ("sessionId", "leaseId")):
                raise CheckFailed("lease_ids")
            return value

        with tempfile.TemporaryDirectory(prefix="whippet-m11w2-lease-") as artifact_dir:
            env = {"PATH": os.defpath,
                   "DATABASE_URL": f"postgres://postgres@127.0.0.1:{args.postgres_port}/postgres?sslmode=disable&search_path={schema}",
                   "MANAGER_TOKEN": manager_key, "WHIPPET_ADMIN_TOKEN": admin,
                   "WHIPPET_PUBLIC_ORIGIN": base, "WHIPPET_BIND_HOST": "127.0.0.1", "PORT": str(port),
                   "ARTIFACT_DIR": artifact_dir, "WHIPPET_TOOL_REGISTRY_PATH": str(root / "contracts/tools/registry.json"),
                   "WHIPPET_SKILLS_PATH": str(root / "runtimes/worker/skills")}
            server = subprocess.Popen([args.server_binary], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            ready = False
            for _ in range(100):
                if server.poll() is not None:
                    break
                try:
                    ready = request("/readyz")[0] == 200
                except (urllib.error.URLError, OSError):
                    pass
                if ready:
                    break
                time.sleep(0.1)
            ensure(ready, "isolated_server_ready", checks)

            workspaces = []
            for index in (1, 2):
                status, item = admin_request("/api/workspaces", "POST", {"name": f"M11W2 lease QA {index}"})
                ensure(status == 201 and isinstance(item, dict) and "id" in item, "workspace_created_" + str(index), checks)
                workspaces.append(item["id"])
            # This direct fixture update is confined to the fresh schema. No real workspace is touched.
            config = {"name": "M11W2 lease QA", "purpose": "isolated lease authorization",
                      "backgroundSummary": "synthetic", "targets": [{"name": "loopback", "purpose": "test", "origin": base}],
                      "dependencies": [], "excludedOrigins": [], "exclusions": "", "loginRoles": [],
                      "defaultTestUrl": base, "timeoutMs": 60000}
            encoded = json.dumps(config, separators=(",", ":")).replace("'", "''")
            sql(f"UPDATE {schema}.workspaces SET lifecycle='active',scope_status='confirmed',canonical_config='{encoded}'::jsonb,authorization_revision=authorization_revision+1 WHERE id IN ('{workspaces[0]}','{workspaces[1]}')")

            credentials = []
            for index, workspace in enumerate((workspaces[0], workspaces[0], workspaces[1])):
                status, item = admin_request(f"/api/workspaces/{workspace}/agent-tokens", "POST", {"name": f"lease QA {index}"})
                ensure(status == 201 and isinstance(item, dict) and "token" in item and "agentToken" in item,
                       "token_created_" + str(index), checks)
                credentials.append((item["token"], item["agentToken"]["id"]))
            token_a, token_a2, token_b = (x[0] for x in credentials)

            fake = FakeManager(port, manager_key, manager_id)
            managers.append(fake)
            fake.connect()
            fake.wait_event("heartbeat_ack")
            first_request_id = str(uuid.uuid4())
            first = lease(mcp(token_a, "browser_session_open", {"requestId": first_request_id}))
            fake.wait_event("session.open")
            deadline = time.monotonic() + 8
            while first["state"] == "opening" and time.monotonic() < deadline:
                time.sleep(0.2)
                first = lease(mcp(token_a, "browser_session_status", {"sessionId": first["sessionId"], "leaseId": first["leaseId"]}))
            ensure(first["state"] == "ready" and first["reclaimed"] is False, "lease_ready", checks)
            first_retry = lease(mcp(token_a, "browser_session_open", {"requestId": first_request_id}))
            ensure((first["sessionId"], first["leaseId"]) == (first_retry["sessionId"], first_retry["leaseId"]),
                   "same_request_same_first_lease", checks)
            ensure(fake.count("session.open") == 1, "one_wire_open", checks)

            sid, lid = first["sessionId"], first["leaseId"]
            ensure(rejected(mcp(token_a2, "browser_session_status", {"sessionId": sid, "leaseId": lid})), "cross_token_status_denied", checks)
            ensure(rejected(mcp(token_b, "browser_session_close", {"sessionId": sid, "leaseId": lid})), "cross_workspace_close_denied", checks)
            ensure(rejected(mcp(token_a, "browser_session_status", {"sessionId": sid, "leaseId": str(uuid.uuid4())})), "wrong_lease_denied", checks)
            ensure(rejected(mcp(token_a, "browser_session_open", {"requestId": str(uuid.uuid4())})), "second_request_denied", checks)
            ensure(fake.count("session.open") == 1, "second_request_no_wire_open", checks)

            call_id = str(uuid.uuid4())
            good_meta = {"whippet": {"sessionId": sid, "leaseId": lid, "callId": call_id}}
            bad_metas = [None, {"whippet": {"sessionId": sid, "leaseId": lid}},
                         {"whippet": {"sessionId": sid, "leaseId": lid, "callId": 7}},
                         {"whippet": {"sessionId": 7, "leaseId": lid, "callId": call_id}},
                         {"whippet": {"sessionId": sid, "leaseId": "bad", "callId": call_id}},
                         {"whippet": {"sessionId": sid, "leaseId": lid, "callId": "bad"}},
                         {"whippet": {"sessionId": sid, "leaseId": lid, "callId": call_id, "unknown": True}},
                         {"whippet": {"sessionId": sid, "leaseId": str(uuid.uuid4()), "callId": call_id}}]
            for index, meta in enumerate(bad_metas):
                ensure(rejected(mcp(token_a, "browser_click", {"selector": "#once"}, meta)), "strict_meta_" + str(index), checks)
            ensure(fake.count("session.call") == 0, "bad_meta_no_wire_call", checks)
            ensure(rejected(mcp(token_a, "browser_click", {"selector": "#once", "sessionId": sid}, good_meta)), "lease_not_in_arguments", checks)
            ensure(fake.count("session.call") == 0, "bad_arguments_no_wire_call", checks)
            ensure(rejected(mcp(token_a2, "browser_click", {"selector": "#once"}, good_meta)), "cross_token_call_denied", checks)
            ensure(rejected(mcp(token_b, "browser_click", {"selector": "#once"}, good_meta)), "cross_workspace_call_denied", checks)
            ensure(fake.count("session.call") == 0, "foreign_call_no_wire", checks)

            click = mcp(token_a, "browser_click", {"selector": "#once"}, good_meta)
            ensure(success(click), "first_click_accepted", checks)
            fake.wait_event("session.call")
            ensure(success(mcp(token_a, "browser_click", {"selector": "#once"}, good_meta)), "same_call_replayed", checks)
            ensure(fake.count("session.call") == 1, "same_call_no_second_wire", checks)
            ensure(rejected(mcp(token_a, "browser_click", {"selector": "#other"}, good_meta)), "same_call_different_body_denied", checks)
            ensure(fake.count("session.call") == 1, "different_body_no_second_wire", checks)

            status, _ = admin_request(f"/api/workspaces/{workspaces[0]}/agent-tokens/{credentials[0][1]}", "DELETE")
            ensure(status == 204, "token_revoked", checks)
            fake.wait_event("session.close")
            ensure(rejected(mcp(token_a, "browser_click", {"selector": "#once"}, {"whippet": {"sessionId": sid, "leaseId": lid, "callId": str(uuid.uuid4())}})), "revoked_call_denied", checks)
            ensure(rejected(mcp(token_a2, "browser_session_open", {"requestId": str(uuid.uuid4())})), "unreclaimed_slot_held", checks)
            fake.send_heartbeat(omit_sessions=True)
            time.sleep(1.2)
            ensure(rejected(mcp(token_a2, "browser_session_open", {"requestId": str(uuid.uuid4())})), "heartbeat_absence_not_reclaim", checks)
            fake.closed(sid)
            time.sleep(0.3)
            ensure(fake.count("session.open") == 1, "revoke_never_reopen", checks)

            second_request_id = str(uuid.uuid4())
            second = lease(mcp(token_a2, "browser_session_open", {"requestId": second_request_id}))
            fake.wait_event("session.open", 2)
            repeated = lease(mcp(token_a2, "browser_session_open", {"requestId": second_request_id}))
            ensure((second["sessionId"], second["leaseId"]) == (repeated["sessionId"], repeated["leaseId"]), "same_request_same_lease", checks)
            ensure(fake.count("session.open") == 2, "same_request_no_reopen", checks)

            sid2, lid2 = second["sessionId"], second["leaseId"]
            deadline = time.monotonic() + 8
            while repeated["state"] == "opening" and time.monotonic() < deadline:
                repeated = lease(mcp(token_a2, "browser_session_status", {"sessionId": sid2, "leaseId": lid2}))
            ensure(repeated["state"] == "ready", "second_lease_ready", checks)
            fake.reply_calls = False
            interrupted = {}
            interrupted_call_id = str(uuid.uuid4())
            def in_flight_call():
                try:
                    interrupted["response"] = mcp(token_a2, "browser_click", {"selector": "#in-flight"},
                                                  {"whippet": {"sessionId": sid2, "leaseId": lid2, "callId": interrupted_call_id}})
                except Exception:
                    interrupted["network_error"] = True
            pending = threading.Thread(target=in_flight_call, daemon=True)
            pending.start()
            fake.wait_event("session.call", 2)
            fake.disconnect()
            pending.join(timeout=22)
            ensure(not pending.is_alive(), "lost_reply_call_settled", checks)
            ensure("network_error" in interrupted or rejected(interrupted.get("response")), "lost_reply_not_success", checks)
            fake2 = FakeManager(port, manager_key, manager_id)
            managers.append(fake2)
            fake2.connect()
            fake2.wait_event("heartbeat_ack")
            fake2.wait_event("session.close")
            ensure(fake2.count("session.open") == 0, "reconnect_no_reopen", checks)
            ensure(fake2.count("session.call") == 0, "reconnect_no_call_replay", checks)
            retry_meta = {"whippet": {"sessionId": sid2, "leaseId": lid2, "callId": interrupted_call_id}}
            ensure(rejected(mcp(token_a2, "browser_click", {"selector": "#in-flight"}, retry_meta)),
                   "unknown_call_retry_denied", checks)
            ensure(fake2.count("session.call") == 0, "unknown_call_not_resent", checks)
            fake2.send("session.reply", {"sessionId": sid2, "leaseId": lid2, "callId": interrupted_call_id,
                                         "result": {"snapshot": "late-ack", "selectorHints": []}})
            time.sleep(0.2)
            stale = lease(mcp(token_a2, "browser_session_status", {"sessionId": sid2, "leaseId": lid2}))
            ensure(stale["state"] != "ready" and stale["reclaimed"] is False, "late_reply_cannot_revive", checks)
            ensure(rejected(mcp(token_b, "browser_session_open", {"requestId": str(uuid.uuid4())})), "disconnect_slot_held", checks)
            with fake2.lock:
                fake2.sessions[sid2] = {"sessionId": sid2, "leaseId": lid2, "state": "reclaim_pending"}
            fake2.closed(sid2, "manager_restart")
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                state = lease(mcp(token_a2, "browser_session_status", {"sessionId": sid2, "leaseId": lid2}))
                if state["state"] == "closed":
                    break
            ensure(state["state"] == "closed" and state["reclaimed"] is True, "reconnect_closed_after_evidence", checks)
            ensure(fake2.count("session.open") == 0, "reconnect_never_reopens", checks)
            final_retry = lease(mcp(token_a2, "browser_session_open", {"requestId": second_request_id}))
            ensure(final_retry["state"] == "closed" and final_retry["sessionId"] == sid2 and fake2.count("session.open") == 0,
                   "closed_request_tombstone", checks)
            third = lease(mcp(token_b, "browser_session_open", {"requestId": str(uuid.uuid4())}))
            fake2.wait_event("session.open")
            ensure(third["sessionId"] != sid2, "capacity_restored_after_reclaim", checks)
            fake2.reply_closes = True
            ensure(success(mcp(token_b, "browser_session_close", {"sessionId": third["sessionId"], "leaseId": third["leaseId"]})),
                   "final_close_accepted", checks)
    except Exception as error:
        checks["failure_type"] = ("assertion" if isinstance(error, CheckFailed) else
                                  "fixture_sql" if isinstance(error, subprocess.CalledProcessError) else
                                  "network" if isinstance(error, (OSError, urllib.error.URLError)) else "unexpected")
        if isinstance(error, CheckFailed):
            checks["failure_check"] = error.args[0]
    finally:
        for fake in managers:
            fake.disconnect()
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
        if created:
            try:
                sql("DROP SCHEMA " + schema + " CASCADE")
                checks["owned_schema_removed"] = True
            except Exception:
                checks["owned_schema_removed"] = False
        passed = bool(checks) and all(value is True for value in checks.values())
        print(json.dumps({"result": "PASS" if passed else "FAIL", "checks": checks}, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
