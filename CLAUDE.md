# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Flicky is a Tinder-style PvP prediction-duel built on Sui + DeepBook Predict. Two players swipe YES/NO through a 5-card binary-digital deck; a Move `Duel` shared object escrows stakes and pays the winner. See `README.md` for full game design, scoring rules, and Predict touchpoints — that file is authoritative for protocol-level decisions.

## Stack

Bun workspaces + Turborepo monorepo.

- `apps/web` — Vite + React 19 + Tailwind v4 + shadcn/ui. Swipe UI, lockup view.
- `apps/server` — Bun runtime (`Bun.serve`). WebSocket relay, settled-redeem keeper, sponsored-gas service, AI Deckmaster. No deps yet — uses `Bun.*` APIs directly.
- `packages/ui` (`@workspace/ui`) — shared shadcn components, hooks, lib utils, and `globals.css`.
- `move/` — Move package for `Duel` object, escrow, scoring (not yet present; TBD).

## Commands

Always use `bun` (≥ 1.3), never `npm`/`pnpm`/`yarn`. Workspace is `packageManager: bun@1.3.9`.

```bash
bun install                  # install all workspaces
bun dev                      # turbo dev — runs web + server in parallel
bun --filter web dev         # web only (Vite, default :5173)
bun --filter server dev      # server only (Bun --hot, default :3001)

bun typecheck                # turbo typecheck (tsc --noEmit per workspace)
bun lint                     # turbo lint (eslint per workspace)
bun format                   # prettier write
bun build                    # turbo build
```

No test runner is wired up yet.

## Adding shadcn components

Components live in `packages/ui/src/components` and are imported via `@workspace/ui/components/<name>`. To add one:

```bash
bunx --bun shadcn@latest add <component> -c apps/web
```

The shadcn CLI is configured in `apps/web/components.json` to install into the shared `@workspace/ui` package (not into the web app's local `src/components`), and to use the shared `packages/ui/src/styles/globals.css` Tailwind stylesheet. The `radix-luma` style and `neutral` base color are fixed — don't change them ad hoc.

Web-app-local components go in `apps/web/src/components` and are imported via the `@/components/...` alias (configured in `apps/web/vite.config.ts`).

## Architectural constraints from README

These are load-bearing design decisions — preserve them when implementing:

- **Player-signed swipe PTBs are atomic.** Each swipe is a single PTB that calls `predict::mint` on the player's own `PredictManager` and `duel::record_swipe` on the shared `Duel` in the same transaction. Forced by Predict's `sender == manager.owner()` invariant — don't try to route mint through the keeper.
- **`Duel` shared object does NOT hold Predict positions.** Each player owns their `PredictManager`; the `Duel` escrows the dUSDC side-pot and records swipes (direction + snapshotted `p_swiped` + decide-time). Settlement reads scores from `record_swipe` data, not from positions.
- **Two tiers share one engine.** Free/Social tier runs the exact same swipe + lockup + settlement flow as Staked, only with `predict::mint` and the dUSDC stake removed. Don't fork the code paths — gate the money flow, keep the engine.
- **Sponsored gas end-to-end.** Player zkLogin wallets only ever hold dUSDC. Any new PTB the player signs (create_duel, join_duel, per-swipe, settle) must go through the sponsored-gas service in `apps/server`.
- **Commit-reveal deck.** Cards are hashed at duel creation, revealed at match start. Don't expose the unrevealed deck through the WebSocket relay or anywhere else before reveal time.
- **`p_swiped` is snapshotted at swipe time.** Scoring uses `1 / p_swiped × speed_multiplier`. The snapshot must come from Predict's SVI surface inside the swipe PTB, not a later read.

## Code style

- Prettier: no semicolons, double quotes, 2-space, trailing comma `es5`, print width 80. Tailwind plugin runs `cn` / `cva` through class-sorting and uses `packages/ui/src/styles/globals.css` as the source.
- TypeScript `strict: true` everywhere; `moduleResolution: bundler`, `target: ES2022`.
- Server is ESM (`"type": "module"`) and runs directly via `bun --hot src/index.ts` — no bundling in dev. Prefer `Bun.*` APIs over Node shims.
- ESLint configs are per-workspace flat configs. `packages/ui` intentionally omits `eslint-plugin-react-refresh` (it's a library, not a Vite app) — don't add it back when wiring new shadcn components, because most shadcn files export variants alongside the component and would trip `react-refresh/only-export-components`.
