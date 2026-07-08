/**
 * Terrace worker (Phase 4b) — the Node worker behind the desktop shell.
 *
 * Runs the SAME proven assembled core (lib/terrace-app.mjs = room + WDK + pool + QVAC).
 * It is a Node worker (child_process.fork) — NOT a pear-runtime Bare worker — because the
 * assembled core needs Node (WDK + ethers + the QVAC client; QVAC spawns its own Bare
 * worker internally). This is the documented Bare-vs-Node split the brief calls for.
 *
 * IPC: parent <-> worker over process message channel (fork).
 *   parent -> worker: { cmd: 'start'|'predict'|'chat'|'setLang'|'stake'|'report'|'claim'|'refresh', ... }
 *   worker -> parent: { evt: 'ready'|'state'|'log'|'error', ... }
 *
 * Because it's a plain forkable Node module, scripts/worker-e2e.mjs drives it headlessly
 * with no Electron — the GUI's entire brain is testable from the terminal.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, Interface, parseUnits, formatUnits } from 'ethers'
import createTestnet from '@hyperswarm/testnet'
import { TerraceApp } from '../../lib/terrace-app.mjs'
import { newSeedPhrase } from '../../lib/wdk-wallet.mjs'
import { recentFinished, upcomingMatches, getResult, outcomeLabel } from '../../lib/match-data.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const send = (m) => { try { process.send?.(m) } catch { /* parent gone */ } }
const log = (msg) => send({ evt: 'log', msg })
const usdt6 = (n) => parseUnits(String(n), 6)
const fmt = (bn) => formatUnits(bn ?? 0n, 6)

let app = null
let opts = null // { provider, rpc, escrow, usdt, deployer, dev }
let match = null // { label, home, away, id, outcome? } — the real fixture this room is on
let isReporter = false // is THIS wallet the escrow's designated reporter?
let stateTimer = null // periodic pushState timer (cleared on leave/restart)

async function readReporter (provider, escrow, myAddr) {
  try {
    const iface = new Interface(['function reporter() view returns (address)'])
    const raw = await provider.call({ to: escrow, data: iface.encodeFunctionData('reporter', []) })
    const rep = iface.decodeFunctionResult('reporter', raw)[0]
    return { reporter: rep, isReporter: rep.toLowerCase() === myAddr.toLowerCase() }
  } catch { return { reporter: null, isReporter: false } }
}

async function pickMatch () {
  try {
    const fin = await recentFinished()
    if (fin[0]) return fin[0]
    const up = await upcomingMatches()
    if (up[0]) return up[0]
  } catch { /* offline */ }
  return { label: 'England vs France', home: 'England', away: 'France', id: null, finished: false, outcome: null }
}

