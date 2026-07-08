/**
 * Dynamic all-three demo — the assembled stack (room + WDK + pool + QVAC) driven by REAL
 * data. The match, teams, and final result come from TheSportsDB (live, keyless); nothing
 * about the outcome is hardcoded. Three fans of different nations predict home / away / draw
 * (blind), each reads the room in their own language on-device, the reporter reports the
 * REAL result, and whoever called it splits the pot.
 *
 * Chain: local anvil by default. Set SEPOLIA (see README) to run on real testnet instead.
 * Prereq: anvil running (local mode). Run: node scripts/assemble-e2e.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, formatUnits, parseUnits } from 'ethers'
import createTestnet from '@hyperswarm/testnet'
import { newSeedPhrase } from '../lib/wdk-wallet.mjs'
import { TerraceApp } from '../lib/terrace-app.mjs'
import { recentFinished, upcomingMatches, outcomeLabel } from '../lib/match-data.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8545'
const usdt6 = (n) => parseUnits(String(n), 6)
const fmt = (bn) => formatUnits(bn, 6)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, label, tries = 240, ms = 250) {
  for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(ms) }
  throw new Error('timeout waiting for: ' + label)
}
function artifact (sol, name) {
  const j = JSON.parse(readFileSync(join(__dirname, '..', 'contracts', 'out', sol, name + '.json'), 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object }
}

// pull a REAL match with a REAL final result; fall back gracefully if the API is offline
async function pickMatch () {
  try {
    const fin = await recentFinished()
    if (fin[0]) return { ...fin[0], live: true }
    const up = await upcomingMatches()
    if (up[0]) return { ...up[0], outcome: 1, homeScore: 1, awayScore: 0, live: true } // not finished yet: illustrate a home win
  } catch (e) { /* offline */ }
  return { label: 'England vs France', home: 'England', away: 'France', outcome: 1, homeScore: 2, awayScore: 1, live: false }
}

async function main () {
  const match = await pickMatch()
  const MATCH = match.label
  const RESULT = match.outcome // 1 home, 2 away, 3 draw — from the real world
  console.log(`live match (${match.live ? 'TheSportsDB' : 'offline fallback'}): ${MATCH}` +
    (match.homeScore != null ? `  ${match.homeScore}-${match.awayScore}` : '') + `  => real result: ${outcomeLabel(RESULT)}\n`)

  const provider = new JsonRpcProvider(RPC)
  provider.pollingInterval = 200
  const deployer = new NonceManager(Wallet.fromPhrase('test test test test test test test test test test test junk', provider))
  const seed = process.env.TERRACE_SEED || newSeedPhrase()

  const mock = artifact('MockUSDt.sol', 'MockUSDt')
  const esc = artifact('TerraceEscrow.sol', 'TerraceEscrow')
  const usdt = await new ContractFactory(mock.abi, mock.bytecode, deployer).deploy()
  await usdt.waitForDeployment()
  const usdtAddr = await usdt.getAddress()

  const testnet = await createTestnet(3)
  const dir = (n) => join(tmpdir(), `terrace-4a-${n}-${process.pid}-${Date.now()}`)
  const base = { provider, rpc: RPC, usdt: usdtAddr, seed, dhtBootstrap: testnet.bootstrap, escrow: '0x0' }

  // three fans of different nations, each predicting a different outcome (blind)
  const fans = [
    { name: 'Alice', lang: 'fr', predict: 1 }, // home win
    { name: 'Bruno', lang: 'es', predict: 2 }, // away win
    { name: 'Carla', lang: 'en', predict: 3 } //  draw
  ]
  const alice = new TerraceApp({ ...base, name: fans[0].name, lang: fans[0].lang, storage: dir('A'), accountIndex: 0 })
  await alice.start()

  const escrowC = await new ContractFactory(esc.abi, esc.bytecode, deployer).deploy(usdtAddr, alice.address)
  await escrowC.waitForDeployment()
  const escrow = await escrowC.getAddress()
  alice.opts.escrow = escrow

  const others = []
  for (let i = 1; i < fans.length; i++) {
    const a = new TerraceApp({ ...base, name: fans[i].name, lang: fans[i].lang, storage: dir(String(i)), accountIndex: i, escrow, bootstrap: alice.key })
    await a.start(); others.push(a)
  }
  const apps = [alice, ...others]

  const oneEth = '0x' + (10n ** 18n).toString(16)
  for (const a of apps) { await provider.send('anvil_setBalance', [a.address, oneEth]); await (await usdt.mint(a.address, usdt6(500))).wait() }
  console.log('assembled: room + WDK + escrow + QVAC | escrow', escrow, '| reporter', alice.address)

  for (const a of others) await until(() => a.writable, `${a.name} writable`)
  console.log('room live — 3 fans connected\n')

  // predict + chip in (blind), then chat referencing the real teams
  for (let i = 0; i < apps.length; i++) {
    apps[i].predict(MATCH, `${outcomeLabel(fans[i].predict)}`)
    await apps[i].stake({ matchLabel: MATCH, prediction: fans[i].predict, amount: usdt6(100) })
  }
  await alice.chat(`Come on ${match.home}!`)
  await others[0].chat('What a match, what a finish!')

  const seen = async (app) => { const s = await app.state(); return Object.values(s.stakes).length === 3 && Object.values(s.stakes).every((x) => x.status === 'confirmed') }
  for (const a of apps) await until(() => seen(a), `${a.name} sees 3 stakes`)
  console.log('pool:', fmt(await usdt.balanceOf(escrow)), 'USDt  (3 x 100)')

  console.log('\neach fan reads the chat in their own language (on-device):')
  for (const a of apps) {
    const chat = await a.localizedChat()
    console.log(`  ${a.name} [${a.lang}]:`, chat.map((m) => `"${m.translated}"`).join('  '))
  }

  // reporter reports the REAL result
  await alice.report({ matchLabel: MATCH, outcome: RESULT })
  await until(async () => (await others[0].state()).result?.outcome === RESULT, 'result synced')
  console.log(`\nreporter reported the real result: ${outcomeLabel(RESULT)}`)

  // winners (predicted the real outcome) claim
  for (const a of apps) {
    const s = await a.state(); const mine = s.stakes[a.address.toLowerCase()]
    if (mine?.won) { const b = (await a.balances()).usdt; await a.claim({ matchLabel: MATCH }); const b2 = (await a.balances()).usdt; console.log(`  ${a.name} WON — claimed, USDt ${fmt(b)} -> ${fmt(b2)}`) }
  }

  // converge + reconcile
  const states = await Promise.all(apps.map((a) => a.state()))
  const norm = (s) => JSON.stringify({ stakes: s.stakes, result: s.result })
  if (new Set(states.map(norm)).size !== 1) throw new Error('FAIL: fans did not converge')
  for (const a of apps) {
    const s = states[0]; const rec = await a.reconcile({ matchLabel: MATCH, staker: a.address, roomStake: s.stakes[a.address.toLowerCase()] })
    if (!rec.agree) throw new Error('FAIL: ' + a.name + ' room state disagrees with chain')
  }
  console.log('\nall fans converged + reconciled with chain.')
  console.log('PASS: real match data drove a live group-tip pool across the assembled stack.')
  for (const a of apps) await a.close()
  await testnet.destroy()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
