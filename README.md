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

## Not yet built (later phases — do not assume present)

- Phase 2: WDK wallet + Sepolia escrow (real staking/payouts).
- Phase 3: QVAC on-device chat translation.
- A desktop GUI shell around `lib/room.js` (the P2P core is verified via the terminal
  harness above; the GUI wrapper is the next step).
