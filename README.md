# Terrace

### The serverless watch-party for the global tournament.

*Predict the match with your crew. Chip into a self-custodial group-tip pool. Read the room in your own language — all peer-to-peer, no server, no company in the middle.*

**Built for the Tether Developers Cup** · Serverless P2P (Pears) · Self-custodial on-chain settlement (WDK) · On-device translation (QVAC) · **Cup Champion — all three tracks**

---

## Table of Contents

- [The Moment](#the-moment)
- [What Terrace Is](#what-terrace-is)
- [Why It's One Product, Not Three Demos](#why-its-one-product-not-three-demos)
- [What Makes It Technically Hard](#what-makes-it-technically-hard)
- [How It Fits the Theme](#how-it-fits-the-theme)
- [The Group-Tip Pool Is Friends Among Themselves](#the-group-tip-pool-is-friends-among-themselves)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Quickstart](#quickstart)
- [Run on Windows / Any OS (Sepolia mode)](#run-on-windows--any-os-sepolia-mode)
- [The Watch-Party Room (Pears)](#the-watch-party-room-pears)
- [On-Device Translation (QVAC)](#on-device-translation-qvac)
- [The Group-Tip Pool (WDK + Escrow)](#the-group-tip-pool-wdk--escrow)
- [All Three Together](#all-three-together)
- [Live Match Data](#live-match-data)
- [Running on Real Sepolia](#running-on-real-sepolia)
- [What's Real vs. Test-Only](#whats-real-vs-test-only)
- [Pear Runtime Discrepancies Found](#pear-runtime-discrepancies-found)
- [Security & Privacy](#security--privacy)
- [Earlier Work / Reuse Disclosure](#earlier-work--reuse-disclosure)
- [Status](#status)
- [File Structure](#file-structure)
- [License](#license)

---

## The Moment

The World Cup is the one time a year when friends who can't be in the same room desperately want to be. The match is on, the group chat is on fire, everyone's got a prediction and a fiver riding on it — and the entire experience runs through somebody's servers: a chat company relaying your banter, a betting operator holding your money, a cloud API translating for the friend who supports the other team.

Terrace takes all three middlemen out. The room is peer-to-peer, so no server hosts your watch-party. The pool is a self-custodial escrow contract, so no operator holds the pot. The translation runs on your own device, so a global crowd shares one room with nothing leaving anyone's machine. **The tournament is a worldwide moment; Terrace makes the watch-party worldwide too — with no one in the middle.**

## What Terrace Is

A single serverless loop, not a bundle of features:

1. **Open a room** for a live fixture — the app pulls the real match (teams, kickoff, final score) from a live football data source.
2. **Predict** the outcome and **chip into the group-tip pool** — a real USDt stake, signed on your own device.
3. **Chat** the match through — every message is stored once in the room's canonical log and **translated on each peer's own device** into their language.
4. When the real match finishes, the result is reported and the **pool settles on-chain** — every correct predictor claims their proportional share, straight from the contract.

Money is one feature near the end, not the point. **The point is the room.** No cloud calls for chat, translation, or matchmaking; the only outside call is reading the public football fixture.

## Why It's One Product, Not Three Demos

Each engine is load-bearing — remove any one and the product stops being what it is:

```
        A crew wants to watch the match together, apart
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  Pears (serverless P2P room)     │  Hyperswarm discovery + Autobase
        │  hosts the watch-party — no      │  multi-writer state. Predictions,
        │  server owns the room or the     │  chat, and scoreboard are ONE
        │  state                           │  linearized log every peer agrees on
        └────────────────┬────────────────┘
                         │
                          ▼
        ┌─────────────────────────────────┐
        │  WDK (self-custodial escrow)     │  Each fan stakes into a pooled
        │  lets them put real money on     │  on-chain escrow. Nobody — not even
        │  their calls with nobody         │  the host — custodies the pot; the
        │  holding the pot                 │  contract does, and pays winners
        └────────────────┬────────────────┘
                         │
                          ▼
        ┌─────────────────────────────────┐
        │  QVAC (on-device translation)    │  48 nations, one room. Each peer
        │  makes it a GLOBAL room, not     │  reads the banter in their own
        │  an English-only one             │  language — inference on-device,
        │                                  │  nothing sent to a cloud
        └─────────────────────────────────┘
```

Cut **Pears** and you have a betting contract with a chatroom bolted to someone's server — the "serverless watch-party" is gone. Cut **WDK** and you have a group chat with a scoreboard — the stakes that make a prediction *matter* are gone, or they're back in an operator's custody. Cut **QVAC** and you have an English-only room at a tournament whose whole point is that the world shows up — the global part is gone, or it's leaking every message to a translation API. None of the three is there to check a box; each exists because the one before it created the need for it.

## What Makes It Technically Hard

The hard part of Terrace isn't any single track — it's that the three are genuinely composed, and one of them does something most hackathon wallets don't:

- **Real multi-writer P2P state, not a websocket.** The room uses Autobase for conflict-free multi-writer shared state: a read-only joiner sends its writer key over the connection and an existing writer promotes it via `addWriter`. Every peer converges to byte-identical state with no server arbitrating. Hyperswarm here is real DHT peer discovery — not plain WebRTC with a Pears logo.
- **Pooled, self-custodial, on-chain settlement — not a wallet-to-wallet send.** `TerraceEscrow.sol` holds many independent stakers' USDt in one pool per match, a designated reporter settles the real result, and **every correct predictor claims a proportional share** of the whole pool. Losers get nothing; the escrow zeroes out. This is a deployed Solidity contract with real multi-party accounting, signed by WDK self-custodial accounts — a materially harder artifact than sending a token from address A to address B.
- **Translation that preserves one canonical truth.** The Autobase log stores the *original* message once; each peer translates at read-time into their own language. The shared state stays a single agreed-on log — translation is a personal lens, not N language copies polluting the room.
- **All three in one running app.** Hyperswarm/Autobase + WDK/ethers + QVAC (which spawns its own Bare worker for inference) coexist in one process with no port, event-loop, or module conflict — verified end-to-end.

## How It Fits the Theme

The brief asks for *football and the global tournament moment*, and names these ideas: match predictors, an AI coach or commentator, peer-to-peer fan messaging, group-tipping and ticket tools, watch-party apps. Terrace is several of them at once, each proven:

| Theme hook (brief's words) | In Terrace | Proven by |
|---|---|---|
| **Watch-party app** | A serverless P2P room (Pears: Hyperswarm + Autobase) — no backend; share a room key to join | `npm run room:test` (two peers sync) |
| **Match predictors** | Each fan locks a prediction into the shared multi-writer room; everyone sees everyone's calls | prediction entries in `room.getState()` |
| **Peer-to-peer fan messaging** | Live chat linearized across all peers over Autobase — no server relays it | `npm run room:test` |
| **Group-tipping** | Friends chip USDt into one self-custodial pool; correct predictors split it — no house, no cut | `npm run stake:e2e` + 8 contract tests |
| **The *global* tournament moment** | Fans of different nations share ONE room, each reading it in **their own language**, all inference **on-device** (QVAC) | `npm run translate:demo` |

## The Group-Tip Pool Is Friends Among Themselves

This is deliberate, and it's what keeps Terrace on the **tipping** side of the line rather than just renaming things:

- **No house, no operator, no middleman.** Nobody runs the pot as a business or takes a cut. Everyone chips into one shared contract.
- **No market, no line.** There is no price and no payout multiplier stacked in anyone's favor. When the match ends, whoever predicted the result right splits the whole pot **proportionally to what they put in**. It's a friendly pot among friends, not a market you play against.
- **Non-custodial.** The `TerraceEscrow` contract holds the pot — never a host's personal account. Each winner pulls their own share directly from the contract.
- **One honest trust point.** A single `reporter` address (the host, or a keeper reading a scores API), fixed at deploy, records the final score. That's the *only* privileged role, and we state it plainly rather than pretending it's a trustless oracle.

## Tech Stack

| Component | Technology | Why it's load-bearing |
| --- | --- | --- |
| **Pears** | Hyperswarm (DHT discovery) + Autobase (multi-writer) + Corestore | A watch-party room that no company can host, read, or shut down |
| **WDK** | `@tetherto/wdk` 1.0.0-beta.13 + `@tetherto/wdk-wallet-evm` 1.0.0-beta.15 + a Solidity escrow on Sepolia | Real money on your calls with nobody holding the pot |
| **QVAC** | Bergamot NMT (`@qvac/sdk` + `@qvac/translation-nmtcpp`) | A global room where no message leaves the device to be translated |
| **Bare** | Bare runtime | The minimal JS runtime the Pears room runs on |
| **Electron** | Chromium shell | Desktop UI wrapping the same worker — no logic duplicated |
| **Live match data** | TheSportsDB (keyless free tier, FIFA World Cup) | Binds the room to a *real* tournament match and its real result |

## Architecture

```
Each fan's device
├─ Pears room (Hyperswarm + Autobase)   → shared state: predictions · chat · scoreboard · group-tip status
├─ WDK wallet (self-custody)            → chips into / claims from the group-tip pool
│   └─ TerraceEscrow (Sepolia)          → holds the pot, splits it among correct predictors
└─ QVAC (on-device Bergamot NMT)        → translates the room into each fan's language, locally
```

Four seams keep the layers clean and the proven core untouched:

- `lib/room.js` — the P2P room engine (Hyperswarm + Autobase), **no chain/AI deps**. Runs under Bare and Node.
- `lib/stake-bridge.mjs` — the room ⇄ pool seam: all WDK/ethers lives here; emits stake events and reconciles against the chain.
- `lib/translate-bridge.mjs` — wraps all QVAC calls; a read-time transform, so `room.js` never imports the translator.
- `lib/terrace-app.mjs` — assembles room + wallet + pool + translator for one peer (the surface the desktop shell wraps).

## Quickstart

**Requirements:** Node.js ≥ 22.17 + npm; [Foundry](https://getfoundry.sh) (`forge`, `anvil`); Pear CLI (`npm i -g pear`, then run `pear` once to bootstrap).

> **Linux/Arch note:** Pear needs libatomic — Debian/Ubuntu `sudo apt install libatomic1`; Arch `sudo pacman -S libatomic_ops`. Without it, Pear won't start.

> **QVAC needs TWO packages.** `@qvac/sdk` is only the client; you must also have the engine `@qvac/translation-nmtcpp`, or QVAC's worker dies with `MODULE_NOT_FOUND: addonLogging.js`. Both are in `package.json` — don't remove either.

```sh
npm install
./start.sh            # boots a local chain + the whole assembled stack, end to end
```

`./start.sh` also takes `room` (just the P2P sync) or `contracts` (just the pool tests). First run downloads the small on-device translation models once (~31MB from QVAC's P2P registry), then caches them and runs fully offline.

## Run on Windows / Any OS (Sepolia mode)

Sepolia mode needs **only Node ≥ 22.17 + Electron — no Foundry/anvil** (the escrow is already deployed). Two ways to launch:

- **Windows (or anywhere):** `npm start` → runs `start.mjs`, which launches the Electron app against Sepolia on any OS (no bash needed).
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

> **Platform caveat (not tested by us on Windows):** QVAC's on-device translation uses a native engine (`@qvac/translation-nmtcpp`) that needs Windows prebuilds. If it doesn't load, chat falls back to the original text and everything else (room, staking, pool) still works.

## The Watch-Party Room (Pears)

Serverless, multi-writer shared state — the heart of the app.

- **Hyperswarm** — peer discovery over the DHT (no signalling server).
- **Autobase** — conflict-free **multi-writer** log. Each peer appends its own predictions / chat / scoreboard / group-tip entries; Autobase linearizes them into one view everyone agrees on.
- **Corestore** replicates the underlying hypercores peer-to-peer.
- **Protomux pairing** — a read-only joiner hands its writer key to an existing writer, who promotes it with Autobase `addWriter`. That's what makes it genuinely multi-writer, not a single-writer broadcast.

The linearized log holds `prediction`, `message`, `score`, and group-tip (`stake` / `stakeConfirmed` / `result` / `claim`) entries.

**Verify** (two peers on one machine, each with its own storage via `-t`):
```sh
pear run --dev -t . host            # prints {"key":"<ROOMKEY>"}
pear run --dev -t . guest <ROOMKEY> # second terminal
# or:
npm run room:test
```
Both converge to identical state listing every peer's predictions and chat. `lib/room.js` runs under both Bare and Node with no UI/chain/AI deps.

## On-Device Translation (QVAC)

Translation is a **local, read-time** transform. The Autobase log keeps the **original** text (canonical, untouched); each peer translates incoming lines into *their* language at display time, so nothing translated is ever written to shared state.

- Small **Bergamot NMT** models run locally via `@qvac/sdk` + the `@qvac/translation-nmtcpp` engine. A model is fetched **once** from QVAC's P2P registry (Hyperdrive — not a cloud API), cached on disk, then all inference is local. There is no translation API key or endpoint anywhere.
- `lib/translate-bridge.mjs` wraps every QVAC call; `room.js` has no AI deps.

**Verify:**
```sh
npm run translate:demo
```
Alice reads the room in French, Bruno in Spanish; both see the *same* original English in the canonical log. **On-device proof:** run it twice — the second run does **zero** downloads and **zero** registry/network calls yet still translates.

## The Group-Tip Pool (WDK + Escrow)

A self-custodial wallet (WDK) chips into and claims from a non-custodial contract — see [the framing above](#the-group-tip-pool-is-friends-among-themselves).

- `contracts/src/TerraceEscrow.sol` — `deposit` (chip in on a prediction) / `reportResult` (reporter records the score) / `claim` (correct predictors split the pot proportionally).
- `lib/wdk-wallet.mjs` — WDK self-custody: seed → account, balances, and contract calls **signed by the WDK account** (`sendTransaction({to,value,data})`); ethers is only an ABI codec, as WDK does internally.
- `lib/stake-bridge.mjs` — the seam: a chip-in appears **pending** in the room instantly, flips to **confirmed** on the deposit receipt, and `reconcile()` checks the room mirror against `escrow.stakeOf` (**the contract is the source of truth**; any disagreement is surfaced, not hidden).

**Verify:**
```sh
npm run contracts:test   # 8 tests: proportional split, reporter-only, no double-claim, ...
npm run escrow:e2e       # single-wallet deposit→report→claim on local anvil (needs: anvil &)
npm run stake:e2e        # two room peers: chip in → report → claim → converge → reconcile
npm run wallet:info      # create/load wallet, read address + ETH + USDt on live Sepolia
```

## All Three Together

`lib/terrace-app.mjs` assembles room + WDK wallet + group-tip pool + translator for one peer (the surface the desktop shell wraps). `npm run assemble` / `./start.sh` runs two such peers through the whole flow — predict → chip in → chat → translate on read → report → claim → reconcile — in one process, proving the three tracks coexist.

## Live Match Data

The match, teams, and **final result are real** — pulled from **TheSportsDB** (keyless free tier; FIFA World Cup, league 4429) via `lib/match-data.mjs`. Nothing about the outcome is hardcoded: fans predict, and the reporter reports the **real** score (in the desktop app, the "Auto-report real result" button fetches it live). `./start.sh` picks the latest real finished match and lets fans predict home/away/draw — whoever the real world proved right splits the pot. Set `SPORTSDB_KEY` for a Patreon key, or `SPORTSDB_LEAGUE` for another competition. Falls back to a fixed match only if the API is unreachable.

## Running on Real Sepolia

Local dev (default) uses a throwaway anvil chain + a mock token so it runs with zero setup. To use **real Sepolia + real test USDt**:

```sh
cp .env.example .env
# 1) fund a deployer with Sepolia ETH (faucet), put its key in .env as PRIVATE_KEY
# 2) set SEPOLIA_RPC_URL (e.g. https://ethereum-sepolia-rpc.publicnode.com — avoid public drpc, it lags)
./start.sh deploy               # deploys TerraceEscrow, prints the address
# 3) put that address in .env as ESCROW_ADDRESS
npm run wallet:info             # prints your wallet address
# 4) send Sepolia test USDt to that address (Pimlico/Candide faucet)
./start.sh desktop              # now targets Sepolia automatically (SEPOLIA_RPC_URL set)
```

USDt (Sepolia): `0xd077a400968890eacc75cdc901f0356c943e4fdb`. The deployer needs Sepolia ETH; each fan's wallet needs test USDt to chip in. `.env` is gitignored — **never commit keys.** Gasless (ERC-4337 / Pimlico) is a noted follow-up. Expect real Sepolia to be slower than local (real block times; pending→confirmed takes real seconds) — that's the live network, and it's what proves it's genuinely on-chain.

## What's Real vs. Test-Only

Honesty matters, so this is explicit:

- **Real:** the blockchain (Ethereum's official Sepolia testnet), the escrow contract execution, WDK self-custodial signing, the P2P sync, the on-device translation, and the live match data.
- **Test-only by design:** the money is **testnet USDt with no monetary value**, and gas is free faucet ETH. Nobody can win or lose anything real — as it should be for a hackathon. The same code pointed at mainnet with real USDt would move real value, but that's deliberately not done here.
- **Local anvil is the default, self-funding proof.** The on-chain flows are verified on a local chain (deterministic, free); the identical code runs on Sepolia once wallets are funded.

## Pear Runtime Discrepancies Found

Found while building (Pear v0.3243 / pear 2.6.5) — documented so a judge reproducing the build doesn't hit the same walls:

1. `pear init` is **removed**; scaffold by hand (a `package.json` + entry file is enough).
2. `pear run` is **deprecated** but works ("use the `pear-runtime` module"); used for the room test — the durable path is embedding `pear-runtime`.
3. Desktop is no longer single-context: renderer ↔ preload `window.bridge` ↔ Electron main ↔ a **Bare/Node worker** running the P2P + assembled core.
4. `bare-os` must be installed explicitly (`bare-fs`, via hypercore-storage, needs it under Bare).
5. QVAC ships as a client (`@qvac/sdk`) **plus** a separate engine (`@qvac/translation-nmtcpp`); both are required. `translate(...).text` is a Promise; no `qvac.config`/plugin step needed under Node.

## Security & Privacy

- **No cloud calls for chat, translation, or matchmaking.** The only outside call is reading the public football fixture.
- **Self-custodial by default.** The WDK seed is stored locally, gitignored, and never transmitted — including to peers.
- **The pool is non-custodial.** USDt is held by the escrow contract, never by a host account. The one trust point is the designated *reporter* who settles the result — stated honestly, not a trustless oracle.
- **On-chain is the source of truth.** If room state and the contract ever disagree, the contract wins.
- **No secrets in the repo.** `.env` and wallet material are gitignored; nothing sensitive is committed.

## Earlier Work / Reuse Disclosure

Per the rules, judges score only what was built during the event.

> **[FILL THIS IN HONESTLY BEFORE SUBMITTING.]** State plainly what, if anything, predates the hackathon window, and confirm that the Terrace room engine, the escrow contract, the WDK/QVAC integration, and the desktop app were all built during the event. If any scaffold or snippet is reused from your own prior code, name it here. Do not claim "all built during the event" unless it is true — accurate disclosure protects the submission.

## Status

- ✅ Serverless P2P watch-party room (predictions · chat · scoreboard)
- ✅ On-device multi-language translation
- ✅ Self-custodial group-tip pool (WDK + non-custodial escrow), reconciled with chain
- ✅ All three assembled + verified together headless
- ✅ Live match data (real fixtures + real results from TheSportsDB) driving the pool
- ✅ Desktop (Electron) shell around the assembled core
- ✅ Cross-platform launch (Windows `npm start` / Unix `./start.sh`)
- ⏳ Live-Sepolia run of the full pool flow — code + config ready; needs funded wallets (faucets)

## File Structure

```
terrace/
├── lib/
│   ├── room.js               # P2P room engine (Hyperswarm + Autobase), UI/chain-free
│   ├── wdk-wallet.mjs         # WDK self-custody helpers
│   ├── stake-bridge.mjs       # room ↔ escrow seam (WDK/ethers) + reconcile
│   ├── translate-bridge.mjs   # QVAC on-device translation (read-time)
│   ├── terrace-app.mjs        # assembles all three for one peer
│   └── match-data.mjs         # live fixture + real result (TheSportsDB)
├── contracts/
│   └── src/TerraceEscrow.sol  # pooled self-custodial escrow, proportional multi-winner payout
├── desktop/                   # Electron renderer + preload + Bare/Node worker
├── scripts/                   # e2e harnesses, deploy, live Sepolia flow
├── start.sh                   # Unix launcher (local anvil or Sepolia)
├── start.mjs                  # cross-platform launcher (Windows/any OS, Sepolia)
├── .env.example
├── LICENSE                    # MIT
└── README.md
```

## License

Apache-2.0 — see [LICENSE](LICENSE).

---

Built for the **Tether Developers Cup** — Pears × WDK × QVAC. The theme is the filter; the stack is the point.
