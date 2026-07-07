/**
 * Stage 2a proof — deposit -> reportResult -> claim, end to end, on a local anvil node,
 * with every stake/report/claim transaction SIGNED BY A WDK SELF-CUSTODIAL ACCOUNT.
 *
 * Why local anvil instead of Sepolia: the flow needs a funded staker (ETH for gas +
 * test USDt). Sepolia funding depends on faucets a script can't drive. anvil lets us
 * prove the exact same contract + WDK code path deterministically and for free. The
 * identical flow runs on Sepolia once the wallet is faucet-funded (see README / the
 * Sepolia deploy script).
 *
 * Prereq: anvil running -> `anvil` (defaults to http://127.0.0.1:8545)
 * Run:    node scripts/escrow-local-e2e.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  JsonRpcProvider, Wallet, NonceManager, ContractFactory, Contract, formatUnits, parseUnits
} from 'ethers'
import {
  newSeedPhrase, makeAccount, matchId, ESCROW_ABI, USDT_ABI, callContract
} from '../lib/wdk-wallet.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8545'
const usdt6 = (n) => parseUnits(String(n), 6)
const fmt = (bn) => formatUnits(bn, 6)

function artifact (sol, name) {
  const p = join(__dirname, '..', 'contracts', 'out', sol, name + '.json')
  const j = JSON.parse(readFileSync(p, 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object }
}

async function main () {
  const provider = new JsonRpcProvider(RPC)
  provider.pollingInterval = 200
  // Direct receipt poll — robust against ethers' waitForTransaction stalling on
  // instant-mining local nodes.
  const mined = async (hash, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      const r = await provider.getTransactionReceipt(hash)
      if (r) return r
      await new Promise((res) => setTimeout(res, 250))
    }
    throw new Error('tx not mined in time: ' + hash)
  }
  // anvil's well-known deterministic dev account #0 (public test mnemonic — NOT a secret).
  // Used only as the local deployer + faucet, never as the wallet under test.
  const deployer = new NonceManager(Wallet.fromPhrase(
    'test test test test test test test test test test test junk', provider
  ))

  // --- deploy MockUSDt + TerraceEscrow (reporter = host WDK account) ---
  const mock = artifact('MockUSDt.sol', 'MockUSDt')
  const esc = artifact('TerraceEscrow.sol', 'TerraceEscrow')

  const usdt = await new ContractFactory(mock.abi, mock.bytecode, deployer).deploy()
  await usdt.waitForDeployment()
  const usdtAddr = await usdt.getAddress()

  // WDK self-custodial accounts (two accounts derived from one seed on this device)
  const seed = process.env.TERRACE_SEED || newSeedPhrase()
  const host = await makeAccount({ seed, index: 0, provider: RPC }) // reporter
  const staker = await makeAccount({ seed, index: 1, provider: RPC })
  const hostAddr = await host.getAddress()
  const stakerAddr = await staker.getAddress()

  const escrow = await new ContractFactory(esc.abi, esc.bytecode, deployer).deploy(usdtAddr, hostAddr)
  await escrow.waitForDeployment()
  const escrowAddr = await escrow.getAddress()

  // fund gas for the WDK accounts + mint test USDt to the staker
  const oneEth = '0x' + (10n ** 18n).toString(16)
  await provider.send('anvil_setBalance', [hostAddr, oneEth])
  await provider.send('anvil_setBalance', [stakerAddr, oneEth])
  await (await usdt.mint(stakerAddr, usdt6(1000))).wait()

  console.log('contracts:')
  console.log('  MockUSDt     ', usdtAddr)
  console.log('  TerraceEscrow', escrowAddr)
  console.log('wallets (WDK self-custody):')
  console.log('  host/reporter', hostAddr)
  console.log('  staker       ', stakerAddr)

  const mId = matchId('ENG-FRA')
  const HOME = 1
  const STAKE = usdt6(100)

  const escrowRead = new Contract(escrowAddr, ESCROW_ABI, provider)

  const stakerBalBefore = await staker.getTokenBalance(usdtAddr)
  console.log('\n--- BEFORE ---')
  console.log('  staker USDt   ', fmt(stakerBalBefore))
  console.log('  escrow USDt   ', fmt(await usdt.balanceOf(escrowAddr)))

  const nonceOf = (addr) => provider.getTransactionCount(addr, 'latest')
  const step = (m) => console.error('  [step]', m)

  // 1) approve + deposit — signed by the WDK staker account
  step('approve...')
  const apv = await staker.approve({ token: usdtAddr, spender: escrowAddr, amount: STAKE })
  step('approve sent ' + apv.hash + ' — waiting mine')
  await mined(apv.hash)
  step('deposit...')
  const dep = await callContract(staker, {
    to: escrowAddr, abi: ESCROW_ABI, fn: 'deposit', args: [mId, HOME, STAKE], nonce: await nonceOf(stakerAddr)
  })
  await mined(dep.hash)
  step('deposit mined')
  console.log('\n--- AFTER DEPOSIT (staker stakes 100 on HOME) ---')
  console.log('  staker USDt   ', fmt(await staker.getTokenBalance(usdtAddr)))
  console.log('  escrow USDt   ', fmt(await usdt.balanceOf(escrowAddr)))
  console.log('  pool          ', fmt(await escrowRead.poolOf(mId)))

  // 2) reportResult — signed by the WDK host (the designated reporter)
  const rep = await callContract(host, {
    to: escrowAddr, abi: ESCROW_ABI, fn: 'reportResult', args: [mId, HOME], nonce: await nonceOf(hostAddr)
  })
  await mined(rep.hash)
  console.log('\n--- AFTER REPORT (reporter says HOME won) ---')

  // 3) claim — signed by the WDK staker account
  const clm = await callContract(staker, {
    to: escrowAddr, abi: ESCROW_ABI, fn: 'claim', args: [mId], nonce: await nonceOf(stakerAddr)
  })
  await mined(clm.hash)
  const stakerBalAfter = await staker.getTokenBalance(usdtAddr)
  console.log('\n--- AFTER CLAIM (sole winner pulls the pool) ---')
  console.log('  staker USDt   ', fmt(stakerBalAfter))
  console.log('  escrow USDt   ', fmt(await usdt.balanceOf(escrowAddr)))

  // assertions
  const netChange = stakerBalAfter - stakerBalBefore
  console.log('\nresult: staker net USDt change =', fmt(netChange), '(expected 0 — got its own stake back as sole winner)')
  if (netChange !== 0n) throw new Error('FAIL: staker did not recover the pool')
  const escFinal = await usdt.balanceOf(escrowAddr)
  if (escFinal !== 0n) throw new Error('FAIL: escrow not drained, left ' + fmt(escFinal))
  console.log('PASS: deposit -> report -> claim verified end to end via WDK signing.')
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
