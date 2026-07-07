/**
 * Terrace room — the serverless P2P core.
 *
 * A room is a multi-writer, conflict-free shared log built on:
 *   - Corestore  : storage for the hypercores
 *   - Autobase   : linearizes appends from every writer into one deterministic view
 *   - Hyperswarm : peer discovery + encrypted connections over the DHT
 *   - Protomux   : a tiny "pairing" channel multiplexed onto each connection so a
 *                  read-only joiner can hand its writer key to an existing writer,
 *                  who then promotes it via Autobase's addWriter.
 *
 * The Autobase view holds the whole room state as a linearized log of entries:
 *   { type: 'prediction', peer, matchId, pick, at }
 *   { type: 'message',    peer, text, at }
 *   { type: 'score',      matchId, home, away, at }
 * plus internal control entries { type: 'addWriter', key } handled inside apply.
 *
 * No servers. No signalling. Every device runs an identical copy of this.
 */

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Autobase = require('autobase')
const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')

const PAIRING_PROTOCOL = 'terrace/pairing/1'

class Room {
  /**
   * @param {object} opts
   * @param {string} opts.storage   filesystem path for the Corestore
   * @param {string} [opts.bootstrap] hex room key to join; omit/null to create a new room
   * @param {string} [opts.name]     display name for this peer's entries
   */
  constructor (opts = {}) {
    this.name = opts.name || 'anon'
    this.store = new Corestore(opts.storage)
    // opts.dhtBootstrap: optional DHT bootstrap list (used by local tests via
    // @hyperswarm/testnet for deterministic discovery). Omit in production -> public DHT.
    this.swarm = new Hyperswarm(opts.dhtBootstrap ? { bootstrap: opts.dhtBootstrap } : undefined)
    this.bootstrap = opts.bootstrap ? b4a.from(opts.bootstrap, 'hex') : null

    this.base = new Autobase(this.store, this.bootstrap, {
      valueEncoding: 'json',
      open: (store) => store.get('terrace-view', { valueEncoding: 'json' }),
      apply: this._apply.bind(this)
    })

    // hex writer keys we've already asked Autobase to promote (dedupe)
    this._promoted = new Set()

    // consumer callbacks
    this.onupdate = null   // () => void, fired whenever the linearized view changes
    this.onpeer = null     // (nConnections) => void
  }

  /** Deterministically fold linearized nodes into the view. Must stay pure. */
  async _apply (nodes, view, host) {
    for (const node of nodes) {
      const value = node.value
      if (value && value.type === 'addWriter') {
        // promote a peer to a writer so its appends are accepted + ordered
        await host.addWriter(b4a.from(value.key, 'hex'), { indexer: true })
        continue
      }
      await view.append(value)
    }
  }

  async ready () {
    await this.base.ready()

    this.swarm.on('connection', (conn) => this._onconnection(conn))

    // fire onupdate on any change to the linearized state
    this.base.on('update', () => this._emit())

    // discoveryKey is a safe-to-share 32-byte topic derived from the room key
    const topic = this.base.discoveryKey
    this.swarm.join(topic, { server: true, client: true })

    return this
  }

  _onconnection (conn) {
    // 1) let Corestore replicate all cores over this connection (creates the muxer)
    this.store.replicate(conn)

    // 2) share the SAME muxer for our tiny pairing protocol
    const mux = Protomux.from(conn)
    const channel = mux.createChannel({ protocol: PAIRING_PROTOCOL })
    if (channel === null) {
      // a channel for this protocol already exists on this connection
      if (this.onpeer) this.onpeer(this.swarm.connections.size)
      return
    }

    const message = channel.addMessage({
      encoding: c.buffer,
      onmessage: (key) => this._onpeerkey(key)
    })

    channel.open()
    // announce our local writer key so an existing writer can promote us
    message.send(this.base.local.key)

    conn.on('error', () => {}) // swallow reset noise on peer disconnect
    if (this.onpeer) this.onpeer(this.swarm.connections.size)
  }

  async _onpeerkey (key) {
    if (b4a.equals(key, this.base.local.key)) return
    const hex = b4a.toString(key, 'hex')
    if (this._promoted.has(hex)) return
    // only an existing writer can add new writers
    if (!this.base.writable) return
    this._promoted.add(hex)
    try {
      await this.base.append({ type: 'addWriter', key: hex })
    } catch (err) {
      this._promoted.delete(hex)
    }
  }

