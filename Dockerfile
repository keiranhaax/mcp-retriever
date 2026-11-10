# Pin the multi-platform Node 26 image (includes linux/arm64).
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build

# Vite+ aborts at startup when the system CA store is empty.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node 26 does not bundle Corepack. Fetch pnpm 11.9.0 from the npm
# registry, pinned by the tarball's SHA-256.
ADD --checksum=sha256:2b567aa66026238078ac2e0a33bec3febd60e962987aac697456f3180819b287 \
    https://registry.npmjs.org/pnpm/-/pnpm-11.9.0.tgz /tmp/pnpm.tgz
RUN mkdir /opt/pnpm \
    && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1 \
    && rm /tmp/pnpm.tgz \
    && ln -s /opt/pnpm/bin/pnpm.mjs /usr/local/bin/pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm 11 switches to, and downloads, the version packageManager
# names, so `pnpm --version` cannot detect drift. This guard reads the
# version from the unpacked tarball's package.json with node, without
# running pnpm, and fails unless packageManager names exactly it.
# pmOnFail=error keeps every later pnpm step on the pinned release:
# pnpm exits on a version mismatch instead of fetching another one.
RUN node -e ' \
    const pinned = "pnpm@" + require("/opt/pnpm/package.json").version; \
    const wanted = require("./package.json").packageManager; \
    if (wanted !== pinned) { \
        console.error(`packageManager is ${wanted}, the Dockerfile pins ${pinned}`); \
        process.exit(1); \
    }'
ENV pnpm_config_pm_on_fail=error
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY docker/requirements.txt /tmp/mcpo-requirements.txt
RUN python3 -m venv /opt/mcpo \
    && /opt/mcpo/bin/pip install --no-cache-dir -r /tmp/mcpo-requirements.txt \
    && /opt/mcpo/bin/pip check \
    && /opt/mcpo/bin/python -c 'from mcpo.main import run' \
    && rm /tmp/mcpo-requirements.txt

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/start.py ./docker/start.py

ENV PATH="/opt/mcpo/bin:${PATH}" \
    NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MCPO_HOST=0.0.0.0
USER node
EXPOSE 8000

# Authentication and provider configuration come only from runtime environment.
CMD ["python3", "/app/docker/start.py"]
