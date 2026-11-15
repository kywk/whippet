#!/usr/bin/env python3
"""Seed only the new M10.Z isolated order fixture; never reuse the old DB."""

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import ssl
import subprocess
import urllib.error
import urllib.request
import uuid


API = "https://127.0.0.1:19989"
TARGET = "http://host.docker.internal:19988"
PG = "whippet-m10z-20261115-pg"
OUT = Path("/private/tmp/whippet-m10z-20261115-wave5")


def save_once(path: Path, value: dict) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())


def request(opener, method: str, path: str, body: dict | None = None,
            expected_status: int = 200) -> dict:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Content-Type": "application/json",
                                          "Origin": "http://127.0.0.1:19987"})
    try:
        with opener.open(req, timeout=15) as response:
            if response.status != expected_status:
                raise RuntimeError("unexpected_http_status")
            raw = response.read(1 << 20)
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raise RuntimeError("http_rejected_" + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("transport_unknown_inspect_before_retry") from None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("prepare", "run-once"))
    parser.add_argument("--ca", required=True)
    args = parser.parse_args()
    OUT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(OUT, 0o700)
    intent = OUT / "seed-intent.json"
    fixture = OUT / "business-fixture.json"
    if args.command == "prepare":
        print(json.dumps({"status": "READY" if not intent.exists() and not fixture.exists() else "ALREADY_INTENDED",
                          "postExecuted": False}))
        return
    if intent.exists() or fixture.exists():
        raise SystemExit("seed_already_intended_inspect_before_retry")
    ca = Path(args.ca)
    if not ca.is_file():
        raise SystemExit("ca_unavailable")
    context = ssl.create_default_context(cafile=str(ca))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.HTTPSHandler(context=context))
    request(opener, "GET", "/readyz")
    save_once(intent, {"kind": "W5_SEED_ONCE", "api": API, "target": TARGET,
                       "pgContainer": PG, "postExecuted": False})
    request(opener, "POST", "/api/dev-login", {})
    created = request(opener, "POST", "/api/workspaces",
                      {"name": "M10.Z new isolated order acceptance"}, 201)
    workspace_id = str(uuid.UUID(created["id"]))
    save_once(OUT / "seed-created.json", {"workspaceId": workspace_id, "postAccepted": True})
    config = {
        "name": "M10.Z new isolated order acceptance",
        "purpose": "builtin order business assertions",
        "backgroundSummary": "QA fixture: W3-OK order completed, TWD320; missing order not found.",
        "targets": [{"name": "Order lookup", "purpose": "order business assertions", "origin": TARGET}],
        "dependencies": [], "excludedOrigins": [], "exclusions": "", "loginRoles": [],
        "defaultTestUrl": TARGET, "timeoutMs": 60000,
    }
    encoded = json.dumps(config, separators=(",", ":")).replace("'", "''")
    statement = ("UPDATE workspaces SET canonical_config='" + encoded +
                 "'::jsonb,lifecycle='active',scope_status='confirmed'," +
                 "authorization_revision=authorization_revision+1 WHERE id='" + workspace_id +
                 "'::uuid RETURNING id;")
    result = subprocess.run(["docker", "exec", PG, "psql", "-X", "-q", "-U", "postgres",
                             "-v", "ON_ERROR_STOP=1", "-tAc", statement],
                            capture_output=True, text=True)
    if result.returncode != 0 or result.stdout.strip() != workspace_id:
        raise SystemExit("isolated_workspace_config_unknown_inspect_before_retry")
    save_once(fixture, {"workspaceId": workspace_id, "target": TARGET, "scopeConfirmed": True,
                        "fixtureSetup": "isolated DB canonical settings; no credential rows",
                        "businessExpected": {"orderId": "W3-OK", "total": 320,
                                             "currency": "TWD", "found": True, "status": "completed"},
                        "missingExpected": {"orderId": "MISSING", "found": False}})
    save_once(OUT / "environment.json", {"api": API, "ca": str(ca), "target": TARGET,
                                         "web": "http://127.0.0.1:19987", "postgres": PG,
                                         "managerId": "m10z-20261115", "maxWorkers": 1})
    print(json.dumps({"status": "PASS", "workspaceCreated": True,
                      "scopeConfirmed": True, "credentialRowsCreated": 0}))


if __name__ == "__main__":
    main()
