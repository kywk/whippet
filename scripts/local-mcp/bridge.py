#!/usr/bin/env python3
"""Local stdio to Whippet's JSON Streamable HTTP MCP endpoint.

This is a transport adapter, not an MCP tool implementation. It never logs
requests, responses, HTTP bodies, or Keychain output.
"""

import argparse
import json
import math
import os
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

MAX_FRAME = 1024 * 1024
MAX_RESPONSE = 1024 * 1024
MAX_TOKEN = 8192
HTTP_TIMEOUT = 30
KEYCHAIN_TIMEOUT = 5
ERRORS = frozenset({
    "invalid_request", "frame_too_large", "keychain_item_missing",
    "keychain_unavailable", "upstream_unavailable", "upstream_http_error",
    "upstream_protocol_error", "upstream_response_too_large",
    "secret_file_unavailable",
})


class BridgeError(Exception):
    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind if kind in ERRORS else "upstream_protocol_error"


def validate_url(url):
    try:
        parts = urlsplit(url)
        valid = (parts.scheme == "http" and parts.hostname in ("127.0.0.1", "::1")
                 and parts.port is not None and parts.path == "/mcp"
                 and not parts.username and not parts.password
                 and not parts.query and not parts.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise BridgeError("invalid_request")
    return url


def read_keychain(service, account):
    if not service or not account or any(c in service + account for c in "\r\n\x00"):
        raise BridgeError("keychain_unavailable")
    try:
        completed = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", service,
             "-a", account, "-w"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=KEYCHAIN_TIMEOUT, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise BridgeError("keychain_unavailable") from None
    if completed.returncode != 0:
        raise BridgeError("keychain_item_missing" if completed.returncode == 44 else "keychain_unavailable")
    value = completed.stdout.rstrip(b"\r\n")
    if not value or len(value) > MAX_TOKEN or any(c < 33 or c > 126 for c in value):
        raise BridgeError("keychain_unavailable")
    return value.decode("ascii")


def read_secret_file(path):
    """Read a single token from an owner-only file under an owner-only directory."""
    if not isinstance(path, str) or not os.path.isabs(path) or not os.path.basename(path):
        raise BridgeError("secret_file_unavailable")
    directory = None
    file_fd = None
    try:
        directory = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY |
                            os.O_NOFOLLOW | os.O_CLOEXEC)
        parent = os.fstat(directory)
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) != 0o700):
            raise BridgeError("secret_file_unavailable")
        file_fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW |
                          os.O_CLOEXEC, dir_fd=directory)
        item = os.fstat(file_fd)
        if (not stat.S_ISREG(item.st_mode) or item.st_uid != os.getuid()
            or stat.S_IMODE(item.st_mode) != 0o600 or item.st_nlink != 1):
            raise BridgeError("secret_file_unavailable")
        data = bytearray()
        while len(data) <= MAX_TOKEN + 1:
            chunk = os.read(file_fd, MAX_TOKEN + 2 - len(data))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > MAX_TOKEN + 1:
            raise BridgeError("secret_file_unavailable")
        if data.endswith(b"\r\n"):
            del data[-2:]
        elif data.endswith(b"\n"):
            del data[-1:]
        if not data or len(data) > MAX_TOKEN or any(c < 33 or c > 126 for c in data):
            raise BridgeError("secret_file_unavailable")
        return data.decode("ascii")
    except (OSError, ValueError, UnicodeError):
        raise BridgeError("secret_file_unavailable") from None
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if directory is not None:
            os.close(directory)


def error_frame(kind, request_id=None):
    return json.dumps({"jsonrpc": "2.0", "id": request_id,
                       "error": {"code": -32000, "message": kind}},
                      separators=(",", ":")).encode("utf-8")


def strict_json_loads(data):
    return json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))


def valid_id(value):
    return (value is None or isinstance(value, str)
            or (isinstance(value, int) and not isinstance(value, bool))
            or (isinstance(value, float) and math.isfinite(value)))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def local_opener():
    # Ignore ambient proxy settings and never forward Authorization on a redirect.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open


