# syntax=docker/dockerfile:1.7
# ─── apps/web — Vite SPA build + Bun static server ──────────────────────────
#
# Multi-stage:
#   1. `build` resolves the workspace, then runs `vite build` (which loads
#      apps/web/.env.production → inlines VITE_* into the bundle).
#   2. `runtime` ships just the built `dist/` + a tiny Bun static server
#      (serve.ts) — no node_modules, no nginx.
#
# Build context = monorepo ROOT (Railway sets RAILWAY_DOCKERFILE_PATH to
# apps/web/Dockerfile). Locally:
#   docker build -f apps/web/Dockerfile -t flicky-web .

FROM oven/bun:1.3 AS build
WORKDIR /app
# Lockfile + EVERY workspace manifest so `bun install` resolves the graph
# (web pulls @workspace/ui from source).
COPY package.json bun.lock turbo.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/contracts/package.json apps/contracts/package.json
COPY apps/playground/package.json apps/playground/package.json
COPY packages/ packages/
# Full install (devDeps needed: vite, tsc, tailwind) for the web subgraph.
RUN bun install --frozen-lockfile --filter web
# App source last so dep layers stay cached. .dockerignore keeps
# node_modules / .env (secrets) / dist out of the context.
COPY apps/web/ apps/web/
RUN cd apps/web && bun run build

FROM oven/bun:1.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/apps/web/dist ./dist
COPY apps/web/serve.ts ./serve.ts
EXPOSE 8080
# Mirrors railway.json healthcheckPath=/health; serve.ts answers it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["bun", "serve.ts"]
