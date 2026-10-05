"""Validate Compose with an isolated, synthetic .env (never the checkout's)."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent


class ComposeTests(unittest.TestCase):
    def compose_config(self, env_text):
        with tempfile.TemporaryDirectory(prefix="retriever-compose-") as directory:
            root = Path(directory)
            shutil.copyfile(ROOT / "docker-compose.yml", root / "docker-compose.yml")
            (root / ".env").write_text(env_text)
            return subprocess.run(
                ["docker", "compose", "--project-directory", str(root), "--env-file", str(root / ".env"), "-f", str(root / "docker-compose.yml"), "config", "--format", "json"],
                env={"PATH": os.defpath},
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )

    def test_compose_refuses_missing_authentication(self):
        for env_text in ("", "MCP_API_KEY=\n"):
            with self.subTest(env_text=env_text):
                result = self.compose_config(env_text)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("MCP_API_KEY", result.stderr)

    def test_compose_injects_dotenv_and_binds_loopback(self):
        result = self.compose_config("MCP_API_KEY=fixture-proxy-token\nYOU_API_KEY='fixture-$dollar-\"quote\"-\\slash'\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        service = json.loads(result.stdout)["services"]["mcp-retriever"]
        self.assertEqual(service["environment"]["MCP_API_KEY"], "fixture-proxy-token")
        # Compose config re-escapes dollars for reuse as Compose input.
        # docker/compose v2.35.1 cmd/compose/config.go: escapeDollarSign.
        value = service["environment"]["YOU_API_KEY"].replace("$$", "$")
        self.assertEqual(value, 'fixture-$dollar-"quote"-\\slash')
        self.assertEqual(service["environment"]["MCPO_HOST"], "0.0.0.0")
        self.assertEqual(service["environment"]["PORT"], "8000")
        self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(service["ports"][0]["published"], "8000")
        self.assertEqual(service["ports"][0]["target"], 8000)

    def test_compose_port_override_stays_in_sync(self):
        result = self.compose_config("MCP_API_KEY=fixture-proxy-token\nPORT=8123\nMCPO_BIND_HOST=127.0.0.2\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        service = json.loads(result.stdout)["services"]["mcp-retriever"]
        self.assertEqual(service["environment"]["PORT"], "8123")
        self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.2")
        self.assertEqual(service["ports"][0]["published"], "8123")
        self.assertEqual(service["ports"][0]["target"], 8123)


if __name__ == "__main__":
    unittest.main()
