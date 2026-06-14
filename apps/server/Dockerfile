# syntax=docker/dockerfile:1.7
# ─── apps/server — Bun production image ─────────────────────────────────────
#
# Multi-stage build:
#   1. `deps` resolves the workspace lockfile + installs only what the
#      server needs, using Bun's filtered install.
#   2. `runtime` carries just the resolved deps + source. No build step —
#      Bun runs TypeScript directly.
#
# Expected build context: the monorepo ROOT (where `bun.lock` + the
# workspace `package.json` live). Built via the Dockerfile builder on
# Railway (see railway.json `dockerfilePath`), or locally:
#
#   docker build -f apps/server/Dockerfile -t flicky-server .
#
# State lives in Postgres (DATABASE_URL) — the container is stateless, so
# no volume is needed. Inject env via Railway service variables (or a
# local `--env-file`); see `.env.example` for the full surface.

FROM oven/bun:1.3 AS deps
WORKDIR /app
# Copy lockfile + EVERY workspace manifest so `bun install` can resolve
# the dep graph deterministically without pulling in source. All members
# of the `apps/*` + `packages/*` workspaces must be present or the frozen
# lockfile check fails ("lockfile had changes").
COPY package.json bun.lock turbo.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/contracts/package.json apps/contracts/package.json
COPY apps/playground/package.json apps/playground/package.json
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
EXPOSE 3001
# Bun.serve handles SIGTERM cleanly via our shutdown() — see src/index.ts.
# Railway runs its own healthcheck (railway.json healthcheckPath); this
# in-image check mirrors it and honours the injected $PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["bun", "src/index.ts"]
