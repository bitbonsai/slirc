import copy
import importlib.util
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy_app", Path(__file__).with_name("deploy-app.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()
        (self.root / "env").touch(mode=0o600)
        (self.root / "ergo.yaml").touch()
        (self.root / "irc-key").write_bytes(b"k" * 32)
        patcher = patch.dict(module.os.environ, {"SLIRC_IRC_KEY_PATH": str(self.root / "irc-key")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.args = SimpleNamespace(checkout=str(self.root), config_dir=str(self.root), app="app-target", ergo="ergo-target",
            volume="app-data", api_volume="api-data", network="target-net", ergo_host="10.0.0.2", app_ip="10.0.0.14", origin="https://app.example.test", port=9010)
        self.old_id, self.ergo_id, self.migration_id = "a" * 64, "e" * 64, "b" * 64
        self.app = {"Id": self.old_id, "Name": "app-target", "Image": "old-image", "State": {"Running": True, "Paused": False},
            "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
            "Config": {"Env": ["APP_ORIGIN=https://app.example.test", "DB_PATH=/data/chat.sqlite", "ERGO_HOST=10.0.0.2", "ERGO_PORT=6667"],
                "Labels": {"com.docker.compose.project": "app-target", "com.docker.compose.service": "app"}},
            "Mounts": [{"Name": "app-data", "Destination": "/data", "RW": True}, {"Name": "api-data", "Destination": "/run/secrets", "RW": False}],
            "NetworkSettings": {"Networks": {"target-net": {}}}}
        self.ergo = {"Id": self.ergo_id, "Name": "ergo-target", "State": {"Running": True, "StartedAt": "same-start"},
            "Mounts": [{"Source": str(self.root / "ergo.yaml"), "Destination": "/ircd/ircd.yaml"}],
            "NetworkSettings": {"Networks": {"target-net": {"IPAddress": "10.0.0.2"}}}}
        self.calls = []
        self.checkpoint = None
        self.fail_proof = False
        self.extra_writer = False
        self.resumed_at_checkpoint = False

    def test_legacy_host_origin_matches_and_wrong_host_is_rejected(self):
        self.app["Config"]["Env"][0] = "APP_HOST=app.example.test"
        module.check_target(self.app, self.ergo, self.args)
        self.app["Config"]["Env"][0] = "APP_HOST=wrong.example.test"
        with self.assertRaisesRegex(AssertionError, "App origin mismatch"):
            module.check_target(self.app, self.ergo, self.args)
        self.app["Config"]["Env"].pop(0)
        with self.assertRaisesRegex(AssertionError, "App origin mismatch"):
            module.check_target(self.app, self.ergo, self.args)

    def inspect(self, target):
        if target in (self.old_id, "app-target"):
            return copy.deepcopy(self.app)
        if target in (self.ergo_id, "ergo-target"):
            return copy.deepcopy(self.ergo)
        raise AssertionError("Unexpected inspection")

    def fake_run(self, *args, **kwargs):
        self.calls.append(args)
        stdout = ""
        if args[0] == "git":
            stdout = "" if "status" in args else "c" * 40
        elif args[:2] == ("podman", "update"):
            self.app["HostConfig"]["RestartPolicy"]["Name"] = args[2].split("=", 1)[1]
        elif args[:2] == ("podman", "stop"):
            self.app["State"]["Running"] = False
        elif args[:2] == ("podman", "start"):
            self.app["State"]["Running"] = True
        elif args[:2] == ("podman", "ps"):
            stdout = self.old_id if self.app["State"]["Running"] or self.extra_writer else ""
        elif args[:2] == ("podman", "create"):
            self.assertFalse(self.app["State"]["Running"])
            self.assertIn(f"APP_ORIGIN={self.args.origin}", args)
            self.checkpoint = Path(next(arg.split(":")[0] for arg in args if ":/run/dm-upgrade:" in arg))
            self.assertEqual((self.checkpoint / "stopped").read_text(), self.old_id)
            stdout = self.migration_id
        elif args[0] == "podman-compose":
            self.assertTrue(self.committed)
            self.assertIn("--no-build", args)
            self.assertEqual(args[args.index("-p") + 1], self.args.app)
            self.assertEqual(kwargs["env"]["SLIRC_APP_IMAGE"], "localhost/slirc-app:" + "c" * 40)
            self.assertEqual(kwargs["env"]["SLIRC_APP_IP"], "10.0.0.14")
            self.assertEqual(kwargs["env"]["SLIRC_IRC_KEY_PATH"], str(self.root / "irc-key"))
            self.assertEqual([Path(arg).name for arg in args if arg.endswith(".compose.yaml")],
                             ["app.compose.yaml", "app.fixed-ip.compose.yaml"])
        return subprocess.CompletedProcess(args, 0, stdout)

    def popen(self, args):
        self.assertEqual(args[-1], self.migration_id)
        owner = self
        class Process:
            returncode = None
            def poll(self):
                if owner.fail_proof:
                    self.returncode = 1
                elif (owner.checkpoint / "commit").exists():
                    owner.committed = True
                    self.returncode = 0
                else:
                    (owner.checkpoint / "ready").write_text(owner.old_id)
                    if owner.resumed_at_checkpoint:
                        owner.app["State"]["Running"] = True
                return self.returncode
        return Process()

    def execute(self):
        self.committed = False
        with patch.object(module, "inspect", self.inspect), patch.object(module, "run", self.fake_run), \
             patch.object(module.subprocess, "Popen", self.popen), patch.object(module.time, "sleep"):
            module.deploy(self.args)

    def test_success_builds_artifact_then_stops_app_then_checks_runtime_and_commits_before_recreation(self):
        self.execute()
        commands = [call[:2] for call in self.calls]
        self.assertLess(commands.index(("podman", "run")), commands.index(("podman", "stop")))
        self.assertLess(commands.index(("podman", "stop")), commands.index(("podman", "create")))
        self.assertTrue(self.committed)
        self.assertTrue(any(call[0] == "podman-compose" for call in self.calls))
        self.assertFalse(any(call[:2] == ("podman", "stop") and call[-1] == self.ergo_id for call in self.calls))

    def test_unresolved_proof_resumes_same_old_container_and_policy_without_compose(self):
        self.fail_proof = True
        with self.assertRaisesRegex(AssertionError, "verification failed"):
            self.execute()
        self.assertTrue(self.app["State"]["Running"])
        self.assertEqual(self.app["HostConfig"]["RestartPolicy"]["Name"], "unless-stopped")
        self.assertFalse(self.committed)
        self.assertFalse(any(call[0] == "podman-compose" for call in self.calls))
        self.assertIn(("podman", "start", self.old_id), self.calls)
        self.assertNotIn(("podman", "rm", "--force", self.old_id), self.calls)

    def test_runtime_recheck_refuses_resumed_writer_and_cleans_migration(self):
        self.resumed_at_checkpoint = True
        with self.assertRaisesRegex(AssertionError, "not stopped"):
            self.execute()
        self.assertFalse(self.committed)
        self.assertIn(("podman", "rm", "--force", self.migration_id), self.calls)
        self.assertTrue(self.app["State"]["Running"])

    def test_other_writer_blocks_before_migration(self):
        self.extra_writer = True
        with self.assertRaisesRegex(AssertionError, "Another running container"):
            self.execute()
        self.assertIsNone(self.checkpoint)
        self.assertTrue(self.app["State"]["Running"])

    def test_missing_image_script_aborts_before_pause(self):
        original = self.fake_run
        def missing(*args, **kwargs):
            if args[:2] == ("podman", "run"):
                raise subprocess.CalledProcessError(1, args)
            return original(*args, **kwargs)
        self.fake_run = missing
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute()
        self.assertTrue(self.app["State"]["Running"])
        self.assertFalse(any(call[:2] == ("podman", "stop") for call in self.calls))

    def test_app_address_equal_to_ergo_is_rejected(self):
        self.args.app_ip = self.args.ergo_host
        with self.assertRaisesRegex(AssertionError, "differ from Ergo"):
            module.check_target(self.app, self.ergo, self.args)

    def test_wrong_profile_or_mount_fails_before_pause(self):
        for change in (lambda: self.app["Config"]["Env"].append("SLIRC_DEV_PROFILE=slirc2"),
                       lambda: self.app["Mounts"][0].update(Name="wrong-data"),
                       lambda: self.ergo["Mounts"][0].update(Source="/wrong/config")):
            app, ergo = copy.deepcopy(self.app), copy.deepcopy(self.ergo)
            change()
            with self.assertRaises(AssertionError):
                self.execute()
            self.assertFalse(any(call[:2] == ("podman", "stop") for call in self.calls))
            self.app, self.ergo = app, ergo


if __name__ == "__main__":
    unittest.main()
