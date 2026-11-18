#!/usr/bin/env python3
"""Exercise the Linux installer in a temporary tree with a simulated init system."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class InstallTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != "linux":
            raise unittest.SkipTest("the installer runs on Linux")
        cls.build = tempfile.TemporaryDirectory(prefix="monitor-install-binaries-")
        cls.binaries = Path(cls.build.name)
        source = cls.binaries / "agent.c"
        source.write_text('#include <stdio.h>\n#include <string.h>\n'
                          'int main(int argc, char **argv) {\n'
                          '  puts(argc > 1 && !strcmp(argv[1], "--uninstall-protocol") ? "1" : VERSION);\n'
                          '  return 0;\n}\n')
        for version in ("old", "new"):
            subprocess.run(["cc", str(source), f'-DVERSION="{version}"',
                            "-o", str(cls.binaries / version)], check=True)
        cls.installer = (Path(__file__).resolve().parent.parent / "install.sh").read_text()

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="monitor-install-test-")
        self.addCleanup(scratch.cleanup)
        self.tree = Path(scratch.name)
        self.root = self.tree / "opt/monitor"
        self.agent_dir = self.root / "agent"
        self.agent_dir.mkdir(parents=True)
        self.entry = self.root / "monitor-agent"
        self.binary = self.agent_dir / "monitor-agent"
        self.binary.write_bytes((self.binaries / "old").read_bytes())
        self.binary.chmod(0o755)
        self.entry.symlink_to(self.binary)
        self.env_file = self.root / "agent.env"
        self.env_file.write_text("MONITOR_SERVER=https://hub.example.com\nMONITOR_TOKEN=kept-token\n")
        self.units = self.tree / "etc/systemd/system"
        self.units.mkdir(parents=True)
        (self.units / "monitor-agent.service").write_text("ExecStart=old --interval 10\n")
        for directory in ("etc/init.d", "run/systemd/system", "var/log", "bin"):
            (self.tree / directory).mkdir(parents=True)
        self.script = self.installer
        for path in ("/opt/monitor", "/etc/systemd/system", "/etc/init.d",
                     "/run/systemd/system", "/var/log"):
            self.script = self.script.replace(path, str(self.tree) + path)
        self.log = self.tree / "calls.jsonl"
        # Only OS identity and init calls are simulated. Files are really copied,
        # hard-linked and renamed by Linux, including replacements of symlinks.
        shim = self.tree / "bin/shim"
        shim.write_text('''#!/usr/bin/env python3
import json, os, signal, sys
from pathlib import Path
command = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["INSTALL_TEST_LOG"], "a") as log:
    log.write(json.dumps([command, *args]) + "\\n")
if command == "id":
    print(0)
elif command == "systemctl":
    if args[0] == "is-active" and os.environ.get("FAIL_START"):
        sys.exit(1)
elif command in ("cp", "mv"):
    if command == "cp" and args[-1].endswith("/agent-uninstall") and os.environ.get("FAIL_STAGE"):
        sys.exit(1)
    if command == "mv" and args[-1].endswith("/agent/monitor-agent") and ".install-" in args[-2]:
        if os.environ.get("FAIL_RENAME"):
            sys.exit(1)
        if os.environ.get("INTERRUPT"):
            os.kill(os.getppid(), signal.SIGTERM)
    os.execv("/bin/" + command, [command, *args])
''')
        shim.chmod(0o755)
        for name in ("id", "chown", "systemctl", "rc-service", "rc-update",
                     "userdel", "deluser", "sleep", "cp", "mv"):
            (shim.parent / name).symlink_to(shim)
        self.environment = dict(os.environ, PATH=f"{shim.parent}:{os.environ['PATH']}",
                                INSTALL_TEST_LOG=str(self.log))

    def run_install(self, **failure):
        return subprocess.run(["sh", "-s", "--", "--upgrade", "--binary", str(self.binaries / "new")],
                              input=self.script, text=True, capture_output=True,
                              env=dict(self.environment, **failure), timeout=15)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def assert_clean(self):
        self.assertEqual(list(self.root.glob(".install-*")), [])
        self.assertEqual(list(self.units.glob("*.install-*")), [])
        self.assertFalse((self.root / "monitor-agent.old").exists())

    def test_install_preserves_settings_and_separates_the_root_helper(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.entry.is_symlink())
        self.assertEqual(self.entry.read_bytes(), (self.binaries / "new").read_bytes())
        helper = self.root / "agent-uninstall"
        self.assertNotEqual(helper.stat().st_ino, self.binary.stat().st_ino)
        self.assertEqual(helper.read_bytes(), self.binary.read_bytes())
        self.assertEqual(self.env_file.stat().st_mode & 0o777, 0o600)
        self.assertIn("MONITOR_TOKEN=kept-token", self.env_file.read_text())
        self.assertIn("MONITOR_ALLOW_UPGRADE=1", self.env_file.read_text())
        self.assertIn("MONITOR_ALLOW_UNINSTALL=1", self.env_file.read_text())
        self.assertIn("--interval 10", (self.units / "monitor-agent.service").read_text())
        calls = self.calls()
        owner = next(call for call in calls if call[:2] == ["chown", "monitor-agent"])
        self.assertEqual(owner[2], str(self.agent_dir))
        self.assertTrue(owner[3].endswith("/monitor-agent"))
        self.assertNotIn(str(helper), owner)
        self.assertIn(["systemctl", "enable", "--now", "monitor-agent-uninstall.path"], calls)
        self.assert_clean()

    def test_failed_staging_does_not_stop_the_existing_agent(self):
        previous_env = self.env_file.read_bytes()
        result = self.run_install(FAIL_STAGE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(["systemctl", "stop", "monitor-agent"], self.calls())
        self.assertEqual(self.entry.read_bytes(), (self.binaries / "old").read_bytes())
        self.assertEqual(self.env_file.read_bytes(), previous_env)
        self.assert_clean()

    def test_failed_start_restores_binary_without_losing_the_self_update_path(self):
        result = self.run_install(FAIL_START="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.entry.is_symlink())
        self.assertEqual(self.entry.read_bytes(), (self.binaries / "old").read_bytes())
        self.assertEqual(self.calls().count(["systemctl", "restart", "monitor-agent"]), 2)
        self.assert_clean()

    def test_failed_rename_restores_a_legacy_direct_binary(self):
        self.entry.unlink()
        self.entry.write_bytes((self.binaries / "old").read_bytes())
        self.entry.chmod(0o755)
        result = self.run_install(FAIL_RENAME="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.entry.is_symlink())
        self.assertEqual(self.entry.read_bytes(), (self.binaries / "old").read_bytes())
        self.assertIn(["systemctl", "restart", "monitor-agent"], self.calls())
        self.assert_clean()

    def test_termination_during_replacement_still_finishes_startup(self):
        result = self.run_install(INTERRUPT="1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.entry.read_bytes(), (self.binaries / "new").read_bytes())
        self.assertIn(["systemctl", "is-active", "--quiet", "monitor-agent"], self.calls())
        self.assert_clean()


if __name__ == "__main__":
    unittest.main()
