#!/usr/bin/env python3
"""Contract tests for the read-only Wave4 sidecar/transport reader."""

import importlib.util
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("m10z-w4-reader.py")
spec = importlib.util.spec_from_file_location("m10z_w4_reader", SCRIPT)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def sidecar(version=4, observed=True):
    worker = {
        "selfTestPassedCount": 0,
        "selfTestFailedCount": 1,
        "checkpointCreated": False,
        "checkpointPresentAtFinalize": False,
        "checkpointRetainedAfterSecretGuard": False,
        "terminalClass": "LIMIT",
    }
    if version >= 2:
        worker["lastSelfTestFailureClass"] = "TEST_FAILED"
    if version >= 3:
        worker["modelRequestFailureStage"] = "UNKNOWN"
    if version >= 4:
        worker["lastSelfTestFailedStepCategory"] = "EXPECT"
        worker["lastSelfTestMainFrameNavigation"] = "OBSERVED"
    manager = {
        "workerResultPresent": True,
        "workerResultValid": True,
        "workerStatus": "failed",
        "authorArtifactPresent": False,
        "authorParserChecked": False,
        "authorParserAccepted": False,
        "uploadAttempted": False,
        "uploadAccepted": False,
        "disposition": "WORKER_FAILED",
    }
    return {"schemaVersion": version, "workerObserved": observed,
            "worker": worker, "manager": manager}


