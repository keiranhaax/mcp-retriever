"""Credential-free checks for the Docker/MCPO launcher."""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

import start


LAUNCHER = Path(__file__).with_name("start.py")


class LauncherTests(unittest.TestCase):
    def test_missing_api_key_fails_before_importing_mcpo(self):
        for value in (None, "", " \t\n"):
            with self.subTest(value=value):
                env = {"PATH": os.defpath}
                if value is not None:
                    env["MCP_API_KEY"] = value
                result = subprocess.run(
                    [sys.executable, str(LAUNCHER)],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertEqual(
                    result.stderr.strip(),
                    "MCP_API_KEY must be set to a non-blank value",
                )

    def test_invalid_port_fails_before_importing_mcpo(self):
        for port in ("0", "65536", "not-a-port", "", "-1", "80.5"):
            with self.subTest(port=port):
                result = subprocess.run(
                    [sys.executable, str(LAUNCHER)],
                    env={"PATH": os.defpath, "MCP_API_KEY": "fixture-token", "PORT": port},
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr.strip(), "PORT must be an integer from 1 to 65535")

    def test_explicit_binding_and_port_with_error_cleanup(self):
        paths = []
        mcpo_main = types.ModuleType("mcpo.main")

        async def fail_run(**kwargs):
            self.assertEqual(kwargs["host"], "0.0.0.0")
            self.assertEqual(kwargs["port"], 8123)
            self.assertEqual(kwargs["cors_allow_origins"], ["http://127.0.0.1:8123"])
            paths.append(Path(kwargs["config_path"]))
            raise RuntimeError("fixture startup failure")

        setattr(mcpo_main, "run", fail_run)
        with patch.dict(os.environ, {"MCP_API_KEY": "fixture-token", "MCPO_HOST": "0.0.0.0", "PORT": "8123"}, clear=True), patch.dict(
            sys.modules, {"mcpo": types.ModuleType("mcpo"), "mcpo.main": mcpo_main}
        ):
            with self.assertRaisesRegex(RuntimeError, "fixture startup failure"):
                start.main()
        self.assertEqual(len(paths), 1)
        self.assertFalse(paths[0].parent.exists())

    def test_private_config_round_trips_provider_values(self):
        api_key = "fixture-proxy-token"
        provider_value = 'fixture-"quoted"\\value\n$NOT_EXPANDED=✓'
        env = {
            "MCP_API_KEY": api_key,
            "YOU_API_KEY": provider_value,
            "FIRECRAWL_BASE_URL": "http://127.0.0.1:9999/v2",
            "RETRIEVER_RESULT_DIR": "/tmp/fixture-results",
            "RETRIEVER_RESULT_MAX_BYTES": "4096",
        }
        config_paths = []
        mcpo_main = types.ModuleType("mcpo.main")

        async def inspect_run(**kwargs):
            self.assertEqual(kwargs["api_key"], api_key)
            self.assertTrue(kwargs["strict_auth"])
            self.assertEqual(kwargs.get("host"), "127.0.0.1")
            self.assertEqual(kwargs["port"], 8000)
            self.assertEqual(kwargs["cors_allow_origins"], ["http://127.0.0.1:8000"])
            self.assertNotIn("MCP_API_KEY", os.environ)
            path = Path(kwargs["config_path"])
            config_paths.append(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            config = json.loads(path.read_text())
            self.assertEqual(list(config["mcpServers"]), ["retriever"])
            server = config["mcpServers"]["retriever"]
            self.assertEqual(server["command"], "node")
            self.assertEqual(server["args"], [str(LAUNCHER.resolve().parent.parent / "dist/index.js")])
            self.assertEqual(server["env"], {k: v for k, v in env.items() if k != "MCP_API_KEY"})
            self.assertNotIn(api_key, path.read_text())

        mcpo_main.run = inspect_run
        with patch.dict(os.environ, env, clear=True), patch.dict(
            sys.modules, {"mcpo": types.ModuleType("mcpo"), "mcpo.main": mcpo_main}
        ):
            start.main()
        self.assertEqual(len(config_paths), 1)
        self.assertFalse(config_paths[0].parent.exists())


if __name__ == "__main__":
    unittest.main()
