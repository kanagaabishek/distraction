/**
 * Stage 2b proof — staking wired into the P2P room, end to end, on local anvil.
 *
 * Two room peers (real multi-writer Autobase, replicating over Hyperswarm) each with a
 * WDK self-custodial account:
 *   - peerA stakes on AWAY (will lose), peerB stakes on HOME (will win)
 *   - each stake appears PENDING in the shared state instantly, then CONFIRMED after the
 *     on-chain deposit receipt — and the OTHER peer sees it too (multi-writer sync)
 *   - reporter (peerA/host) reports HOME on-chain; the room mirrors the result
 *   - peerB (winner) claims on-chain; the room records the claim + payout
 *   - both peers converge to identical final state
 *   - room state is reconciled against the on-chain escrow (contract is source of truth)
 *
 * Two Room writers run in one Node process purely to coordinate the shared chain; each is
 * a genuine independent Autobase writer. Pure-P2P two-process sync stays covered by
 * scripts/two-peer-test.sh (Phase 1 regression).
 *
 * Prereq: anvil running. Run: node scripts/stake-flow-e2e.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  JsonRpcProvider, Wallet, NonceManager, ContractFactory, formatUnits, parseUnits
} from 'ethers'
import createTestnet from '@hyperswarm/testnet'
import Room from '../lib/room.js'
import { makeAccount, newSeedPhrase } from '../lib/wdk-wallet.mjs'
import { stake, report, claim, reconcile } from '../lib/stake-bridge.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8545'
const usdt6 = (n) => parseUnits(String(n), 6)
const fmt = (bn) => formatUnits(bn, 6)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MATCH = 'ENG-FRA'
const HOME = 1
const AWAY = 2

function artifact (sol, name) {
  const j = JSON.parse(readFileSync(join(__dirname, '..', 'contracts', 'out', sol, name + '.json'), 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object }
}

async function until (fn, label, tries = 160, ms = 250) {
  for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(ms) }
  throw new Error('timeout waiting for: ' + label)
}

function fmtStakes (stakes) {
  return Object.values(stakes).map((s) =>
    `${s.peer}(${s.staker?.slice(0, 8) ?? ''}) pred=${s.prediction} amt=${fmt(s.amount)} ${s.status}` +
    (s.won == null ? '' : s.won ? ' WON' : ' lost') +
    (s.claim ? ` claimed(+${fmt(s.claim.payout)})` : '')).join('\n    ')
}

async function main () {
  const provider = new JsonRpcProvider(RPC)
  provider.pollingInterval = 200
  const deployer = new NonceManager(Wallet.fromPhrase(
    'test test test test test test test test test test test junk', provider))

  // --- accounts (WDK self-custody) ---
  const seed = process.env.TERRACE_SEED || newSeedPhrase()
  const accA = await makeAccount({ seed, index: 0, provider: RPC }) // host + reporter
  const accB = await makeAccount({ seed, index: 1, provider: RPC })
  const aAddr = await accA.getAddress()
  const bAddr = await accB.getAddress()

  // --- deploy MockUSDt + escrow (reporter = peerA) + fund ---
  const mock = artifact('MockUSDt.sol', 'MockUSDt')
  const esc = artifact('TerraceEscrow.sol', 'TerraceEscrow')
  const usdt = await new ContractFactory(mock.abi, mock.bytecode, deployer).deploy()
  await usdt.waitForDeployment()
  const usdtAddr = await usdt.getAddress()
  const escrowC = await new ContractFactory(esc.abi, esc.bytecode, deployer).deploy(usdtAddr, aAddr)
  await escrowC.waitForDeployment()
  const escrow = await escrowC.getAddress()

  const oneEth = '0x' + (10n ** 18n).toString(16)
  for (const a of [aAddr, bAddr]) {
    await provider.send('anvil_setBalance', [a, oneEth])
    await (await usdt.mint(a, usdt6(500))).wait()
  }
  console.log('escrow', escrow, '| usdt', usdtAddr, '| reporter', aAddr)

  // --- P2P rooms: peerA creates, peerB joins; wait until peerB is a writer ---
  // Local DHT testnet -> deterministic, instant discovery for two peers on one machine.
  const testnet = await createTestnet(3)
  console.log('testnet bootstrap:', JSON.stringify(testnet.bootstrap))
  const dir = (n) => join(tmpdir(), `terrace-2b-${n}-${process.pid}-${Date.now()}`)
  const roomA = new Room({ storage: dir('A'), name: 'peerA', dhtBootstrap: testnet.bootstrap })
  roomA.onpeer = (n) => console.log('  [roomA] connections:', n)
  await roomA.ready()
  const roomB = new Room({ storage: dir('B'), name: 'peerB', bootstrap: roomA.key, dhtBootstrap: testnet.bootstrap })
  roomB.onpeer = (n) => console.log('  [roomB] connections:', n)
  await roomB.ready()
  console.log('room', roomA.key, 'peerA.writable=', roomA.writable, '\nwaiting for peerB to be promoted to writer (P2P discovery)...')
  await until(() => roomB.writable, 'peerB writable', 240)
  console.log('peerB is a writer — multi-writer room live')

  // --- PHASE 1: stake (pending -> confirmed), mirrored to both peers ---
  const STAKE = usdt6(100)
  await stake(roomA, accA, { provider, escrow, usdt: usdtAddr, matchLabel: MATCH, prediction: AWAY, amount: STAKE })
  await stake(roomB, accB, { provider, escrow, usdt: usdtAddr, matchLabel: MATCH, prediction: HOME, amount: STAKE })

  // both peers must see BOTH stakes, confirmed
  const bothConfirmed = async (room) => {
    const s = (await room.getState()).stakes
    const vals = Object.values(s)
    return vals.length === 2 && vals.every((x) => x.status === 'confirmed')
  }
  await until(() => bothConfirmed(roomA), 'roomA sees 2 confirmed stakes')
  await until(() => bothConfirmed(roomB), 'roomB sees 2 confirmed stakes')
  console.log('\n[peerA view] stakes:\n   ', fmtStakes((await roomA.getState()).stakes))
  console.log('[peerB view] stakes:\n   ', fmtStakes((await roomB.getState()).stakes))
  console.log('escrow pool USDt:', fmt(await usdt.balanceOf(escrow)))

  // --- PHASE 2: reporter reports HOME; both peers see the result ---
  await report(roomA, accA, { provider, escrow, matchLabel: MATCH, outcome: HOME })
  await until(async () => (await roomB.getState()).result?.outcome === HOME, 'roomB sees result')
  console.log('\nresult reported: HOME won (both peers see it)')

  // --- PHASE 3: winner (peerB) claims; both peers see the claim ---
  const bBefore = await accB.getTokenBalance(usdtAddr)
  const res = await claim(roomB, accB, { provider, escrow, usdt: usdtAddr, matchLabel: MATCH })
  await until(async () => (await roomA.getState()).stakes[bAddr.toLowerCase()]?.claim != null, 'roomA sees claim')
  console.log(`peerB claimed payout +${fmt(res.payout)} USDt (balance ${fmt(bBefore)} -> ${fmt(await accB.getTokenBalance(usdtAddr))})`)

  // --- converge: both peers identical final state ---
  const finalA = await roomA.getState()
  const finalB = await roomB.getState()
  const norm = (s) => JSON.stringify({ stakes: s.stakes, result: s.result })
  console.log('\n[peerA final] stakes:\n   ', fmtStakes(finalA.stakes))
  console.log('[peerB final] stakes:\n   ', fmtStakes(finalB.stakes))
  if (norm(finalA) !== norm(finalB)) throw new Error('FAIL: peers did not converge')
  console.log('converged: both peers agree on stakes + result')

  // --- reconcile room mirror vs on-chain source of truth ---
  const recA = await reconcile(provider, { escrow, matchLabel: MATCH, staker: aAddr, roomStake: finalA.stakes[aAddr.toLowerCase()] })
  const recB = await reconcile(provider, { escrow, matchLabel: MATCH, staker: bAddr, roomStake: finalA.stakes[bAddr.toLowerCase()] })
  console.log('\nreconcile peerA (room vs chain):', recA.agree ? 'AGREE' : 'DISAGREE', JSON.stringify(recA.onchain))
  console.log('reconcile peerB (room vs chain):', recB.agree ? 'AGREE' : 'DISAGREE', JSON.stringify(recB.onchain))
  if (!recA.agree || !recB.agree) throw new Error('FAIL: room state disagrees with the contract')

  // sanity: winner recovered pool, loser did not, escrow drained
  if (finalA.stakes[bAddr.toLowerCase()].won !== true) throw new Error('FAIL: winner not marked won')
  if (finalA.stakes[aAddr.toLowerCase()].won !== false) throw new Error('FAIL: loser not marked lost')
  const escLeft = await usdt.balanceOf(escrow)
  if (escLeft !== 0n) throw new Error('FAIL: escrow not drained, left ' + fmt(escLeft))

  console.log('\nPASS: stake -> report -> claim reflected in shared room state, converged, and reconciled with chain.')
  await roomA.close(); await roomB.close()
  await testnet.destroy()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
