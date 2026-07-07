/**
 * TerraceApp (Phase 4a) — the single assembled surface that composes all three tracks
 * for ONE peer:
 *   - Room            (lib/room.js)          : serverless P2P shared state
 *   - WDK account     (lib/wdk-wallet.mjs)   : self-custodial wallet
 *   - stake bridge    (lib/stake-bridge.mjs) : room events <-> on-chain escrow
 *   - Translator      (lib/translate-bridge) : on-device read-time translation
 *
 * This is a THIN wrapper — it does not modify any of the proven libs. The Electron/Bare
 * worker in 4b drives exactly this object, and the terminal harnesses still exercise the
 * same libs underneath.
 */

import Room from './room.js'
import { makeAccount } from './wdk-wallet.mjs'
import { stake as bridgeStake, report as bridgeReport, claim as bridgeClaim, reconcile as bridgeReconcile } from './stake-bridge.mjs'
import { Translator } from './translate-bridge.mjs'

export class TerraceApp {
  /**
   * @param {object} o
   * @param {string} o.name      display name for this peer
   * @param {string} o.lang      preferred reading language (e.g. 'fr', 'es', 'en')
   * @param {string} o.storage   Corestore path
   * @param {string} [o.bootstrap] hex room key to join; omit to create a room
   * @param {any[]}  [o.dhtBootstrap] optional DHT bootstrap (local testnet)
   * @param {object} o.provider  ethers provider object (for reads + tx receipts)
   * @param {string} o.rpc       RPC URL string (WDK registers its wallet against this)
   * @param {string} o.escrow    escrow contract address
   * @param {string} o.usdt      USDt token address
   * @param {string} o.seed      WDK seed phrase (from .env; never hard-coded)
   * @param {number} [o.accountIndex] WDK account index
   */
  constructor (o) {
    this.opts = o
    this.name = o.name
    this.lang = o.lang
  }

  async start () {
    const o = this.opts
    this.room = new Room({ storage: o.storage, name: o.name, bootstrap: o.bootstrap, dhtBootstrap: o.dhtBootstrap })
    await this.room.ready()
    this.account = await makeAccount({ seed: o.seed, index: o.accountIndex ?? 0, provider: o.rpc })
    this.address = await this.account.getAddress()
    this.translator = new Translator({ targetLang: o.lang })
    return this
  }

  // --- room / identity ---
  get key () { return this.room.key }
  get writable () { return this.room.writable }
  set onupdate (fn) { this.room.onupdate = fn }

  // --- predictions / chat (canonical, multi-writer) ---
  predict (matchLabel, pick) { return this.room.appendPrediction(matchLabel, pick) }
  chat (text) { return this.room.appendMessage(text) }
  postScore (matchLabel, home, away) { return this.room.appendScore(matchLabel, home, away) }

  // --- staking (WDK-signed, mirrored into room, reconciled with chain) ---
  stake ({ matchLabel, prediction, amount }) {
    return bridgeStake(this.room, this.account, { provider: this.opts.provider, escrow: this.opts.escrow, usdt: this.opts.usdt, matchLabel, prediction, amount })
  }
  report ({ matchLabel, outcome }) {
    return bridgeReport(this.room, this.account, { provider: this.opts.provider, escrow: this.opts.escrow, matchLabel, outcome })
  }
  claim ({ matchLabel }) {
    return bridgeClaim(this.room, this.account, { provider: this.opts.provider, escrow: this.opts.escrow, usdt: this.opts.usdt, matchLabel })
  }
  reconcile ({ matchLabel, staker, roomStake }) {
    return bridgeReconcile(this.opts.provider, { escrow: this.opts.escrow, matchLabel, staker, roomStake })
  }

  // --- wallet reads ---
  async balances () {
    return { eth: await this.account.getBalance(), usdt: await this.account.getTokenBalance(this.opts.usdt) }
  }

  // --- shared state + localized (on-device) chat view ---
  state () { return this.room.getState() }
  async localizedChat ({ from = 'en' } = {}) {
    const s = await this.room.getState()
    return this.translator.localize(s.messages, { from })
  }

  async close () {
    try { await this.translator?.close() } catch { /* ignore */ }
    try { await this.room?.close() } catch { /* ignore */ }
  }
}
