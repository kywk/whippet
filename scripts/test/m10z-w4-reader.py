#!/usr/bin/env python3
"""Read bounded M10.Z diagnostics without exposing source payloads."""

import argparse
import json
import os
from pathlib import Path
import stat
from contextlib import ExitStack
import uuid


WORKER_BASE = frozenset({
    "selfTestPassedCount", "selfTestFailedCount", "checkpointCreated",
    "checkpointPresentAtFinalize", "checkpointRetainedAfterSecretGuard",
    "terminalClass",
})
WORKER_ADDITIONS = {
    2: frozenset({"lastSelfTestFailureClass"}),
    3: frozenset({"modelRequestFailureStage"}),
    4: frozenset({"lastSelfTestFailedStepCategory", "lastSelfTestMainFrameNavigation"}),
}
MANAGER_KEYS = frozenset({
    "workerResultPresent", "workerResultValid", "workerStatus",
    "authorArtifactPresent", "authorParserChecked", "authorParserAccepted",
    "uploadAttempted", "uploadAccepted", "disposition",
})
TERMINAL = frozenset({
    "LIMIT", "INVALID_RESPONSE", "FINAL_JSON_PARSE", "FINAL_SHAPE",
    "CHECKPOINT_MISSING", "CHECKPOINT_REJECTED", "PROVIDER_FAILED",
    "TIMEOUT", "CANCELLED", "ARTIFACT_SERIALIZE_LIMIT",
    "ARTIFACT_WRITE_FAILED", "COMPLETED", "UNKNOWN",
})
FAILURE = frozenset({"INVALID_SPEC", "GUARD", "TIMEOUT", "CANCELLED", "TEST_FAILED", "UNKNOWN"})
MODEL_STAGE = frozenset({
    "UNKNOWN", "FETCH_REJECTED", "HTTP_NON_OK", "BODY_JSON_REJECTED",
    "RESPONSE_GUARD_REJECTED", "INCOMPLETE_MAX_OUTPUT_TOKENS",
    "INCOMPLETE_CONTENT_FILTER", "INCOMPLETE_UNKNOWN", "ENVELOPE_INVALID",
})
STEP_CATEGORY = frozenset({"EXPECT", "PW_API", "TEST_STEP", "OTHER", "UNOBSERVED"})
NAVIGATION = frozenset({"OBSERVED", "NOT_OBSERVED", "UNOBSERVED"})
WORKER_STATUS = frozenset({"succeeded", "failed", "cancelled", "timed_out", "interrupted", "UNKNOWN"})
DISPOSITION = frozenset({"UNKNOWN", "RESULT_INVALID", "WORKER_FAILED", "AUTHOR_REJECTED", "ACCEPTED", "UPLOAD_FAILED"})
TRANSPORT_KEYS = frozenset({
    "schemaVersion", "connectionStage", "resultSendStage", "connectionAttemptCount",
    "resultSendCount", "replayCount", "elapsedMs",
})
CONNECTION_STAGE = frozenset({
    "DIAL_START", "DIAL_FAILED", "HELLO_SENT", "HEARTBEAT_SENT", "REPLAY_START",
    "READ_LOOP", "DISCONNECTED", "UNOBSERVED",
})
SEND_STAGE = frozenset({"NOT_ATTEMPTED", "ATTEMPTED", "SENT", "FAILED", "UNOBSERVED"})


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("invalid diagnostic")
        result[key] = value
    return result


def _json_object(raw):
    if type(raw) is not bytes or not 0 < len(raw) <= 4096:
        raise ValueError("invalid diagnostic")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid diagnostic") from exc
    if type(value) is not dict:
        raise ValueError("invalid diagnostic")
    return value


def _enum(value, allowed):
    return type(value) is str and value in allowed


def _bounded_int(value, maximum):
    return type(value) is int and 0 <= value <= maximum


def decode_sidecar(raw):
    data = _json_object(raw)
    if set(data) != {"schemaVersion", "workerObserved", "worker", "manager"}:
        raise ValueError("invalid diagnostic")
    version = data["schemaVersion"]
    if type(version) is not int or version not in (1, 2, 3, 4) or type(data["workerObserved"]) is not bool:
        raise ValueError("invalid diagnostic")
    worker, manager = data["worker"], data["manager"]
    if type(worker) is not dict or type(manager) is not dict:
        raise ValueError("invalid diagnostic")
    worker_keys = set(WORKER_BASE)
    for added_version in range(2, version + 1):
        worker_keys.update(WORKER_ADDITIONS[added_version])
    if set(worker) != worker_keys or set(manager) != MANAGER_KEYS:
        raise ValueError("invalid diagnostic")
    if not all(type(worker[key]) is bool for key in (
        "checkpointCreated", "checkpointPresentAtFinalize", "checkpointRetainedAfterSecretGuard"
    )) or not all(_bounded_int(worker[key], 12) for key in ("selfTestPassedCount", "selfTestFailedCount")):
        raise ValueError("invalid diagnostic")
    if not _enum(worker["terminalClass"], TERMINAL):
        raise ValueError("invalid diagnostic")
    if version >= 2 and not _enum(worker["lastSelfTestFailureClass"], FAILURE):
        raise ValueError("invalid diagnostic")
    if version >= 3 and not _enum(worker["modelRequestFailureStage"], MODEL_STAGE):
        raise ValueError("invalid diagnostic")
    if version >= 4 and (not _enum(worker["lastSelfTestFailedStepCategory"], STEP_CATEGORY)
                         or not _enum(worker["lastSelfTestMainFrameNavigation"], NAVIGATION)):
        raise ValueError("invalid diagnostic")
    if (worker["checkpointRetainedAfterSecretGuard"] and not worker["checkpointPresentAtFinalize"]
            or worker["checkpointPresentAtFinalize"] and not worker["checkpointCreated"]):
        raise ValueError("invalid diagnostic")
    if not all(type(manager[key]) is bool for key in (
        "workerResultPresent", "workerResultValid", "authorArtifactPresent", "authorParserChecked",
        "authorParserAccepted", "uploadAttempted", "uploadAccepted"
    )) or not _enum(manager["workerStatus"], WORKER_STATUS) or not _enum(manager["disposition"], DISPOSITION):
        raise ValueError("invalid diagnostic")
    return data