function artifact (sol, name) {
  const j = JSON.parse(readFileSync(join(__dirname, '..', '..', 'contracts', 'out', sol, name + '.json'), 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object }
}

/** Local dev chain: deploy the pool + a test token and fund a wallet, so the app is usable offline. */
async function devDeployAndFund (provider, reporterAddr, existing) {
  const deployer = new NonceManager(Wallet.fromPhrase('test test test test test test test test test test test junk', provider))
  let usdt = existing?.usdt
  let escrow = existing?.escrow
  if (!usdt) {
    const m = artifact('MockUSDt.sol', 'MockUSDt')
    const c = await new ContractFactory(m.abi, m.bytecode, deployer).deploy()
    await c.waitForDeployment(); usdt = await c.getAddress()
  }
  if (!escrow) {
    const e = artifact('TerraceEscrow.sol', 'TerraceEscrow')
    const c = await new ContractFactory(e.abi, e.bytecode, deployer).deploy(usdt, reporterAddr)
    await c.waitForDeployment(); escrow = await c.getAddress()
  }
  return { usdt, escrow, deployer }
}

async function fundWallet (provider, deployer, usdtAddr, addr) {
  await provider.send('anvil_setBalance', [addr, '0x' + (10n ** 18n).toString(16)])
  const m = artifact('MockUSDt.sol', 'MockUSDt')
  const token = new ContractFactory(m.abi, m.bytecode, deployer).attach(usdtAddr)
  await (await token.mint(addr, usdt6(500))).wait()
}

async function start (msg) {
  // Chain target: local anvil by default; if SEPOLIA_RPC_URL is set, target real testnet
  // (no auto-deploy/fund — the pool + wallet must already be funded there).
  const rpc = msg.rpc || process.env.SEPOLIA_RPC_URL || process.env.LOCAL_RPC || 'http://127.0.0.1:8545'
  const provider = new JsonRpcProvider(rpc)
  provider.pollingInterval = 250
  const seed = process.env.TERRACE_SEED || newSeedPhrase()
  const dev = msg.dev !== undefined ? msg.dev : !process.env.SEPOLIA_RPC_URL

  // invite (for join) carries the escrow + token + local DHT bootstrap so both peers use
  // the same pool and discover each other deterministically (host runs the local testnet;
  // two windows on one machine find each other instantly). Cross-machine would use the
  // public DHT instead (omit dhtBootstrap).
  const invite = msg.invite || null
  const bootstrap = msg.mode === 'join' ? (invite?.roomKey || msg.key) : undefined
  let dhtBootstrap = invite?.dhtBootstrap || msg.dhtBootstrap || null
  if (msg.mode !== 'join' && !dhtBootstrap && msg.localDiscovery !== false) {
    const testnet = await createTestnet(3)
    dhtBootstrap = testnet.bootstrap
  }

  // the real fixture this room is playing on (host picks it; joiner inherits it via invite)
  match = msg.mode === 'join' ? (invite?.match || await pickMatch()) : await pickMatch()

  // We need the wallet address before deploying (reporter = creator). Build the app first
  // with placeholder pool addresses, then fill them in before any on-chain action.
  app = new TerraceApp({
    name: msg.name || (msg.mode === 'join' ? 'Guest' : 'Host'),
    lang: msg.lang || 'en',
    storage: join(tmpdir(), `terrace-desktop-${process.pid}-${Date.now()}`),
    bootstrap,
    dhtBootstrap,
    provider,
    rpc,
    seed,
    accountIndex: msg.accountIndex ?? 0,
    escrow: invite?.escrow || msg.escrow || process.env.ESCROW_ADDRESS || '0x0000000000000000000000000000000000000000',
    usdt: invite?.usdt || msg.usdt || process.env.USDT_ADDRESS || '0x0000000000000000000000000000000000000000'
  })
  await app.start()

  if (dev) {
    const existing = invite ? { escrow: invite.escrow, usdt: invite.usdt } : (msg.escrow ? { escrow: msg.escrow, usdt: msg.usdt } : null)
    const { escrow, usdt, deployer } = await devDeployAndFund(provider, app.address, existing)
    app.opts.escrow = escrow; app.opts.usdt = usdt
    opts = { provider, rpc, escrow, usdt, deployer, dev }
    await fundWallet(provider, deployer, usdt, app.address)
  } else {
    opts = { provider, rpc, escrow: app.opts.escrow, usdt: app.opts.usdt, dev }
  }

  // who can settle this pool? (the escrow's reporter, fixed at deploy)
  const rep = await readReporter(provider, app.opts.escrow, app.address)
  isReporter = rep.isReporter
  if (!isReporter && rep.reporter) log(`only the reporter (${rep.reporter.slice(0, 8)}…) can settle this pool`)

  try { app.room.onpeer = (n) => log(`[${app.name}] connections=${n}`) } catch { /* */ }
  log(`[${app.name}] mode=${msg.mode} writable=${app.writable} dht=${dhtBootstrap ? JSON.stringify(dhtBootstrap) : 'public'}`)
  app.onupdate = () => { pushState().catch(() => {}) }
  if (stateTimer) clearInterval(stateTimer)
  stateTimer = setInterval(() => pushState().catch(() => {}), 2000)

  send({
    evt: 'ready',
    name: app.name,
    address: app.address,
    lang: app.lang,
    match,
    isReporter,
    reporter: rep.reporter,
    chain: dev ? 'local anvil (test money)' : 'Sepolia testnet',
    invite: { roomKey: app.key, escrow: app.opts.escrow, usdt: app.opts.usdt, dhtBootstrap, match }
  })
  await pushState()
}

// Serialize state pushes: QVAC translate() calls on one model must not overlap (the RPC
// worker crosses responses if they do), and localize() runs inside pushState. Only one runs
// at a time; a request that arrives mid-flight coalesces into a single follow-up run.
let _pushing = false
let _pushQueued = false
async function pushState () {
  if (_pushing) { _pushQueued = true; return }
  _pushing = true
  try { await _pushState() } finally {
    _pushing = false
    if (_pushQueued) { _pushQueued = false; pushState() }
  }
}

async function _pushState () {
  if (!app) return
  const s = await app.state()
  let chat = []
  try { chat = await app.localizedChat() } catch { chat = s.messages.map((m) => ({ peer: m.peer, original: m.text, translated: m.text })) }
  let bal = { eth: '0', usdt: '0' }
  try { const b = await app.balances(); bal = { eth: (Number(b.eth) / 1e18).toFixed(4), usdt: fmt(b.usdt) } } catch { /* rpc */ }
  const stakes = Object.fromEntries(Object.entries(s.stakes).map(([k, v]) => [k, { ...v, amount: fmt(v.amount), claim: v.claim ? { ...v.claim, payout: fmt(v.claim.payout) } : null }]))
  send({
    evt: 'state',
    writable: app.writable,
    roomKey: app.key,
    match,
    isReporter,
    address: app.address,
    lang: app.lang,
    balances: bal,
    predictions: s.predictions,
    messages: chat, // [{peer, original, translated}]
    score: s.score,
    result: s.result,
    stakes
  })
}

process.on('message', (m) => {
  handle(m).catch((e) => send({ evt: 'error', msg: e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e) }))
})

