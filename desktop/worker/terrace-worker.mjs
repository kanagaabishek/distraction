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
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, parseUnits, formatUnits } from 'ethers'
import createTestnet from '@hyperswarm/testnet'
import { TerraceApp } from '../../lib/terrace-app.mjs'
import { newSeedPhrase } from '../../lib/wdk-wallet.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const send = (m) => { try { process.send?.(m) } catch { /* parent gone */ } }
const log = (msg) => send({ evt: 'log', msg })
const usdt6 = (n) => parseUnits(String(n), 6)
const fmt = (bn) => formatUnits(bn ?? 0n, 6)

let app = null
let opts = null // { provider, rpc, escrow, usdt, deployer, dev }

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
  const rpc = msg.rpc || process.env.LOCAL_RPC || 'http://127.0.0.1:8545'
  const provider = new JsonRpcProvider(rpc)
  provider.pollingInterval = 250
  const seed = process.env.TERRACE_SEED || newSeedPhrase()
  const dev = msg.dev !== false // default: local dev mode (deploy+fund on anvil)

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
    escrow: invite?.escrow || msg.escrow || '0x0000000000000000000000000000000000000000',
    usdt: invite?.usdt || msg.usdt || '0x0000000000000000000000000000000000000000'
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

  try { app.room.onpeer = (n) => log(`[${app.name}] connections=${n}`) } catch { /* */ }
  log(`[${app.name}] mode=${msg.mode} writable=${app.writable} dht=${dhtBootstrap ? JSON.stringify(dhtBootstrap) : 'public'}`)
  app.onupdate = () => { pushState().catch(() => {}) }
  setInterval(() => pushState().catch(() => {}), 2000)

  send({
    evt: 'ready',
    name: app.name,
    address: app.address,
    lang: app.lang,
    invite: { roomKey: app.key, escrow: app.opts.escrow, usdt: app.opts.usdt, dhtBootstrap }
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
  handle(m).catch((e) => send({ evt: 'error', msg: String(e?.stack || e) }))
})

async function handle (m) {
  switch (m.cmd) {
    case 'start': return start(m)
    case 'predict': app?.predict(m.matchLabel, m.pick); return pushState()
    case 'chat': app?.chat(m.text); return pushState()
    case 'postScore': app?.postScore(m.matchLabel, m.home, m.away); return pushState()
    case 'setLang': if (app) { app.translator.target = m.lang; app.lang = m.lang } return pushState()
    case 'stake':
      log(`staking ${m.amount} USDt on ${m.matchLabel}...`)
      await app.stake({ matchLabel: m.matchLabel, prediction: m.prediction, amount: usdt6(m.amount) })
      log('stake confirmed on-chain'); return pushState()
    case 'report':
      await app.report({ matchLabel: m.matchLabel, outcome: m.outcome }); log('result reported'); return pushState()
    case 'claim':
      log('claiming...'); await app.claim({ matchLabel: m.matchLabel }); log('claimed'); return pushState()
    case 'refresh': return pushState()
    default: return
  }
}

send({ evt: 'log', msg: 'worker booted (Node)' })