  _emit () {
    if (this.onupdate) this.onupdate()
  }

  /** Hex room key — this is the invite. Share it; a joiner passes it as bootstrap. */
  get key () {
    return b4a.toString(this.base.key, 'hex')
  }

  get writable () {
    return this.base.writable
  }

  // --- writes (only valid once this.writable === true) ---

  appendPrediction (matchId, pick) {
    return this.base.append({
      type: 'prediction', peer: this.name, matchId, pick, at: dateNow()
    })
  }

  appendMessage (text) {
    return this.base.append({
      type: 'message', peer: this.name, text, at: dateNow()
    })
  }

  appendScore (matchId, home, away) {
    return this.base.append({
      type: 'score', matchId, home, away, at: dateNow()
    })
  }

  // --- staking events (Phase 2b) ---
  // Stakes are genuine Autobase entries in the same multi-writer log, so every peer
  // sees them. They MIRROR the on-chain escrow (referencing matchId + staker address +
  // tx hash); the contract stays the source of truth. amount/payout are decimal strings
  // of USDt base units (BigInt isn't JSON-serializable).

  /** Locking a prediction: emit the stake as pending, immediately visible to all peers. */
  appendStake ({ matchId, prediction, amount, staker, status = 'pending', txHash = null }) {
    return this.base.append({
      type: 'stake',
      peer: this.name,
      matchId,
      prediction,
      amount: String(amount),
      staker: String(staker).toLowerCase(),
      status,
      txHash,
      at: dateNow()
    })
  }

  /** The deposit tx got a receipt: flip the stake pending -> confirmed. */
  confirmStake ({ matchId, staker, txHash }) {
    return this.base.append({
      type: 'stakeConfirmed', matchId, staker: String(staker).toLowerCase(), txHash, at: dateNow()
    })
  }

  /** Reporter mirrors the on-chain reported outcome into the room. */
  appendResult ({ matchId, outcome, txHash = null }) {
    return this.base.append({
      type: 'result', matchId, outcome, txHash, at: dateNow()
    })
  }

  /** A winner pulled their share: record the claim + payout. */
  appendClaim ({ matchId, staker, txHash, payout }) {
    return this.base.append({
      type: 'claim', matchId, staker: String(staker).toLowerCase(), txHash, payout: String(payout), at: dateNow()
    })
  }

  /** Fold the whole linearized view into a plain state object. */
  async getState () {
    const state = { predictions: {}, messages: [], score: null, result: null, stakes: {} }
    await this.base.update()
    const len = this.base.view.length
    for (let i = 0; i < len; i++) {
      const v = await this.base.view.get(i)
      if (!v) continue
      if (v.type === 'prediction') {
        state.predictions[v.peer] = { matchId: v.matchId, pick: v.pick, at: v.at }
      } else if (v.type === 'message') {
        state.messages.push({ peer: v.peer, text: v.text, at: v.at })
      } else if (v.type === 'score') {
        state.score = { matchId: v.matchId, home: v.home, away: v.away, at: v.at }
      } else if (v.type === 'stake') {
        state.stakes[v.staker] = {
          peer: v.peer,
          staker: v.staker,
          matchId: v.matchId,
          prediction: v.prediction,
          amount: v.amount,
          status: v.status || 'pending',
          txHash: v.txHash || null,
          won: null,
          claim: null
        }
      } else if (v.type === 'stakeConfirmed') {
        const s = state.stakes[v.staker]
        if (s) { s.status = 'confirmed'; s.txHash = v.txHash || s.txHash }
      } else if (v.type === 'result') {
        state.result = { matchId: v.matchId, outcome: v.outcome, txHash: v.txHash || null }
      } else if (v.type === 'claim') {
        const s = state.stakes[v.staker]
        if (s) s.claim = { txHash: v.txHash, payout: v.payout, status: 'claimed' }
      }
    }
    // once a result is known, mark each stake for that match won/lost
    if (state.result) {
      for (const s of Object.values(state.stakes)) {
        if (s.matchId === state.result.matchId) s.won = (Number(s.prediction) === Number(state.result.outcome))
      }
    }
    return state
  }

  async close () {
    await this.swarm.destroy()
    await this.base.close()
    await this.store.close()
  }
}

// Date.now() is unavailable in some sandboxed runtimes; guard it.
function dateNow () {
  try { return Date.now() } catch { return 0 }
}

module.exports = Room