// On-chain match key, scoped to THIS room so a repeat demo on the same fixture doesn't
// collide ("already reported/staked") with a past room. All peers in a room share app.key,
// so they agree on it; a new room -> a fresh pool.
const poolKey = () => `${match?.label || 'match'}#${(app?.key || '').slice(0, 10)}`

// Run an on-chain op with a busy signal (so the UI can block Leave) and graceful handling
// if the user leaves mid-tx: the tx is already broadcast and the contract settles it on its
// own; here we just avoid throwing a scary error into a torn-down room.
async function runTx (fn, doneMsg) {
  if (!app) return
  send({ evt: 'busy', busy: true })
  try { await fn(); if (app && doneMsg) log(doneMsg) }
  catch (e) { if (app) throw e } // left mid-tx -> swallow the late callback
  finally { send({ evt: 'busy', busy: false }) }
  if (app) return pushState()
}

async function handle (m) {
  switch (m.cmd) {
    case 'start': return start(m)
    case 'predict': app?.predict(m.matchLabel, m.pick); return pushState()
    case 'chat': app?.chat(m.text); return pushState()
    case 'postScore': app?.postScore(m.matchLabel, m.home, m.away); return pushState()
    case 'setLang': if (app) { app.translator.target = m.lang; app.lang = m.lang } return pushState()
    case 'stake': {
      // guard BEFORE appending the pending record: one chip-in per wallet per match (matches
      // the contract). Without this, a repeat chip-in writes a phantom pending that then
      // reverts on-chain ("already staked"), making it look like money moved when it didn't.
      const st = await app.state()
      if (st.stakes[(app.address || '').toLowerCase()]) { send({ evt: 'error', msg: 'You already chipped into this pool (one stake per match).' }); return }
      if (st.result) { send({ evt: 'error', msg: 'This match is already settled — chip-in is closed.' }); return }
      log(`staking ${m.amount} USDt...`)
      return runTx(() => app.stake({ matchLabel: poolKey(), prediction: m.prediction, amount: usdt6(m.amount) }), 'stake confirmed on-chain')
    }
    case 'report':
      return runTx(() => app.report({ matchLabel: poolKey(), outcome: m.outcome }), 'result reported')
    case 'autoReport': {
      if (!match?.id) return log('no live fixture id to auto-report')
      return runTx(async () => {
        log('fetching real result from TheSportsDB…')
        const r = await getResult(match.id)
        if (!r?.finished) { log(`match not finished yet (status ${r?.status || '?'})`); return }
        await app.report({ matchLabel: poolKey(), outcome: r.outcome })
        log(`reported REAL result: ${r.home} ${r.homeScore}-${r.awayScore} ${r.away} (${outcomeLabel(r.outcome)})`)
      })
    }
    case 'claim':
      log('claiming...')
      return runTx(() => app.claim({ matchLabel: poolKey() }), 'claimed')
    case 'refresh': return pushState()
    case 'leave': {
      if (stateTimer) { clearInterval(stateTimer); stateTimer = null }
      const a = app; app = null; match = null; isReporter = false
      try { await a?.close() } catch { /* ignore */ }
      send({ evt: 'left' })
      return
    }
    default: return
  }
}

send({ evt: 'log', msg: 'worker booted (Node)' })
