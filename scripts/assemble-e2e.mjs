/**
 * Stage 4a proof — the first time ALL THREE tracks run together in ONE process.
 *
 * Two TerraceApp peers, each assembling room + WDK wallet + stake bridge + QVAC translator.
 * Full flow through the single assembled surface:
 *   join -> predict -> stake (pending->confirmed) -> chat -> translate on read
 *        -> report -> claim -> reconcile AGREE
 *
 * Local anvil (chain) + local DHT testnet (discovery), exactly like the per-track E2Es.
 * Prereq: anvil running. Run: node scripts/assemble-e2e.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, formatUnits, parseUnits } from 'ethers'
import createTestnet from '@hyperswarm/testnet'
import { newSeedPhrase } from '../lib/wdk-wallet.mjs'
import { TerraceApp } from '../lib/terrace-app.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8545'
const usdt6 = (n) => parseUnits(String(n), 6)
const fmt = (bn) => formatUnits(bn, 6)
const MATCH = 'ENG-FRA'
const HOME = 1
const AWAY = 2
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, label, tries = 240, ms = 250) {
  for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(ms) }
  throw new Error('timeout waiting for: ' + label)
}
function artifact (sol, name) {
  const j = JSON.parse(readFileSync(join(__dirname, '..', 'contracts', 'out', sol, name + '.json'), 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object }
}

async function main () {
  const provider = new JsonRpcProvider(RPC)
  provider.pollingInterval = 200
  const deployer = new NonceManager(Wallet.fromPhrase('test test test test test test test test test test test junk', provider))
  const seed = process.env.TERRACE_SEED || newSeedPhrase()

  // deploy MockUSDt + escrow; reporter = peerA (account 0)
  const mock = artifact('MockUSDt.sol', 'MockUSDt')
  const esc = artifact('TerraceEscrow.sol', 'TerraceEscrow')
  const usdt = await new ContractFactory(mock.abi, mock.bytecode, deployer).deploy()
  await usdt.waitForDeployment()
  const usdtAddr = await usdt.getAddress()

  const testnet = await createTestnet(3)
  const cfg = { provider, rpc: RPC, usdt: usdtAddr, seed, dhtBootstrap: testnet.bootstrap }
  const dir = (n) => join(tmpdir(), `terrace-4a-${n}-${process.pid}-${Date.now()}`)

  // peerA: reads French, is the reporter; peerB: reads Spanish
  const alice = new TerraceApp({ ...cfg, name: 'Alice', lang: 'fr', storage: dir('A'), accountIndex: 0, escrow: '0x0' })
  await alice.start()
  const bruno = new TerraceApp({ ...cfg, name: 'Bruno', lang: 'es', storage: dir('B'), accountIndex: 1, escrow: '0x0', bootstrap: alice.key })

  // now deploy escrow with reporter = alice, then set escrow on both apps
  const escrowC = await new ContractFactory(esc.abi, esc.bytecode, deployer).deploy(usdtAddr, alice.address)
  await escrowC.waitForDeployment()
  const escrow = await escrowC.getAddress()
  alice.opts.escrow = escrow; bruno.opts.escrow = escrow
  await bruno.start()

  // fund both wallets (ETH gas + test USDt)
  const oneEth = '0x' + (10n ** 18n).toString(16)
  for (const a of [alice.address, bruno.address]) {
    await provider.send('anvil_setBalance', [a, oneEth])
    await (await usdt.mint(a, usdt6(500))).wait()
  }
  console.log('assembled: room + WDK + escrow + QVAC, two peers in one process')
  console.log('  escrow', escrow, '| reporter(Alice)', alice.address)

  await until(() => bruno.writable, 'bruno writable')
  console.log('  P2P room live (Bruno promoted to writer)\n')

  // --- predict + stake (Alice AWAY=lose, Bruno HOME=win) ---
  alice.predict(MATCH, 'AWAY 0-1'); bruno.predict(MATCH, 'HOME 2-1')
  await alice.stake({ matchLabel: MATCH, prediction: AWAY, amount: usdt6(100) })
  await bruno.stake({ matchLabel: MATCH, prediction: HOME, amount: usdt6(100) })

  // --- chat (English canonical) ---
  await alice.chat('Come on England!')
  await bruno.chat('What a goal, unbelievable!')

  const bothConfirmed = async (app) => {
    const s = await app.state(); const v = Object.values(s.stakes)
    return v.length === 2 && v.every((x) => x.status === 'confirmed') && s.messages.length === 2
  }
  await until(() => bothConfirmed(alice), 'Alice sees full state')
  await until(() => bothConfirmed(bruno), 'Bruno sees full state')

  // --- translate on read (on-device) ---
  console.log('Alice reads chat in FRENCH (on-device):')
  for (const r of await alice.localizedChat()) console.log(`   ${r.peer}: "${r.original}" -> "${r.translated}"`)
  console.log('Bruno reads chat in SPANISH (on-device):')
  for (const r of await bruno.localizedChat()) console.log(`   ${r.peer}: "${r.original}" -> "${r.translated}"`)

  // --- report + claim ---
  await alice.report({ matchLabel: MATCH, outcome: HOME })
  await until(async () => (await bruno.state()).result?.outcome === HOME, 'Bruno sees result')
  const before = (await bruno.balances()).usdt
  await bruno.claim({ matchLabel: MATCH })
  const after = (await bruno.balances()).usdt
  console.log(`\nBruno (winner) claimed: USDt ${fmt(before)} -> ${fmt(after)}  (+${fmt(after - before)})`)

  // --- converge + reconcile with chain ---
  const sA = await alice.state(); const sB = await bruno.state()
  const norm = (s) => JSON.stringify({ stakes: s.stakes, result: s.result })
  if (norm(sA) !== norm(sB)) throw new Error('FAIL: peers did not converge')
  const recA = await alice.reconcile({ matchLabel: MATCH, staker: alice.address, roomStake: sA.stakes[alice.address.toLowerCase()] })
  const recB = await bruno.reconcile({ matchLabel: MATCH, staker: bruno.address, roomStake: sA.stakes[bruno.address.toLowerCase()] })
  console.log('reconcile Alice:', recA.agree ? 'AGREE' : 'DISAGREE', '| reconcile Bruno:', recB.agree ? 'AGREE' : 'DISAGREE')
  if (!recA.agree || !recB.agree) throw new Error('FAIL: room state disagrees with chain')

  // --- final assembled state ---
  console.log('\nfinal shared state (both peers identical):')
  for (const [addr, s] of Object.entries(sA.stakes)) {
    console.log(`   ${s.peer}: ${s.prediction === HOME ? 'HOME' : 'AWAY'} ${fmt(s.amount)} USDt ${s.status}` +
      (s.won ? ' WON' : ' lost') + (s.claim ? ` claimed(+${fmt(s.claim.payout)})` : ''))
  }

  console.log('\nPASS: room + WDK staking + on-device translation all ran together in one process.')
  await alice.close(); await bruno.close(); await testnet.destroy()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
