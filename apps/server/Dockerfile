# syntax=docker/dockerfile:1.7
# ─── apps/server — Bun production image ─────────────────────────────────────
#
# Multi-stage build:
#   1. `deps` resolves the workspace lockfile + installs only what the
#      server needs, using Bun's filtered install.
#   2. `runtime` carries just the resolved deps + source + the SQLite
#      data dir. No build step — Bun runs TypeScript directly.
#
# Expected build context: the monorepo ROOT (where `bun.lock` + the
# workspace `package.json` live). The image is published via:
#
#   docker build -f apps/server/Dockerfile -t flicky-server .
#
# At runtime, mount a volume on `/app/apps/server/.data` so the SQLite
# DB + deckmaster plaintext store survive restarts, and inject env vars
# via `--env-file` or `-e` (see `.env.example` for the full surface).

FROM oven/bun:1.3 AS deps
WORKDIR /app
# Copy lockfile + every workspace manifest so `bun install` can resolve
# the dep graph deterministically without pulling in source.
COPY package.json bun.lock turbo.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/ packages/
RUN bun install --frozen-lockfile --production --filter server

FROM oven/bun:1.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
# Copy installed deps + the server source. Other workspaces aren't
# needed at runtime (turbo only orchestrates build-time).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY apps/server/ ./apps/server/
COPY apps/contracts/deployed.json ./apps/contracts/deployed.json
WORKDIR /app/apps/server
# Pre-create the data dir so first boot doesn't race the SQLite open.
RUN mkdir -p .data
EXPOSE 3001
# Bun.serve handles SIGTERM cleanly via our shutdown() — see src/index.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["bun", "src/index.ts"]