class ReaderContractTest(unittest.TestCase):
    def test_v4_sidecar_projects_only_bounded_fields(self):
        result = reader.project_sidecar(reader.decode_sidecar(json.dumps(sidecar()).encode()))
        self.assertEqual(result["status"], "VALIDATED")
        self.assertEqual(result["schemaVersion"], 4)
        self.assertEqual(result["worker"]["lastSelfTestFailedStepCategory"], "EXPECT")
        self.assertEqual(result["worker"]["lastSelfTestMainFrameNavigation"], "OBSERVED")
        self.assertEqual(result["manager"]["disposition"], "WORKER_FAILED")

    def test_transport_accepts_exact_snapshot(self):
        raw = json.dumps({
            "schemaVersion": 1,
            "connectionStage": "READ_LOOP",
            "resultSendStage": "SENT",
            "connectionAttemptCount": 2,
            "resultSendCount": 3,
            "replayCount": 1,
            "elapsedMs": 1234,
        }).encode()
        result = reader.decode_transport(raw)
        self.assertEqual(result["connectionStage"], "READ_LOOP")
        self.assertEqual(result["resultSendCount"], 3)

    def test_sidecar_read_keeps_disabled_missing_and_unobserved_distinct(self):
        attempt = "00000000-0000-4000-8000-000000000001"
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            work = Path(directory)
            self.assertEqual(reader.read_sidecar(work, attempt, enabled=False)["status"], "DISABLED")
            self.assertEqual(reader.read_sidecar(work, attempt, enabled=True)["status"], "MISSING")
            diagnostics = work / "diagnostics"
            diagnostics.mkdir(mode=0o700)
            path = diagnostics / (attempt + ".json")
            path.write_bytes(json.dumps(sidecar(observed=False)).encode())
            path.chmod(0o600)
            result = reader.read_sidecar(work, attempt, enabled=True)
            self.assertEqual(result["status"], "UNOBSERVED")
            self.assertIsNone(result["worker"])
            self.assertEqual(result["manager"]["disposition"], "WORKER_FAILED")
            path.write_bytes(json.dumps(sidecar()).encode())
            result = reader.read_sidecar(work, attempt, enabled=True)
            self.assertEqual(result["status"], "VALIDATED")
            self.assertEqual(result["worker"]["lastSelfTestFailedStepCategory"], "EXPECT")
            path.write_bytes(json.dumps(sidecar(1)).encode())
            result = reader.read_sidecar(work, attempt, enabled=True)
            self.assertEqual(result["status"], "VALIDATED")
            self.assertEqual(result["worker"]["lastSelfTestFailedStepCategory"], "UNOBSERVED")

    def test_connection_snapshot_file_read_is_independent_of_sidecar(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            work = Path(directory)
            self.assertEqual(reader.read_transport(work, enabled=False)["status"], "DISABLED")
            self.assertEqual(reader.read_transport(work, enabled=True)["status"], "MISSING")
            diagnostics = work / "diagnostics"
            diagnostics.mkdir(mode=0o700)
            path = diagnostics / "manager-transport.json"
            path.write_bytes(json.dumps({
                "schemaVersion": 1, "connectionStage": "DISCONNECTED",
                "resultSendStage": "SENT", "connectionAttemptCount": 2,
                "resultSendCount": 3, "replayCount": 1, "elapsedMs": 42,
            }).encode())
            path.chmod(0o600)
            result = reader.read_transport(work, enabled=True)
            self.assertEqual(result["status"], "VALIDATED")
            self.assertEqual(result["value"]["connectionStage"], "DISCONNECTED")
            self.assertEqual(result["value"]["replayCount"], 1)

    def test_projection_rejects_mutated_or_unknown_input(self):
        validated = reader.decode_sidecar(json.dumps(sidecar()).encode())
        validated["worker"]["secret"] = "SENTINEL"
        validated["manager"]["secret"] = "SENTINEL"
        with self.assertRaises(ValueError):
            reader.project_sidecar(validated)
        del validated["worker"]["secret"]
        del validated["manager"]["secret"]
        validated["worker"]["terminalClass"] = "SENTINEL"
        with self.assertRaises(ValueError):
            reader.project_sidecar(validated)

    def test_legacy_shapes_remain_exact_and_new_projection_is_unobserved(self):
        for version in (1, 2, 3, 4):
            with self.subTest(version=version):
                source = sidecar(version)
                decoded = reader.decode_sidecar(json.dumps(source).encode())
                self.assertEqual(decoded, source)
                projected = reader.project_sidecar(decoded)
                self.assertEqual(projected["worker"]["lastSelfTestFailedStepCategory"],
                                 "EXPECT" if version == 4 else "UNOBSERVED")
                self.assertEqual(projected["worker"]["lastSelfTestMainFrameNavigation"],
                                 "OBSERVED" if version == 4 else "UNOBSERVED")
                self.assertEqual(projected["worker"]["lastSelfTestFailureClass"],
                                 "UNKNOWN" if version == 1 else "TEST_FAILED")
                self.assertEqual(projected["worker"]["modelRequestFailureStage"], "UNKNOWN")
                source["worker"]["lastSelfTestFailedStepCategory"] = "EXPECT"
                if version < 4:
                    with self.assertRaises(ValueError):
                        reader.decode_sidecar(json.dumps(source).encode())

    def test_sidecar_rejects_duplicate_null_unknown_mixed_enum_and_size(self):
        source = sidecar()
        samples = []
        for target, key, value in (
            ("top", "workerObserved", None),
            ("worker", "lastSelfTestFailedStepCategory", "FREE_TEXT"),
            ("worker", "lastSelfTestMainFrameNavigation", None),
            ("worker", "selfTestPassedCount", True),
            ("worker", "terminalClass", "SECRET_SENTINEL"),
            ("manager", "disposition", "SECRET_SENTINEL"),
            ("worker", "unexpected", "SECRET_SENTINEL"),
            ("manager", "unexpected", "SECRET_SENTINEL"),
        ):
            sample = json.loads(json.dumps(source))
            (sample if target == "top" else sample[target])[key] = value
            samples.append(json.dumps(sample).encode())
        samples.extend((
            json.dumps(source).encode().replace(b'"schemaVersion": 4,', b'"schemaVersion": 4, "schemaVersion": 4,', 1),
            json.dumps(source).encode().replace(b'"lastSelfTestFailedStepCategory": "EXPECT",',
                                                b'"lastSelfTestFailedStepCategory": "EXPECT", "lastSelfTestFailedStepCategory": "EXPECT",', 1),
            json.dumps(source).encode() + b" " * 4097,
            json.dumps(source).encode() + b"\xff",
            json.dumps(source).encode("utf-16"),
        ))
        missing = json.loads(json.dumps(source))
        del missing["worker"]["modelRequestFailureStage"]
        samples.append(json.dumps(missing).encode())
        for index, raw in enumerate(samples):
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    reader.decode_sidecar(raw)

    def test_connection_snapshot_rejects_duplicate_null_enum_and_count_bounds(self):
        source = {
            "schemaVersion": 1, "connectionStage": "READ_LOOP", "resultSendStage": "SENT",
            "connectionAttemptCount": 1, "resultSendCount": 2, "replayCount": 0, "elapsedMs": 10,
        }
        samples = []
        for key, value in (
            ("schemaVersion", True), ("connectionStage", None),
            ("resultSendStage", "ACKED"), ("connectionAttemptCount", -1),
            ("resultSendCount", 1000001), ("replayCount", 1.5),
            ("elapsedMs", 2147483648), ("unexpected", "SECRET_SENTINEL"),
        ):
            sample = dict(source)
            sample[key] = value
            samples.append(json.dumps(sample).encode())
        samples.extend((
            json.dumps(source).encode().replace(b'"schemaVersion": 1,', b'"schemaVersion": 1, "schemaVersion": 1,', 1),
            json.dumps(source).encode() + b" " * 4097,
        ))
        for index, raw in enumerate(samples):
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    reader.decode_transport(raw)

    def test_nofollow_and_size_fail_closed_without_exposing_content(self):
        attempt = "00000000-0000-4000-8000-000000000004"
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            work = Path(directory) / "work"
            work.mkdir()
            diagnostics = work / "diagnostics"
            diagnostics.mkdir(mode=0o700)
            valid = diagnostics / (attempt + ".json")
            valid.write_bytes(json.dumps(sidecar()).encode())
            valid.chmod(0o600)
            link = diagnostics / "manager-transport.json"
            link.symlink_to(valid)
            self.assertEqual(reader.read_transport(work, enabled=True), {"status": "INVALID"})
            valid.write_bytes(b"SECRET_SENTINEL" + b"x" * 4097)
            self.assertEqual(reader.read_sidecar(work, attempt, enabled=True), {"status": "INVALID"})
            link.unlink()
            diagnostics.rename(work / "diagnostics-real")
            diagnostics.symlink_to(work / "diagnostics-real")
            self.assertEqual(reader.read_sidecar(work, attempt, enabled=True), {"status": "INVALID"})

    def test_cli_projects_v3_without_dumping_source_or_paths(self):
        attempt = "00000000-0000-4000-8000-000000000003"
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            work = Path(directory)
            diagnostics = work / "diagnostics"
            diagnostics.mkdir(mode=0o700)
            path = diagnostics / (attempt + ".json")
            path.write_bytes(json.dumps(sidecar(3)).encode())
            path.chmod(0o600)
            output = io.StringIO()
            with redirect_stdout(output):
                code = reader.main(["sidecar", "--work-dir", str(work),
                                    "--attempt-id", attempt, "--gate", "on"])
            self.assertEqual(code, 0)
            projected = json.loads(output.getvalue())
            self.assertEqual(projected["status"], "VALIDATED")
            self.assertEqual(projected["worker"]["lastSelfTestFailedStepCategory"], "UNOBSERVED")
            self.assertNotIn(str(work), output.getvalue())
            self.assertNotIn(attempt, output.getvalue())


if __name__ == "__main__":
    unittest.main()
