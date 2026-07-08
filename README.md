# Terrace

**A serverless World Cup watch-party: your crew shares one room, calls the match together,
reads every message in their own language, and throws into a shared group-tip pot — no
server, no operator, no house.**

Terrace is a peer-to-peer watch-party app. A group of friends spins up a room with no
backend at all, locks in their match predictions, and chats live while the game plays.
Because every message is translated **on each person's own device**, a crowd from different
countries can share the *same* room and each read it in their own language. And when they
feel like it, friends can chip an equal amount of USDt into a shared **group-tip pool** —
a friendly pot among themselves, held by a contract, split at the final whistle among
whoever called the result right.

Money is one feature near the end, not the point. The point is the room.

## How this fits the theme

This maps Terrace's features onto the brief's own vocabulary — it's for judges, and it's a
checklist that every theme hook is genuinely hit (with where each one is proven):

| Theme hook (brief's words) | In Terrace | Proven by |
|---|---|---|
| **Watch-party app** | A serverless P2P room (Pears: Hyperswarm + Autobase) — no backend, share a `pear://`-style room key to join | `npm run room:test` (two peers sync) |
| **Match predictors** | Each fan locks a prediction into the shared multi-writer room; everyone sees everyone's calls | prediction entries in `room.getState()` |
| **Peer-to-peer fan messaging** | Live chat linearized across all peers over Autobase — no server relays it | `npm run room:test` |
| **Group-tipping** | Friends chip equal USDt into one self-custodial pool; correct predictors split it. No house, no operator, no cut | `npm run stake:e2e` + 8 contract tests |
| **Global-tournament moment** | Fans of different nations share ONE room, each reading it in **their own language**, all inference **on-device** (QVAC) | `npm run translate:demo` |

All three Tether tracks — **Pears** (the room), **WDK** (the wallet + group-tip pool),
**QVAC** (on-device translation) — are used for real, which is the Cup Champion (all-three)
leg.

## The group-tip pool is friends among themselves

This is deliberate, and it's what keeps Terrace on the **tipping** side of the line rather
than just renaming things:

- **No house, no operator, no middleman.** Nobody runs the pot as a business or takes a
  cut. Everyone chips the *same* amount of the *same* token into one shared contract.
- **No market, no line.** There is no price and no payout multiplier stacked in anyone's
  favor. When the match ends, whoever predicted the result right splits the whole pot
  **proportionally to what they put in**. It's a friendly pot among friends, not a market
  you play against.
- **Non-custodial.** The `TerraceEscrow` contract holds the pot — never a host's personal
  account. Each winner pulls their own share directly from the contract.
- **One honest trust point.** A single `reporter` address (the host, or a keeper reading a
  scores API), fixed at deploy, records the final score. That's the *only* privileged role,
  and we state it plainly rather than pretending it's a trustless oracle.

## Architecture

```
Each fan's device
├─ Pears room (Hyperswarm + Autobase)   → shared state: predictions · chat · scoreboard · group-tip status
├─ WDK wallet (self-custody)            → chips into / claims from the group-tip pool
│   └─ TerraceEscrow (Sepolia)          → holds the pot, splits it among correct predictors
└─ QVAC (on-device Bergamot NMT)        → translates the room into each fan's language, locally
```

Three seams keep the layers clean and the proven core untouched:
`lib/room.js` (P2P, no chain/AI deps) · `lib/stake-bridge.mjs` (room ⇄ pool) ·
`lib/translate-bridge.mjs` (room → on-device translation) · `lib/terrace-app.mjs`
(assembles all three for one peer).

## Quickstart

Requirements: Node.js ≥ 22.17 + npm; [Foundry](https://getfoundry.sh) (`forge`, `anvil`);
Pear CLI (`npm i -g pear`, then run `pear` once). See per-section notes below.

```sh
npm install
./start.sh            # boots a local chain + the whole assembled stack, end to end
```

`./start.sh` also takes `room` (just the P2P sync) or `contracts` (just the pool tests).
First run downloads the small on-device translation models once, then caches them.

---

## The watch-party room (Pears)

Serverless, multi-writer shared state — the heart of the app.

- **Hyperswarm** — peer discovery over the DHT (no signalling server).
- **Autobase** — conflict-free **multi-writer** log. Each peer appends its own predictions /
  chat / scoreboard / group-tip entries; Autobase linearizes them into one view everyone
  agrees on.
- **Corestore** replicates the underlying hypercores peer-to-peer.
- **Protomux pairing** — a read-only joiner hands its writer key to an existing writer, who
  promotes it with Autobase `addWriter`. That's what makes it genuinely multi-writer, not a
  single-writer broadcast.

The linearized log holds `prediction`, `message`, `score`, and group-tip
(`stake` / `stakeConfirmed` / `result` / `claim`) entries.

**Verify** (two peers on one machine, each with its own storage via `-t`):
```sh
pear run --dev -t . host            # prints {"key":"<ROOMKEY>"}
pear run --dev -t . guest <ROOMKEY> # second terminal
# or:
npm run room:test
```
Both converge to identical state listing every peer's predictions and chat.

`lib/room.js` runs under both Bare and Node with no UI/chain/AI deps.

## On-device translation (QVAC) — one room, every language

Translation is a **local, read-time** transform. The Autobase log keeps the **original**
text (canonical, untouched); each peer translates incoming lines into *their* language at
display time, so nothing translated is ever written to shared state.

- Small **Bergamot NMT** models run locally via `@qvac/sdk` + the `@qvac/translation-nmtcpp`
  engine. A model is fetched **once** from QVAC's P2P registry (Hyperdrive — not a cloud
  API), cached on disk, then all inference is local. There is no translation API key or
  endpoint anywhere.
- `lib/translate-bridge.mjs` wraps every QVAC call; `room.js` has no AI deps.

**Verify:**
```sh
npm run translate:demo
```
Alice reads the room in French, Bruno in Spanish; both see the *same* original English in
the canonical log. On-device proof: run it twice — the second run does **zero** downloads
and **zero** registry/network calls yet still translates.

## The group-tip pool (WDK + escrow)

A self-custodial wallet (WDK) chips into and claims from a non-custodial contract — see
[the framing above](#the-group-tip-pool-is-friends-among-themselves).

- `contracts/src/TerraceEscrow.sol` — `deposit` (chip in on a prediction) / `reportResult`
  (reporter records the score) / `claim` (correct predictors split the pot proportionally).
- `lib/wdk-wallet.mjs` — WDK self-custody: seed → account, balances, and contract calls
  **signed by the WDK account** (`sendTransaction({to,value,data})`); ethers is only an ABI
  codec, as WDK does internally.
- `lib/stake-bridge.mjs` — the seam: a chip-in appears **pending** in the room instantly,
  flips to **confirmed** on the deposit receipt, and `reconcile()` checks the room mirror
  against `escrow.stakeOf` (**the contract is the source of truth**; any disagreement is
  surfaced, not hidden).

WDK: `@tetherto/wdk` 1.0.0-beta.13, `@tetherto/wdk-wallet-evm` 1.0.0-beta.15.

**Verify:**
```sh
npm run contracts:test   # 8 tests: proportional split, reporter-only, no double-claim, ...
npm run escrow:e2e       # single-wallet deposit→report→claim on local anvil (needs: anvil &)
npm run stake:e2e        # two room peers: chip in → report → claim → converge → reconcile
npm run wallet:info      # create/load wallet, read address + ETH + USDt on live Sepolia
```

**Deploy to Sepolia** (needs faucet funds):
```sh
cp .env.example .env     # PRIVATE_KEY (funded deployer); .env is gitignored
forge script contracts/script/Deploy.s.sol:Deploy --root contracts --rpc-url "$SEPOLIA_RPC_URL" --broadcast
```
Deployer needs Sepolia ETH (faucet); participants need test USDt
(`0xd077a400968890eacc75cdc901f0356c943e4fdb`) at their `wallet:info` address. Gasless
(ERC-4337 / Pimlico) is a noted follow-up.

## All three together

`lib/terrace-app.mjs` assembles room + WDK wallet + group-tip pool + translator for one
peer (the surface the desktop shell wraps). `npm run assemble` / `./start.sh` runs two such
peers through the whole flow — predict → chip in → chat → translate on read → report →
claim → reconcile — in one process, proving the three tracks coexist.

## Live match data

The match, teams, and **final result are real** — pulled from **TheSportsDB** (keyless free
tier; FIFA World Cup, league 4429) via `lib/match-data.mjs`. Nothing about the outcome is
hardcoded: fans predict, and the reporter reports the **real** score (in the desktop app,
the "Auto-report real result" button fetches it live). `./start.sh` picks the latest real
finished match and lets three fans predict home/away/draw — whoever the real world proved
right splits the pot. Set `SPORTSDB_KEY` for a Patreon key, or `SPORTSDB_LEAGUE` for another
competition. Falls back to a fixed match only if the API is unreachable.

## Running on real Sepolia (instead of local test money)

Local dev (default) uses a throwaway anvil chain + a mock token so it runs with zero setup.
To use **real Sepolia + real test USDt**:

```sh
cp .env.example .env
# 1) fund a deployer with Sepolia ETH (faucet), put its key in .env as PRIVATE_KEY
# 2) set SEPOLIA_RPC_URL (e.g. https://sepolia.drpc.org)
./start.sh deploy               # deploys TerraceEscrow, prints the address
# 3) put that address in .env as ESCROW_ADDRESS
npm run wallet:info             # prints your wallet address
# 4) send Sepolia test USDt to that address (Pimlico/Candide faucet)
./start.sh desktop              # now targets Sepolia automatically (SEPOLIA_RPC_URL set)
```

USDt (Sepolia): `0xd077a400968890eacc75cdc901f0356c943e4fdb`. The deployer needs Sepolia ETH;
each fan's wallet needs test USDt to chip in. `.env` is gitignored — never commit keys.

## Windows / any-OS (cross-platform, Sepolia mode)

Sepolia mode needs **only Node ≥ 22.17 + Electron — no Foundry/anvil** (the escrow is
already deployed). Two ways to launch:

- **Windows (or anywhere):** `npm start` → runs `start.mjs`, which launches the Electron app
  against Sepolia on any OS (no bash).
- **macOS/Linux/WSL:** `./start.sh desktop` also works Foundry-free once `SEPOLIA_RPC_URL` is set.

```sh
npm install
# .env:
#   SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
#   ESCROW_ADDRESS=<deployed escrow>
#   USDT_ADDRESS=<deployed test USDt>
#   TERRACE_SEED="…"        # npm run wallet:info to generate one, then fund it
npm start                    # first run installs Electron
```

Only **local anvil mode** (`./start.sh` with no `SEPOLIA_RPC_URL`) needs Foundry.

> Platform caveat (not tested by us on Windows): QVAC's on-device translation uses a native
> engine (`@qvac/translation-nmtcpp`) that needs Windows prebuilds. If it doesn't load, chat
> falls back to the original text and everything else (room, staking, pool) still works.

## Honesty notes

- **Local anvil is the default, self-funding proof.** The on-chain flows are verified on a
  local chain (deterministic, free); the identical code runs on Sepolia once you fund wallets.
- **The reporter is the trust boundary** (stated above), not a trustless oracle.
- Terminal harnesses are kept as the regression proof that the core still works.

## Pear runtime discrepancies found (Pear v0.3243 / pear 2.6.5)

1. `pear init` is **removed**; scaffold by hand (a `package.json` + entry file is enough).
2. `pear run` is **deprecated** but works ("use the `pear-runtime` module"); used for the
   room test, durable path is embedding `pear-runtime`.
3. Desktop is no longer single-context: renderer ↔ preload `window.bridge` ↔ Electron main
   ↔ a **Bare/Node worker** running the P2P + assembled core.
4. `bare-os` must be installed explicitly (`bare-fs`, via hypercore-storage, needs it under Bare).
5. QVAC ships as a client (`@qvac/sdk`) **plus** a separate engine (`@qvac/translation-nmtcpp`);
   both are required. `translate(...).text` is a Promise; no `qvac.config`/plugin step needed under Node.

## Status

- ✅ Serverless P2P watch-party room (predictions · chat · scoreboard)
- ✅ On-device multi-language translation
- ✅ Self-custodial group-tip pool (WDK + non-custodial escrow), reconciled with chain
- ✅ All three assembled + verified together headless
- ✅ Live match data (real fixtures + real results from TheSportsDB) driving the pool
- ✅ Desktop (Electron) shell around the assembled core
- ⏳ Live-Sepolia run of the full pool flow — code + config ready; needs you to fund wallets (faucets)
