#!/usr/bin/env python3
"""Independent, synthetic v1-v4 reader contract probe; no service or DB access."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/test/m10z-w4-reader.py"
OUT = Path("/private/tmp/whippet-m10z-20261115-wave4/odd")
OUT.mkdir(mode=0o700, parents=True, exist_ok=True)

spec = importlib.util.spec_from_file_location("m10z_w4_odd_reader", SOURCE)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

WORKER = {
    "selfTestPassedCount": 0,
    "selfTestFailedCount": 1,
    "checkpointCreated": False,
    "checkpointPresentAtFinalize": False,
    "checkpointRetainedAfterSecretGuard": False,
    "terminalClass": "UNKNOWN",
}
MANAGER = {
    "workerResultPresent": True,
    "workerResultValid": True,
    "authorArtifactPresent": False,
    "authorParserChecked": False,
    "authorParserAccepted": False,
    "uploadAttempted": False,
    "uploadAccepted": False,
    "workerStatus": "failed",
    "disposition": "WORKER_FAILED",
}
STEP_CATEGORIES = ("EXPECT", "PW_API", "TEST_STEP", "OTHER", "UNOBSERVED")
NAVIGATIONS = ("OBSERVED", "NOT_OBSERVED", "UNOBSERVED")
CONNECTION_STAGES = (
    "DIAL_START", "DIAL_FAILED", "HELLO_SENT", "HEARTBEAT_SENT",
    "REPLAY_START", "READ_LOOP", "DISCONNECTED", "UNOBSERVED",
)
RESULT_SEND_STAGES = ("NOT_ATTEMPTED", "ATTEMPTED", "SENT", "FAILED", "UNOBSERVED")
TRANSPORT = {
    "schemaVersion": 1,
    "connectionStage": "READ_LOOP",
    "resultSendStage": "SENT",
    "connectionAttemptCount": 1,
    "resultSendCount": 1,
    "replayCount": 0,
    "elapsedMs": 12,
}


def payload(version):
    worker = dict(WORKER)
    if version >= 2:
        worker["lastSelfTestFailureClass"] = "TEST_FAILED"
    if version >= 3:
        worker["modelRequestFailureStage"] = "UNKNOWN"
    if version >= 4:
        worker["lastSelfTestFailedStepCategory"] = "EXPECT"
        worker["lastSelfTestMainFrameNavigation"] = "OBSERVED"
    return {
        "schemaVersion": version,
        "workerObserved": True,
        "worker": worker,
        "manager": dict(MANAGER),
    }


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def accepts(raw):
    try:
        return reader.decode_sidecar(raw)
    except Exception:
        return None


def accepts_transport(raw):
    try:
        return reader.decode_transport(raw)
    except Exception:
        return None


checks = {}
for version in (1, 2, 3, 4):
    result = accepts(encoded(payload(version)))
    checks[f"legacyV{version}Accepted" if version < 4 else "v4Accepted"] = (
        isinstance(result, dict) and result == payload(version)
    )

checks["v4AllFixedEnumsAccepted"] = all(
    accepts(encoded({**payload(4), "worker": {
        **payload(4)["worker"],
        "lastSelfTestFailedStepCategory": step,
        "lastSelfTestMainFrameNavigation": navigation,
    }})) is not None
    for step in STEP_CATEGORIES for navigation in NAVIGATIONS
)

invalid = {}
mixed = payload(3)
mixed["worker"]["lastSelfTestFailedStepCategory"] = "EXPECT"
invalid["v3MixedVersionRejected"] = encoded(mixed)
mixed = payload(4)
del mixed["worker"]["modelRequestFailureStage"]
invalid["v4MissingLegacyFieldRejected"] = encoded(mixed)
for field in ("lastSelfTestFailedStepCategory", "lastSelfTestMainFrameNavigation"):
    for value, label in ((None, "Null"), ("FREE_TEXT", "UnknownEnum"), (False, "Boolean")):
        sample = payload(4)
        sample["worker"][field] = value
        invalid[f"{field}{label}Rejected"] = encoded(sample)
    sample = payload(4)
    del sample["worker"][field]
    invalid[f"{field}MissingRejected"] = encoded(sample)
sample = payload(4)
sample["worker"]["unexpected"] = True
invalid["v4UnknownWorkerFieldRejected"] = encoded(sample)
sample = payload(4)
sample["unexpected"] = True
invalid["v4UnknownOuterFieldRejected"] = encoded(sample)
sample = payload(4)
sample["manager"]["unexpected"] = True
invalid["v4UnknownManagerFieldRejected"] = encoded(sample)
sample = payload(4)
sample["workerObserved"] = None
invalid["v4NullObservedRejected"] = encoded(sample)
sample = payload(4)
sample["worker"]["selfTestFailedCount"] = True
invalid["v4BooleanCountRejected"] = encoded(sample)
raw = encoded(payload(4))
invalid["v4DuplicateOuterRejected"] = raw.replace(b'"schemaVersion":4,', b'"schemaVersion":4,"schemaVersion":4,', 1)
invalid["v4DuplicateWorkerRejected"] = raw.replace(b'"lastSelfTestFailedStepCategory":"EXPECT",', b'"lastSelfTestFailedStepCategory":"EXPECT","lastSelfTestFailedStepCategory":"EXPECT",', 1)
invalid["v4OversizeRejected"] = raw + b" " * (4097 - len(raw))
invalid["v4InvalidUtf8Rejected"] = raw + b"\xff"
for version in (1, 2, 3, 4):
    sample = payload(version)
    sample["worker"]["unexpected"] = True
    invalid[f"v{version}ExtraWorkerRejected"] = encoded(sample)
    sample = payload(version)
    del sample["worker"]["terminalClass"]
    invalid[f"v{version}MissingWorkerRejected"] = encoded(sample)
    sample = payload(version)
    sample["worker"]["terminalClass"] = None
    invalid[f"v{version}NullWorkerRejected"] = encoded(sample)
    sample = payload(version)
    sample["worker"]["terminalClass"] = "FREE_TEXT"
    invalid[f"v{version}UnknownTerminalRejected"] = encoded(sample)
    sample = payload(version)
    sample["manager"]["disposition"] = "FREE_TEXT"
    invalid[f"v{version}UnknownDispositionRejected"] = encoded(sample)
    version_raw = encoded(payload(version))
    invalid[f"v{version}DuplicateRootRejected"] = version_raw.replace(
        f'"schemaVersion":{version},'.encode(),
        f'"schemaVersion":{version},"schemaVersion":{version},'.encode(), 1)
    invalid[f"v{version}DuplicateManagerRejected"] = version_raw.replace(
        b'"disposition":"WORKER_FAILED"',
        b'"disposition":"WORKER_FAILED","disposition":"WORKER_FAILED"', 1)
    if version < 4:
        sample = payload(version + 1)
        sample["schemaVersion"] = version
        invalid[f"v{version}MixedNextVersionRejected"] = encoded(sample)
sample = payload(4)
sample["workerObserved"] = False
sample["worker"]["lastSelfTestFailedStepCategory"] = "FREE_TEXT"
invalid["v4UnobservedStillValidatedRejected"] = encoded(sample)
for name, value in invalid.items():
    checks[name] = accepts(value) is None

checks["transportValidAccepted"] = accepts_transport(encoded(TRANSPORT)) == TRANSPORT
checks["transportAllFixedEnumsAccepted"] = all(
    accepts_transport(encoded({**TRANSPORT, "connectionStage": connection, "resultSendStage": send})) is not None
    for connection in CONNECTION_STAGES for send in RESULT_SEND_STAGES
)
checks["transportIntegerBoundsAccepted"] = all(
    accepts_transport(encoded({**TRANSPORT, **values})) is not None
    for values in (
        {"connectionAttemptCount": 0, "resultSendCount": 0, "replayCount": 0, "elapsedMs": 0},
        {"connectionAttemptCount": 1000000, "resultSendCount": 1000000,
         "replayCount": 1000000, "elapsedMs": 2147483647},
    )
)
transport_invalid = {}
for field in TRANSPORT:
    sample = dict(TRANSPORT)
    del sample[field]
    transport_invalid[f"transportMissing{field}Rejected"] = encoded(sample)
    sample = dict(TRANSPORT)
    sample[field] = None
    transport_invalid[f"transportNull{field}Rejected"] = encoded(sample)
for field in ("connectionStage", "resultSendStage"):
    sample = dict(TRANSPORT)
    sample[field] = "FREE_TEXT"
    transport_invalid[f"transportUnknown{field}Rejected"] = encoded(sample)
for field, maximum in (("connectionAttemptCount", 1000000), ("resultSendCount", 1000000),
                       ("replayCount", 1000000), ("elapsedMs", 2147483647)):
    for value, label in ((-1, "Negative"), (maximum + 1, "Overflow"), (True, "Boolean"), (1.5, "Fraction")):
        sample = dict(TRANSPORT)
        sample[field] = value
        transport_invalid[f"transport{field}{label}Rejected"] = encoded(sample)
sample = dict(TRANSPORT)
sample["unexpected"] = False
transport_invalid["transportUnknownFieldRejected"] = encoded(sample)
sample = dict(TRANSPORT)
sample["schemaVersion"] = 2
transport_invalid["transportUnknownVersionRejected"] = encoded(sample)
transport_raw = encoded(TRANSPORT)
transport_invalid["transportDuplicateRejected"] = transport_raw.replace(
    b'"schemaVersion":1,', b'"schemaVersion":1,"schemaVersion":1,', 1)
transport_invalid["transportOversizeRejected"] = transport_raw + b" " * (4097 - len(transport_raw))
transport_invalid["transportInvalidUtf8Rejected"] = transport_raw + b"\xff"
for name, value in transport_invalid.items():
    checks[name] = accepts_transport(value) is None

# Exercise the public file reader with only synthetic files inside this QA's own directory.
work_dir = OUT / "reader-fixtures" / "work"
diagnostics = work_dir / "diagnostics"
diagnostics.mkdir(mode=0o700, parents=True, exist_ok=True)
diagnostics.chmod(0o700)


def read_attempt(attempt, *, enabled=True, directory=work_dir):
    try:
        return reader.read_sidecar(directory, attempt, enabled=enabled)
    except Exception:
        return {}


attempts = {
    "validV1": "00000000-0000-4000-8000-000000000001",
    "validV4": "00000000-0000-4000-8000-000000000004",
    "unobservedV4": "00000000-0000-4000-8000-000000000009",
    "invalidV4": "00000000-0000-4000-8000-000000000005",
    "oversize": "00000000-0000-4000-8000-000000000006",
    "symlink": "00000000-0000-4000-8000-000000000007",
    "missing": "00000000-0000-4000-8000-000000000008",
}


def write_fixture(name, raw):
    path = diagnostics / (attempts[name] + ".json")
    with path.open("wb") as stream:
        stream.write(raw)
    path.chmod(0o600)
    return path


write_fixture("validV1", encoded(payload(1)))
write_fixture("validV4", encoded(payload(4)))
unobserved = payload(4)
unobserved["workerObserved"] = False
write_fixture("unobservedV4", encoded(unobserved))
write_fixture("invalidV4", invalid["lastSelfTestFailedStepCategoryUnknownEnumRejected"])
write_fixture("oversize", invalid["v4OversizeRejected"])
link = diagnostics / (attempts["symlink"] + ".json")
if link.exists() or link.is_symlink():
    link.unlink()
link.symlink_to(diagnostics / (attempts["validV4"] + ".json"))

v1 = read_attempt(attempts["validV1"])
v4 = read_attempt(attempts["validV4"])
checks["fileV1Validated"] = v1.get("status") == "VALIDATED"
checks["fileV4Validated"] = v4.get("status") == "VALIDATED"
checks["fileV4NewFieldsProjected"] = (
    isinstance(v4.get("worker"), dict)
    and v4["worker"].get("lastSelfTestFailedStepCategory") == "EXPECT"
    and v4["worker"].get("lastSelfTestMainFrameNavigation") == "OBSERVED"
)
checks["fileV1NewFieldsUnobserved"] = (
    isinstance(v1.get("worker"), dict)
    and v1["worker"].get("lastSelfTestFailedStepCategory") == "UNOBSERVED"
    and v1["worker"].get("lastSelfTestMainFrameNavigation") == "UNOBSERVED"
)
checks["fileV4UnobservedDistinct"] = (
    read_attempt(attempts["unobservedV4"]).get("status") == "UNOBSERVED"
    and read_attempt(attempts["unobservedV4"]).get("worker") is None
)
checks["fileInvalidV4Closed"] = read_attempt(attempts["invalidV4"]).get("status") == "INVALID"
checks["fileOversizeClosed"] = read_attempt(attempts["oversize"]).get("status") == "INVALID"
checks["fileSymlinkClosed"] = read_attempt(attempts["symlink"]).get("status") == "INVALID"
checks["fileMissingDistinct"] = read_attempt(attempts["missing"]).get("status") == "MISSING"
checks["noAttemptDistinct"] = read_attempt(None).get("status") == "NO_ATTEMPT"
checks["disabledDistinct"] = read_attempt(attempts["missing"], enabled=False).get("status") == "DISABLED"
checks["invalidAttemptClosed"] = read_attempt("../escape").get("status") == "INVALID"
checks["missingDirectoryClosed"] = read_attempt(attempts["validV4"], directory=OUT / "absent").get("status") != "VALIDATED"

transport_path = diagnostics / "manager-transport.json"


def write_transport(raw):
    with transport_path.open("wb") as stream:
        stream.write(raw)
    transport_path.chmod(0o600)


def read_transport(*, enabled=True, directory=work_dir):
    try:
        return reader.read_transport(directory, enabled=enabled)
    except Exception:
        return {}


write_transport(transport_raw)
transport_result = read_transport()
checks["transportFileValidated"] = (
    transport_result.get("status") == "VALIDATED" and transport_result.get("value") == TRANSPORT
)
checks["transportDisabledDistinct"] = read_transport(enabled=False).get("status") == "DISABLED"
write_transport(transport_invalid["transportUnknownconnectionStageRejected"])
checks["transportFileUnknownEnumClosed"] = read_transport().get("status") == "INVALID"
write_transport(transport_invalid["transportOversizeRejected"])
checks["transportFileOversizeClosed"] = read_transport().get("status") == "INVALID"
transport_path.unlink()
checks["transportFileMissingDistinct"] = read_transport().get("status") == "MISSING"
transport_target = diagnostics / "transport-target.json"
with transport_target.open("wb") as stream:
    stream.write(transport_raw)
transport_target.chmod(0o600)
transport_path.symlink_to(transport_target)
checks["transportFileNoFollow"] = read_transport().get("status") == "INVALID"
transport_path.unlink()
transport_target.unlink()
write_transport(transport_raw)
linked_work = OUT / "reader-linked-work"
if linked_work.exists() or linked_work.is_symlink():
    linked_work.unlink()
linked_work.symlink_to(work_dir, target_is_directory=True)
checks["transportParentNoFollow"] = read_transport(directory=linked_work).get("status") == "INVALID"
linked_work.unlink()
transport_path.chmod(0o644)
checks["transportModeClosed"] = read_transport().get("status") == "INVALID"
transport_path.chmod(0o600)
diagnostics.chmod(0o755)
checks["transportDirectoryModeClosed"] = read_transport().get("status") == "INVALID"
diagnostics.chmod(0o700)
hardlink = diagnostics / "manager-transport-hardlink.json"
if hardlink.exists():
    hardlink.unlink()
os.link(transport_path, hardlink)
checks["transportHardlinkClosed"] = read_transport().get("status") == "INVALID"
hardlink.unlink()

report = {
    "schemaVersion": 1,
    "kind": "M10Z_W4_ODD_READER",
    "command": "python3 scripts/test/m10z-w4-odd-qa.py",
    "status": "PASS" if all(checks.values()) else "FAIL",
    "checks": checks,
    "passCount": sum(checks.values()),
    "failCount": len(checks) - sum(checks.values()),
    "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    "qaScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "modelCalls": 0,
    "dockerCalls": 0,
    "dbCalls": 0,
    "gitCalls": 0,
    "secretReads": 0,
    "envReads": 0,
    "productWrites": 0,
}
stage = "green" if report["status"] == "PASS" else "red"
(OUT / f"reader-{stage}.json").write_text(json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n")
print(json.dumps({
    "status": report["status"],
    "passCount": report["passCount"],
    "failCount": report["failCount"],
    "failedChecks": [name for name, passed in checks.items() if not passed],
    "sourceSha256": report["sourceSha256"],
}, sort_keys=True, separators=(",", ":")))
raise SystemExit(0 if report["status"] == "PASS" else 1)
