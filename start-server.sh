#!/bin/bash
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${script_dir}"

# Read only GitHub credentials from the shared copilot-api environment. Do not
# inherit unrelated secrets into the Retriever process.
copilot_github_api_key=''
if [[ -f /home/ubuntu/copilot-api/.env ]]; then
	copilot_github_api_key="$(
		set +u
		set -a
		# shellcheck source=/dev/null
		source /home/ubuntu/copilot-api/.env
		printf '%s' "${GH_TOKEN:-${GITHUB_TOKEN:-${GITHUB_API_KEY:-}}}"
	)"
fi

set -a
if [[ -f .env ]]; then
	# shellcheck source=/dev/null
	source .env
fi
set +a

# The project was renamed from Omnisearch. Refuse legacy OMNISEARCH_*
# settings instead of silently dropping them, which would switch off
# controls such as spending caps. Print names only, never values.
legacy_variables="$(compgen -v OMNISEARCH_ || true)"
if [[ -n "${legacy_variables}" ]]; then
	printf 'Rename legacy settings to RETRIEVER_*: %s\n' "${legacy_variables//$'\n'/ }" >&2
	exit 1
fi

# Keep GitHub auth centralized so retriever follows the token used by
# copilot-api after rotation without inheriting its full environment.
export GITHUB_API_KEY="${copilot_github_api_key:-${GH_TOKEN:-${GITHUB_TOKEN:-${GITHUB_API_KEY:-}}}}"

# Upstream expects BRAVE_API_KEY; local .env uses BRAVE_SEARCH_API_KEY
export BRAVE_API_KEY="${BRAVE_API_KEY:-${BRAVE_SEARCH_API_KEY:-}}"

if [[ -f ./brave-key-rotation.sh ]]; then
	# shellcheck source=/dev/null
	source ./brave-key-rotation.sh
fi

: "${MCP_API_KEY:?MCP_API_KEY must be set}"
: "${PORT:=8000}"
: "${BIND_HOST:=0.0.0.0}"

# PM2 can start before Tailscale has restored its interface during boot. Wait
# briefly for an explicitly configured interface address instead of falling
# back to every network interface.
if [[ "${BIND_HOST}" != "0.0.0.0" && "${BIND_HOST}" != "::" ]]; then
	bind_ready=false
	for _ in {1..30}; do
		if ip -o address show | grep -Fq " ${BIND_HOST}/"; then
			bind_ready=true
			break
		fi
		sleep 2
	done
	if [[ "${bind_ready}" != true ]]; then
		printf 'BIND_HOST is not assigned after 60 seconds: %s\n' "${BIND_HOST}" >&2
		exit 1
	fi
fi

# The guard owns the public socket and needs an explicit bind address to
# build its Host allowlist; refusing a wildcard bind keeps the edge
# fail-closed. GUARD_PUBLIC_HOSTS names the TLS hostname Caddy forwards
# with the original Host header preserved.
if [[ "${BIND_HOST}" == "0.0.0.0" || "${BIND_HOST}" == "::" ]]; then
	printf 'BIND_HOST must be an explicit address when the guard fronts the server: %s\n' "${BIND_HOST}" >&2
	exit 1
fi
: "${GUARD_PUBLIC_HOSTS:=mcp.keiranh.cloud}"
: "${GUARD_UPSTREAM_PORT:=8002}"
GUARD_LISTEN_HOST="${BIND_HOST}"
GUARD_LISTEN_PORT="${PORT}"
GUARD_ALLOWED_HOSTS="${GUARD_ALLOWED_HOSTS:-${BIND_HOST}:${PORT},${GUARD_PUBLIC_HOSTS}}"
export GUARD_LISTEN_HOST GUARD_LISTEN_PORT GUARD_ALLOWED_HOSTS GUARD_UPSTREAM_PORT

clean_env=(
  "HOME=${HOME}"
  "PATH=${PATH}"
  "USER=${USER:-ubuntu}"
  "LANG=${LANG:-C.UTF-8}"
  "NODE_ENV=production"
)

# An explicitly empty group setting must reach the server and fail closed,
# rather than becoming an unset value that enables the default full catalog.
if [[ -v RETRIEVER_TOOL_GROUPS ]]; then
  clean_env+=("RETRIEVER_TOOL_GROUPS=${RETRIEVER_TOOL_GROUPS}")
fi

# Pass only credentials and runtime controls used by Retriever. This prevents
# PM2 or an interactive deployment shell from leaking unrelated model secrets
# into the MCP process.
for variable in \
  TAVILY_API_KEY \
  BRAVE_API_KEY \
  BRAVE_ANSWERS_API_KEY \
  GITHUB_API_KEY \
  EXA_API_KEY \
  YOU_API_KEY \
  LINKUP_API_KEY \
  CONTEXT_DEV_API_KEY \
  SEARXNG_URL \
  FIRECRAWL_API_KEY \
  FIRECRAWL_BASE_URL \
  FIRECRAWL_AGENT_URL \
  MCP_API_KEY \
  GUARD_LISTEN_HOST \
  GUARD_LISTEN_PORT \
  GUARD_ALLOWED_HOSTS \
  GUARD_UPSTREAM_PORT \
  GUARD_MAX_BODY_BYTES \
  GUARD_BODY_READ_TIMEOUT_MS \
  GUARD_MAX_CONNECTIONS \
  GUARD_MAX_INFLIGHT_REQUESTS \
  GUARD_RATE_LIMIT_REQUESTS \
  GUARD_RATE_LIMIT_WINDOW_MS \
  RETRIEVER_MAX_INFLIGHT \
  RETRIEVER_STDIO_MAX_FRAME_BYTES \
  RETRIEVER_STDIO_MAX_OUTPUT_BYTES \
  RETRIEVER_RESULT_DIR \
  RETRIEVER_RESULT_TTL_MS \
  RETRIEVER_RESULT_MAX_BYTES \
  RETRIEVER_RESULT_STORE_MAX_BYTES \
  RETRIEVER_HTTP_CACHE_BYTES \
  RETRIEVER_HTTP_CACHE_TTL_MS \
  RETRIEVER_CALL_LOG \
  RETRIEVER_SPEND_CAPS \
  RETRIEVER_PROVIDER_COOLDOWN_MS
do
  value="${!variable:-}"
  if [[ -n "${value}" ]]; then
    clean_env+=("${variable}=${value}")
  fi
done

# The guard spawns the pinned project-local mcp-proxy on loopback and the
# stdio server beneath it; PM2 keeps managing this single process.
exec env -i "${clean_env[@]}" node ./dist/guard.js
