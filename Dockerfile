# Pin the multi-platform Node 22 image (includes linux/arm64).
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

# Vite+ aborts at startup when the system CA store is empty.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
# Corepack reads the packageManager pin from package.json.
RUN corepack pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN corepack pnpm run build && corepack pnpm prune --prod

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

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
