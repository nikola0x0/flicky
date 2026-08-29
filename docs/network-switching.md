# Network switching (testnet ⇄ mainnet)

One deployed app, one backend, two chains. Testnet is the default; the settings
menu (gear → menu) has a network picker.

## The constraint

**DeepBook Predict has no mainnet deployment.** The pinned
`predict-testnet-6-24` is testnet-only, and Mysten has mainnet slated for later
in 2026 with contracts that may still change.

Everything on the money path reads from it — the staked-tier mint, Deckmaster's
market discovery, the oracle stream, and the keeper's settlement prices all go
through `predict-server-beta.testnet.mystenlabs.com`. There is also no mainnet
dUSDC (a testnet faucet token), and the flicky / swap / season Move packages
have only ever been published to testnet.

So mainnet today is a **gated preview**:

| Works on mainnet | Gated on mainnet |
| --- | --- |
| Wallet connect (zkLogin + extensions) | `/game/pvp` |
| SUI balance | `/game/practice` |
| Profile, avatars, chat | `/game/play/:duelId` |
| Leaderboard (ranks empty — no mainnet duels) | `/game/shop` (swap AMM) |

The gate is not a hardcoded flag. `DUELS_ENABLED` in
`apps/web/src/lib/config.ts` is derived from whether the network's Predict and
flicky package ids actually resolve, so supplying the `_MAINNET` vars is what
turns it off.

## Env convention

`_MAINNET` suffix. There is no `_PROD`.

| Network | Web | Server |
| --- | --- | --- |
| testnet (default) | `VITE_FOO`, or `VITE_FOO_TESTNET` | `FOO`, or `FOO_TESTNET` |
| mainnet | `VITE_FOO_MAINNET` | `FOO_MAINNET` |

Resolution, per key:

- **mainnet** → `FOO_MAINNET` → unset. **Never** falls back to a testnet value.
  That fallback is precisely how a mainnet PTB ends up targeting a testnet
  package, or how the sponsor allowlists one.
- **testnet** → `FOO` → `FOO_TESTNET` → baked-in default.

`apps/server/src/network-env.ts` also accepts a few historical spellings
(`DEEPBOOK_PREDICT_PACKAGE_ID` ↔ `DEEPBOOK_PREDICT_PACKAGE`, likewise
`ACCOUNT_PACKAGE`, `SWAP_PACKAGE`, `FLICKY_PACKAGE`), because the `_MAINNET`
names were already documented without the `_ID` while the testnet names carry
it. Both resolve.

## How switching works

`apps/web/src/lib/network.ts` resolves the active network **once** at module
load: `localStorage` → `VITE_SUI_NETWORK` → `testnet`. `CONFIG`, the dApp Kit
client, the GraphQL client, and the WS socket are all pinned to it for the life
of the page.

`setNetwork(n)` persists the choice and calls `location.reload()`. That is
deliberate: a live switch would have to tear down the wallet session, the
react-query cache, the WS socket, and any in-flight duel — all of which are
network-bound and wrong to carry across a switch.

`VITE_SUI_NETWORKS` controls which networks the picker offers. Set it to
`testnet` alone and the picker doesn't render.

The picker lives in `components/network-setting.tsx` and is rendered by
`components/menu-modal.tsx`. Its active row carries the `no-hover` class from
`globals.css` — `.pixel-tile:hover` still matches a *disabled* button, so
without it the current network lights up with the white selection outline as
if it were clickable.

## Server: one process, every network

There is one `flicky-server` service serving all networks — no second Railway
environment, no second deploy.

- `SUI_NETWORK` — the **default** network (unchanged meaning).
- `SUI_NETWORKS` — comma-separated list the process will serve. Defaults to
  just the default network, so mainnet is an explicit opt-in.
- `networkEnv(net)` (`apps/server/src/network-env.ts`) resolves chain-scoped
  config. `env` spreads the default network's slice, so existing `env.foo` call
  sites are unchanged.
- `getSuiClient(net)` / `getGraphQLClient(net)` are per-network maps.
- Read endpoints take `?network=`. Unknown or not-enabled → `400
  unknown_network`. Predict-backed endpoints on a network without Predict →
  `503 network_unavailable`.
- `POST /sponsor` takes `network` in the body and resolves that network's
  sponsor key **and** MoveCall allowlist. A network whose packages aren't
  configured returns 503 rather than a partial allowlist — see below.
- `GET /health` reports a per-network block so a deploy can be verified without
  guessing what the `_MAINNET` vars produced.

### Sponsor safety

The allowlist is the only thing between the public `POST /sponsor` route and an
attacker draining the sponsor's balance through unrelated MoveCalls. Every
resolver in `apps/server/src/sponsor.ts` **throws** when a network's package is
unconfigured. That is load-bearing: a missing id must fail the request, never
widen it. Do not add a fallback.

The signing key may be the same on both chains, but its **address balance must
be funded separately on each** — on mainnet that is real SUI. An unfunded
balance surfaces as an opaque `Invalid withdraw reservation` on every request.

## Flip checklist — when Predict ships to mainnet

1. **Publish the Move packages to mainnet.**
   `SUI_NETWORK=mainnet bun --filter @flicky/contracts publish` (plus `swap`
   and `season`). `publish.ts` already writes a `[published.mainnet]` block and
   a `VITE_FLICKY_PACKAGE_ID_MAINNET` key — but `deployed.json` is
   single-network and needs to become per-network first.
2. **Fill the `_MAINNET` vars** in `apps/web/.env.production` and on the
   `flicky-server` Railway service (see both `.env.example` files for the full
   list). The web gate turns itself off once
   `VITE_DEEPBOOK_PREDICT_PACKAGE_ID_MAINNET` and
   `VITE_FLICKY_PACKAGE_ID_MAINNET` are set.
3. **Fund the sponsor and keeper address balances on mainnet** with real SUI
   (`bun --filter server fund:sponsor`).
4. **Server work that is NOT config** — this is the real remaining task:
   - Per-network `Keeper` and `DuelIndexer` instances. Today both run on the
     default network only (`apps/server/src/index.ts`), and each network needs
     its own event cursor and a separately funded keeper key.
   - Network-partitioned matchmaking queues and rooms in
     `apps/server/src/ws/matchmaking.ts`. Right now `queues` is keyed by tier
     alone, so with two live networks a testnet player could be matched with a
     mainnet one.
   - Widen `player_rating`'s PRIMARY KEY from `address` to
     `(address, network)` and update `upsertRating`'s `ON CONFLICT` target. The
     `network` column already exists and reads are already scoped; only the key
     is outstanding, and it's a live-data migration.

## Database

`duel` and `player_rating` carry `network TEXT NOT NULL DEFAULT 'testnet'`
(idempotent `ADD COLUMN IF NOT EXISTS`, so it's a pure add — every existing row
is testnet). Reads are scoped by network; `upsertDuel` stamps it explicitly and
never updates it, since a duel object lives on exactly one chain.
