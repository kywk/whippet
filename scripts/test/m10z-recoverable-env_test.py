#!/usr/bin/env python3
"""Offline contract checks for the restartable M10.Z environment recipe."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("m10z-recoverable-env.py")
spec = importlib.util.spec_from_file_location("m10z_recoverable_env", SCRIPT)
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


class RecoverableEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / "m10z-20261115"
        self.binary = self.base / "server-input"
        self.binary.write_bytes(b"synthetic server binary")
        self.expected = recipe.sha256(self.binary)

    @staticmethod
    def fake_tls(root):
        (root / "qa.crt").write_bytes(b"synthetic certificate")
        (root / "qa.key").write_bytes(b"synthetic private key")
        (root / "qa.crt").chmod(0o600)
        (root / "qa.key").chmod(0o600)

    def test_red_create_then_restart_keeps_identity_and_pin(self):
        with patch.object(recipe, "generate_tls", self.fake_tls):
            recipe.create_state(self.state, self.binary, self.expected)
        first = {name: (self.state / name).read_bytes() for name in
                 ("vault-key", "manager-token", "target-credentials.json", "qa.crt", "qa.key")}
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        for name in (*first, "manager.env", "pg-password"):
            self.assertEqual((self.state / name).stat().st_mode & 0o777, 0o600)
        for path in (self.state / "skills").rglob("*"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700 if path.is_dir() else 0o600)
        with self.assertRaises(recipe.RecipeError):
            recipe.create_state(self.state, self.binary, self.expected)
        config = recipe.load_state(self.state)
        self.assertEqual(config["serverSha256"], self.expected)
        self.assertEqual({name: (self.state / name).read_bytes() for name in first}, first)

    def test_red_manager_launch_uses_env_file_and_candidate_ids(self):
        with patch.object(recipe, "generate_tls", self.fake_tls):
            recipe.create_state(self.state, self.binary, self.expected)
        token = (self.state / "manager-token").read_text().strip()
        args = recipe.manager_run_args(self.state, "/synthetic/docker.sock", None)
        self.assertIn("--env-file", args)
        self.assertIn(str(self.state / "manager.env"), args)
        self.assertEqual(args[-1], recipe.MANAGER_IMAGE)
        self.assertNotIn(token, " ".join(args))
        self.assertIn("WORKER_IMAGE=" + recipe.WORKER_IMAGE,
                      (self.state / "manager.env").read_text())
        self.assertEqual(json.loads((self.state / "state.json").read_text())["managerImage"],
                         recipe.MANAGER_IMAGE)
        identity = recipe.sha256(self.state / "manager.env")
        self.assertIn("whippet.qa.manager-identity=" + identity, args)
        self.assertIn("whippet.qa.worker-image=" + recipe.WORKER_IMAGE, args)
        self.assertNotIn(token, " ".join(args))

    def test_red_existing_manager_rejects_different_identity(self):
        with patch.object(recipe, "generate_tls", self.fake_tls):
            recipe.create_state(self.state, self.binary, self.expected)
        mounts = [{"Type": "bind", "Source": str(self.state / name),
                   "Destination": str(self.state / name)} for name in ("work", "qa.crt")]
        with patch.object(recipe, "_container", return_value=(recipe.MANAGER_IMAGE, True)), \
                patch.object(recipe, "_mounts", return_value=mounts), \
                patch.object(recipe, "docker", return_value="wrong|" + recipe.WORKER_IMAGE):
            with self.assertRaises(recipe.RecipeError):
                recipe._manager(self.state, None)

    def test_existing_postgres_rejects_wrong_volume_before_reuse(self):
        with patch.object(recipe, "_container", return_value=("synthetic", True)), \
                patch.object(recipe, "_ensure_volume"), \
                patch.object(recipe, "_mounts", return_value=[]):
            with self.assertRaises(recipe.RecipeError):
                recipe._postgres(self.state)

    def test_red_rejects_tampered_pin_or_private_file_mode(self):
        with patch.object(recipe, "generate_tls", self.fake_tls):
            recipe.create_state(self.state, self.binary, self.expected)
        (self.state / "server.bin").write_bytes(b"changed")
        with self.assertRaises(recipe.RecipeError):
            recipe.load_state(self.state)
        (self.state / "server.bin").write_bytes(self.binary.read_bytes())
        (self.state / "vault-key").chmod(0o644)
        with self.assertRaises(recipe.RecipeError):
            recipe.load_state(self.state)


if __name__ == "__main__":
    unittest.main()
