"""Run the pinned MCPO without putting its API key on the command line."""

import asyncio
import json
import os
from pathlib import Path
import tempfile


PROVIDER_ENV = (
    "BRAVE_API_KEY",
    "BRAVE_ANSWERS_API_KEY",
    "TAVILY_API_KEY",
    "GITHUB_API_KEY",
    "EXA_API_KEY",
    "YOU_API_KEY",
    "LINKUP_API_KEY",
    "CONTEXT_DEV_API_KEY",
    "FIRECRAWL_API_KEY",
    "FIRECRAWL_BASE_URL",
    "FIRECRAWL_AGENT_URL",
    "RETRIEVER_RESULT_DIR",
    "RETRIEVER_RESULT_TTL_MS",
    "RETRIEVER_RESULT_MAX_BYTES",
    "RETRIEVER_RESULT_STORE_MAX_BYTES",
)


def main():
    api_key = os.environ.pop("MCP_API_KEY", "")
    if not api_key.strip():
        raise SystemExit("MCP_API_KEY must be set to a non-blank value")

    try:
        port = int(os.environ.get("PORT", "8000"))
        if not 1 <= port <= 65535:
            raise ValueError
    except ValueError:
        raise SystemExit("PORT must be an integer from 1 to 65535") from None

    config = {
        "mcpServers": {
            "retriever": {
                "command": "node",
                "args": [str(Path(__file__).resolve().parent.parent / "dist/index.js")],
                "env": {key: os.environ[key] for key in PROVIDER_ENV if key in os.environ},
            }
        }
    }
    # mcpo 0.0.20 has no native environment binding for --api-key.
    # Its Python entry point keeps the key out of argv and the JSON file.
    from mcpo.main import run

    with tempfile.TemporaryDirectory(prefix="retriever-mcpo-") as directory:
        config_path = Path(directory) / "config.json"
        with config_path.open("x", encoding="utf-8") as file:
            os.chmod(config_path, 0o600)
            json.dump(config, file)
        asyncio.run(
            run(
                host=os.environ.get("MCPO_HOST", "127.0.0.1"),
                port=port,
                api_key=api_key,
                strict_auth=True,
                cors_allow_origins=[f"http://127.0.0.1:{port}"],
                config_path=str(config_path),
            )
        )


if __name__ == "__main__":
    main()