class Bridge:
    def __init__(self, url, service, account, token_reader=read_keychain,
                 opener=None, secret_file=None, file_reader=read_secret_file):
        self.url = validate_url(url)
        if (secret_file is None and (not service or not account)) or (secret_file is not None and (service or account)):
            raise BridgeError("invalid_request")
        self.service = service
        self.account = account
        self.token_reader = token_reader
        self.secret_file = secret_file
        self.file_reader = file_reader
        self.opener = opener if opener is not None else local_opener()
        self.token = None
        self.protocol_version = None
        self.session_id = None

    def process(self, frame):
        if len(frame) > MAX_FRAME:
            return error_frame("frame_too_large")
        try:
            message = strict_json_loads(frame)
        except (ValueError, UnicodeDecodeError):
            return error_frame("invalid_request")
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return error_frame("invalid_request")
        method = message.get("method")
        if method is not None and not isinstance(method, str):
            return error_frame("invalid_request", message.get("id"))
        request_id = message.get("id") if "id" in message else None
        if "id" in message and not valid_id(request_id):
            return error_frame("invalid_request")
        is_request = method is not None and "id" in message
        if method is None and not ("id" in message and ("result" in message or "error" in message)):
            return error_frame("invalid_request", request_id)
        try:
            if self.token is None:
                self.token = (self.file_reader(self.secret_file) if self.secret_file is not None
                              else self.token_reader(self.service, self.account))
            if not isinstance(self.token, str) or not self.token or len(self.token) > MAX_TOKEN:
                raise BridgeError("keychain_unavailable")
            headers = {
                "Authorization": "Bearer " + self.token,
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            }
            if self.protocol_version:
                headers["MCP-Protocol-Version"] = self.protocol_version
            if self.session_id:
                headers["MCP-Session-Id"] = self.session_id
            request = urllib.request.Request(self.url, data=frame, headers=headers, method="POST")
            with self.opener(request, timeout=HTTP_TIMEOUT) as response:
                if response.status == 202 and not is_request:
                    return None
                if response.status != 200:
                    raise BridgeError("upstream_http_error")
                if not is_request:
                    raise BridgeError("upstream_protocol_error")
                if response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                    raise BridgeError("upstream_protocol_error")
                body = response.read(MAX_RESPONSE + 1)
                if len(body) > MAX_RESPONSE:
                    raise BridgeError("upstream_response_too_large")
                try:
                    reply = strict_json_loads(body)
                except (ValueError, UnicodeDecodeError):
                    raise BridgeError("upstream_protocol_error") from None
                if (not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0"
                    or "id" not in reply
                    or not valid_id(reply.get("id"))
                    or reply.get("id") != request_id
                    or ("result" in reply) == ("error" in reply)):
                    raise BridgeError("upstream_protocol_error")
                if method == "initialize" and isinstance(reply.get("result"), dict):
                    version = reply["result"].get("protocolVersion")
                    if isinstance(version, str) and len(version) <= 32 and version.isascii():
                        self.protocol_version = version
                    session = response.headers.get("MCP-Session-Id")
                    if session and len(session) <= 256 and all(33 <= ord(c) <= 126 for c in session):
                        self.session_id = session
                # Re-encode to exactly one stdio frame; nested _meta stays intact.
                return json.dumps(reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except BridgeError as exc:
            kind = exc.kind
        except urllib.error.HTTPError:
            kind = "upstream_http_error"
        except (urllib.error.URLError, TimeoutError, OSError):
            kind = "upstream_unavailable"
        except (ValueError, TypeError):
            kind = "upstream_protocol_error"
        return error_frame(kind, request_id) if is_request else None


def main():
    parser = argparse.ArgumentParser(description="Whippet local MCP transport bridge")
    parser.add_argument("--url", required=True)
    parser.add_argument("--keychain-service")
    parser.add_argument("--keychain-account")
    parser.add_argument("--secret-file")
    args = parser.parse_args()
    try:
        bridge = Bridge(args.url, args.keychain_service, args.keychain_account,
                        secret_file=args.secret_file)
    except BridgeError:
        return 2
    stream = sys.stdin.buffer
    output = sys.stdout.buffer
    while True:
        frame = stream.readline(MAX_FRAME + 2)
        if not frame:
            break
        if len(frame) > MAX_FRAME + 1:
            # A long line can otherwise become several protocol frames.
            while frame and not frame.endswith(b"\n"):
                frame = stream.readline(MAX_FRAME + 2)
            result = error_frame("frame_too_large")
        else:
            result = bridge.process(frame.rstrip(b"\r\n"))
        if result is not None:
            output.write(result + b"\n")
            output.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
