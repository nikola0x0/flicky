# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Flicky is a Tinder-style PvP prediction-duel built on Sui + DeepBook Predict. Two players swipe YES/NO through a 5-card binary-digital deck; a Move `Duel` shared object escrows stakes and pays the winner. See `README.md` for full game design, scoring rules, and Predict touchpoints — that file is authoritative for protocol-level decisions.

## Stack

Bun workspaces + Turborepo monorepo.

- `apps/web` — Vite + React 19 + Tailwind v4 + shadcn/ui. Swipe UI, lockup view.
- `apps/server` — Bun runtime (`Bun.serve`). WebSocket relay, settled-redeem keeper, sponsored-gas service, Deckmaster (seed-based deck engine, no LLM), ranked MMR + leaderboard, avatar service. No infra deps beyond the `@mysten/*` SDK family — uses `Bun.*` APIs directly (including `Bun.sql` for Postgres, no ORM).
- `packages/ui` (`@workspace/ui`) — shared shadcn components, hooks, lib utils, and `globals.css`.
- `apps/contracts` — Move package for the `Duel` object, escrow, scoring, plus standalone `season` (prize-pool escrow) and `swap` (AMM) side-packages, and TS deploy/upgrade/codegen scripts.

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

- **Player-signed swipe PTBs are atomic.** Each swipe is a single PTB that mints on the player's own Predict account and calls `duel::record_swipe` on the shared `Duel` in the same transaction. Forced by Predict's requirement that the sender own the account being minted from — don't try to route mint through the keeper.
- **`Duel` shared object does NOT hold Predict positions.** Each player owns their own Predict account (an `AccountWrapper`, commonly called their "manager"); the `Duel` escrows the dUSDC side-pot and records swipes (direction + the mint's `order_id`, for anti-replay). Settlement reads scores from `record_swipe` data plus keeper-supplied settlement data, not from positions.
- **Two tiers share one engine.** Free/Social tier runs the exact same swipe + lockup + settlement flow as Staked, only with the Predict mint and the dUSDC stake removed. Don't fork the code paths — gate the money flow, keep the engine.
- **Sponsored gas end-to-end.** Player zkLogin wallets only ever hold dUSDC. Any new PTB the player signs (create_duel, join_duel, per-swipe, settle) must go through the sponsored-gas service in `apps/server`.
- **Commit-reveal deck.** Cards are hashed at duel creation, revealed at match start. Don't expose the unrevealed deck through the WebSocket relay or anywhere else before reveal time.
- **Settlement is keeper-fed, not on-chain-read.** The DeepBook Predict deployment Flicky is pinned to (`predict-testnet-6-24`) doesn't expose on-chain reads for market price or premium. `settle_card` takes the settlement price and both players' premiums as keeper-supplied arguments (sourced from Predict's off-chain indexer), not from an oracle object read inside the swipe PTB. Scoring is `card_pnl = payout − premium`, summed per player across the deck — there's no on-chain probability snapshot and no speed multiplier. This pin has moved before (it used to be `predict-testnet-4-16`); if a stub call starts failing, check whether upstream changed what it exposes again before assuming a local bug.

## Code style

- Prettier: no semicolons, double quotes, 2-space, trailing comma `es5`, print width 80. Tailwind plugin runs `cn` / `cva` through class-sorting and uses `packages/ui/src/styles/globals.css` as the source.
- TypeScript `strict: true` everywhere; `moduleResolution: bundler`, `target: ES2022`.
- Server is ESM (`"type": "module"`) and runs directly via `bun --hot src/index.ts` — no bundling in dev. Prefer `Bun.*` APIs over Node shims.
- ESLint configs are per-workspace flat configs. `packages/ui` intentionally omits `eslint-plugin-react-refresh` (it's a library, not a Vite app) — don't add it back when wiring new shadcn components, because most shadcn files export variants alongside the component and would trip `react-refresh/only-export-components`.
