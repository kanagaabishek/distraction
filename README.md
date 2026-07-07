# Terrace — Phase 1: the serverless P2P room

A peer-to-peer World Cup watch-party room built on the **Pears** stack. Phase 1 is the
networking core only: a serverless, multi-writer room where every peer shares predictions,
chat, and a scoreboard with no server in the middle. (Wallet/escrow and on-device
translation are later phases — staking amounts and scores here are mocked/display-only.)

## What it does

- **Hyperswarm** — peer discovery over the DHT on a room topic (no signalling server).
- **Autobase** — conflict-free **multi-writer** shared state. Each peer appends its own
  predictions / chat / score updates and Autobase linearizes them into one deterministic
  view every peer agrees on.
- **Corestore** — storage for the underlying hypercores, replicated peer-to-peer.
- **Protomux pairing channel** — a read-only joiner hands its writer key to an existing
  writer over the same connection; the writer promotes it with Autobase `addWriter`. This
  is what makes it genuinely multi-writer instead of a single-writer broadcast.

The Autobase view is a linearized log of entries:

```
{ type: 'prediction', peer, matchId, pick, at }
{ type: 'message',    peer, text, at }
{ type: 'score',      matchId, home, away, at }
```

## Files

| File | Role |
|---|---|
| `lib/room.js` | The P2P engine. No UI / no Pear API deps — runs under Bare or Node. |
| `harness.js`  | Terminal driver used to verify two instances sync. Reads args/storage from `Pear.config`. |
| `scripts/two-peer-test.sh` | Launches two instances on one machine and lets them sync. |

## Requirements

- Node.js LTS + npm (to install packages).
- Pear CLI + runtime:
  ```sh
  npm i -g pear
  pear            # one-time: bootstraps the Pear runtime
  ```
  Pear installs a launcher that asks you to add its bin to `$PATH`:
  `~/Library/Application Support/pear/bin` (macOS).

## Install

```sh
npm install
```

> Note: `bare-os` is listed as a direct dependency. `bare-fs` (pulled in transitively by
> hypercore-storage) needs it at runtime under Bare, and it is otherwise not in the tree.

## Run the two-peer sync test

Each instance needs its own storage — the `-t` / `--tmp-store` flag gives each launch a
fresh one, simulating two different machines.

**Terminal 1 (host — creates the room):**
```sh
pear run --dev -t . host
# prints: {"evt":"ready","role":"host","key":"<ROOMKEY>", ...}
```

**Terminal 2 (guest — joins with the room key):**
```sh
pear run --dev -t . guest <ROOMKEY>
```

Within a few seconds both terminals print identical `state` lines listing **both** peers'
predictions and chat messages, and the host's scoreboard on the guest. That is the Phase 1
success criterion.

Or run both automatically:
```sh
bash scripts/two-peer-test.sh
grep '"evt":"state"' /tmp/terrace-host.log  | tail -1
grep '"evt":"state"' /tmp/terrace-guest.log | tail -1
```

## Doc discrepancies found vs. the original plan (Pear v0.3243 / pear 2.6.5)

1. **`pear init` is removed** ("DEPRECATED & REMOVED — making templates out of scope").
   Projects are now scaffolded by hand (a `package.json` + entry file is all Pear needs).