def project_sidecar(sidecar):
    validated = decode_sidecar(json.dumps(sidecar, separators=(",", ":"), allow_nan=False).encode())
    version = validated["schemaVersion"]
    worker = validated["worker"]
    observed = validated["workerObserved"]
    return {
        "status": "VALIDATED" if observed else "UNOBSERVED",
        "schemaVersion": version,
        "workerObserved": observed,
        "worker": ({
            **{key: worker[key] for key in WORKER_BASE},
            "lastSelfTestFailureClass": worker.get("lastSelfTestFailureClass", "UNKNOWN"),
            "modelRequestFailureStage": worker.get("modelRequestFailureStage", "UNKNOWN"),
            "lastSelfTestFailedStepCategory": worker.get("lastSelfTestFailedStepCategory", "UNOBSERVED"),
            "lastSelfTestMainFrameNavigation": worker.get("lastSelfTestMainFrameNavigation", "UNOBSERVED"),
        } if observed else None),
        "manager": validated["manager"],
    }


def decode_transport(raw):
    data = _json_object(raw)
    if (set(data) != TRANSPORT_KEYS or type(data["schemaVersion"]) is not int
            or data["schemaVersion"] != 1
            or not _enum(data["connectionStage"], CONNECTION_STAGE)
            or not _enum(data["resultSendStage"], SEND_STAGE)
            or not all(_bounded_int(data[key], 1000000) for key in (
                "connectionAttemptCount", "resultSendCount", "replayCount"))
            or not _bounded_int(data["elapsedMs"], 2147483647)):
        raise ValueError("invalid transport")
    return data


def _read_diagnostic_file(work_dir, filename):
    path = Path(work_dir)
    if not path.is_absolute() or any(part in (".", "..", "") for part in path.parts[1:]):
        raise ValueError("invalid work directory")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    with ExitStack() as stack:
        directory = os.open("/", flags)
        stack.callback(os.close, directory)
        for part in path.parts[1:]:
            child = os.open(part, flags, dir_fd=directory)
            stack.callback(os.close, child)
            directory = child
        diagnostics = os.open("diagnostics", flags, dir_fd=directory)
        stack.callback(os.close, diagnostics)
        if stat.S_IMODE(os.fstat(diagnostics).st_mode) != 0o700:
            raise ValueError("invalid diagnostics directory")
        file_fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=diagnostics)
        stack.callback(os.close, file_fd)
        info = os.fstat(file_fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1 or not 0 < info.st_size <= 4096):
            raise ValueError("invalid diagnostic file")
        return os.read(file_fd, 4097)


def read_sidecar(work_dir, attempt_id, *, enabled=None):
    if enabled is False:
        return {"status": "DISABLED"}
    if attempt_id is None:
        return {"status": "NO_ATTEMPT"}
    try:
        if type(attempt_id) is not str or str(uuid.UUID(attempt_id)) != attempt_id:
            raise ValueError("invalid attempt")
        return project_sidecar(decode_sidecar(_read_diagnostic_file(work_dir, attempt_id + ".json")))
    except FileNotFoundError:
        return {"status": "MISSING"}
    except (OSError, ValueError, TypeError):
        return {"status": "INVALID"}


def read_transport(work_dir, *, enabled=None):
    if enabled is False:
        return {"status": "DISABLED"}
    try:
        return {"status": "VALIDATED", "value": decode_transport(
            _read_diagnostic_file(work_dir, "manager-transport.json"))}
    except FileNotFoundError:
        return {"status": "MISSING"}
    except (OSError, ValueError, TypeError):
        return {"status": "INVALID"}


class _SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("invalid arguments")


def main(argv=None):
    parser = _SafeParser(description="Read only fixed M10.Z diagnostic fields")
    commands = parser.add_subparsers(dest="kind", required=True, parser_class=_SafeParser)
    for name in ("sidecar", "transport"):
        command = commands.add_parser(name)
        command.add_argument("--work-dir", required=True)
        command.add_argument("--gate", choices=("on", "off", "unknown"), required=True)
        if name == "sidecar":
            command.add_argument("--attempt-id")
    try:
        args = parser.parse_args(argv)
        enabled = {"on": True, "off": False, "unknown": None}[args.gate]
        if args.kind == "sidecar":
            result = read_sidecar(args.work_dir, args.attempt_id, enabled=enabled)
        else:
            result = read_transport(args.work_dir, enabled=enabled)
    except ValueError:
        result = {"status": "INVALID_ARGUMENTS"}
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 2 if result["status"] in ("INVALID", "INVALID_ARGUMENTS") else 0


if __name__ == "__main__":
    raise SystemExit(main())