2. **`pear run` is deprecated** but still works ("DEPRECATED. WILL BE REMOVED. Use the
   `pear-runtime` module instead"). Used here for Phase 1; the durable path is embedding
   `pear-runtime` as a library.
3. **Desktop is no longer single-context.** The current desktop model (see
   `holepunchto/hello-pear-electron`) is: Electron renderer ↔ preload `window.bridge` ↔
   Electron main ↔ a **Bare worker** (`Bare.IPC`) that runs the P2P stack. `lib/room.js`
   is written to drop straight into that worker.
4. **`bare-os` must be installed explicitly** (see Install note above).

## Phase 2a — WDK wallet + non-custodial escrow

Self-custodial staking on a Sepolia escrow contract. Money is NOT yet wired into the
P2P room (that's Phase 2b) — 2a is verified via scripts.

### Trust model (honest, by design)

- **The pool is non-custodial.** Staked USDt lives in the `TerraceEscrow` contract, never
  in a host's personal account. Winners pull their own share with `claim()`.
- **The result is set by a single `reporter` address**, fixed at deploy (the host wallet,
  or a keeper reading a scores API). **That reporter is the trust boundary.** This is
  deliberately not a trustless oracle (out of scope), and deliberately not a host-custodied
  pool (which would defeat the point).

### Pieces

| File | Role |
|---|---|
| `contracts/src/TerraceEscrow.sol` | `deposit` / `reportResult` / `claim`. Proportional payout of the whole pool to correct predictors. |
| `contracts/src/MockUSDt.sol` | 6-decimal test ERC-20, for tests + local anvil only. |
| `contracts/test/TerraceEscrow.t.sol` | 8 tests: payout math, reporter-only, no double-claim/stake, etc. |
| `contracts/script/Deploy.s.sol` | Deploy to Sepolia (or any EVM). |
| `lib/wdk-wallet.mjs` | WDK self-custody helpers: seed → account, balances, contract calls **signed by WDK**. |
| `scripts/wallet-info.mjs` | Create/load wallet, print address + ETH + USDt balance (Sepolia). |
| `scripts/escrow-local-e2e.mjs` | Full deposit→report→claim on local anvil via WDK signing. |

WDK versions: `@tetherto/wdk` 1.0.0-beta.13, `@tetherto/wdk-wallet-evm` 1.0.0-beta.15.
Contract calls go through `account.sendTransaction({ to, value, data })` — genuine WDK
self-custody signing; ethers is used only as an ABI codec (as WDK does internally).

### Verify 2a

```sh
# 1) contract logic (8 tests)
npm run contracts:test

# 2) full deposit -> report -> claim through WDK signing, on a throwaway local chain
anvil &                       # in another terminal (or backgrounded)
npm run escrow:e2e            # prints balances before/after; ends with PASS

# 3) wallet + live Sepolia balance read
npm run wallet:info           # generates .env with a fresh seed on first run
```

Why local anvil for the E2E: the on-chain flow needs a funded staker (Sepolia ETH for gas
+ test USDt), and Sepolia funding depends on faucets a script can't drive. anvil proves the
exact same contract + WDK code path deterministically and for free.

### Deploy to Sepolia (needs faucet funds)

```sh
cp .env.example .env          # fill PRIVATE_KEY (funded deployer), keep .env gitignored
forge script contracts/script/Deploy.s.sol:Deploy --root contracts \
  --rpc-url "$SEPOLIA_RPC_URL" --broadcast
```

Deployer needs Sepolia ETH (faucet). Stakers need test USDt (Pimlico/Candide faucet) sent
to their WDK address from `wallet:info`. USDt (Sepolia): `0xd077a400968890eacc75cdc901f0356c943e4fdb`.
Gasless (ERC-4337 / Pimlico) is a noted follow-up, intentionally deferred so it doesn't
block this checkpoint.

## Phase 2b — staking wired into the P2P room

The two proven layers joined: a stake is a genuine **Autobase multi-writer event** in the
same shared log as predictions/chat/scoreboard, and it references the on-chain deposit.

### Flow (ordering, as designed)

1. Locking a prediction emits a **pending** stake into Autobase immediately — every peer
   sees it without waiting on the chain.
2. The WDK account does the on-chain `approve` + `deposit` (self-custody signing).
3. On the deposit receipt, the stake flips to **confirmed** (referencing the real tx hash).
4. Reporter reports the outcome on-chain; the room **mirrors** the result.
5. The winner claims on-chain; the room records the claim + payout.

The **contract stays the source of truth.** The room state mirrors/references it; a
`reconcile()` step reads `escrow.stakeOf` + `matches` and asserts they agree (contract wins
on any disagreement — surfaced, not hidden).

Shared state per player (`room.getState().stakes[address]`): `prediction`, `amount`,
`status` (pending→confirmed), `won`, and `claim` (txHash + payout).

| File | Role |
|---|---|
| `lib/room.js` | +additive stake/result/claim event methods + getState folding. Phase 1 behavior unchanged. |
| `lib/stake-bridge.mjs` | The seam: room events ⇄ WDK-signed on-chain deposit/report/claim + reconcile. |
| `scripts/stake-flow-e2e.mjs` | Two room peers + two WDK accounts; full stake→report→claim on local anvil. |

### Verify 2b

```sh
anvil &                    # or backgrounded
npm run stake:e2e          # prints both peers' views; ends with PASS
```

What it proves: peerA stakes AWAY, peerB stakes HOME; **both peers see both stakes** go
pending→confirmed; reporter reports HOME; peerB (winner) claims the 200 USDt pool; both
peers **converge to identical state**; and room state **reconciles AGREE** with the escrow.

Discovery for the two in-process peers uses a local DHT testnet (`@hyperswarm/testnet`) so
it's deterministic. Pure-P2P two-process sync stays covered by `npm run room:test`.

## Not yet built (later phases — do not assume present)

- Phase 3: QVAC on-device chat translation.
- A desktop GUI shell around `lib/room.js`.
- Live-Sepolia run of the full staking flow (needs faucet-funded wallets; local anvil is the autonomous proof).
