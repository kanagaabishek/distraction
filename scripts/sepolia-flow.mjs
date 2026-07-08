/**
 * LIVE Sepolia proof — deposit -> report -> claim on real Sepolia, staking signed by a WDK
 * self-custodial account. Everything is bootstrapped from account[0] (the only funded
 * wallet): it deploys a test USDt + the escrow, mints USDt to the staker, and sends it a
 * little gas. Then the staker (account[1], WDK) chips in, the reporter (account[0]) reports,
 * and the staker claims — all real transactions with Etherscan links.
 *
 * Run: node scripts/sepolia-flow.mjs   (reads .env: TERRACE_SEED, SEPOLIA_RPC_URL)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, Contract, Interface, parseUnits, formatUnits, formatEther, id as keccakId } from 'ethers'
import { makeAccount, callContract, ESCROW_ABI, waitMined } from '../lib/wdk-wallet.mjs'

try { process.loadEnvFile('.env') } catch {}
const __dirname = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.SEPOLIA_RPC_URL || 'https://sepolia.drpc.org'
const seed = process.env.TERRACE_SEED
if (!seed) { console.error('✖ run: npm run wallet:info'); process.exit(1) }
const art = (sol, n) => JSON.parse(readFileSync(join(__dirname, '..', 'contracts', 'out', sol, n + '.json'), 'utf8'))
const ES = (h) => `https://sepolia.etherscan.io/tx/${h}`
const fmt = (b) => formatUnits(b, 6)
const HOME = 1
const MATCH = 'ENG-FRA'

async function main () {
  const provider = new JsonRpcProvider(RPC)
  const admin = new NonceManager(Wallet.fromPhrase(seed).connect(provider)) // account[0]
  const adminAddr = await admin.getAddress()
  const staker = await makeAccount({ seed, index: 1, provider: RPC }) // account[1], WDK
  const stakerAddr = await staker.getAddress()
  console.log('admin/reporter (acct0):', adminAddr)
  console.log('staker (acct1, WDK)   :', stakerAddr)
  console.log('ETH acct0:', formatEther(await provider.getBalance(adminAddr)), '\n')

  // 1) test USDt: reuse an already-deployed one (USDT_ADDRESS) or deploy fresh, then mint
  const m = art('MockUSDt.sol', 'MockUSDt')
  let usdt
  if ((process.env.USDT_ADDRESS || '').trim()) {
    usdt = new Contract((process.env.USDT_ADDRESS).trim(), m.abi, admin)
    console.log('▶ reusing test USDt:', await usdt.getAddress())
  } else {
    console.log('▶ deploying test USDt…')
    usdt = await new ContractFactory(m.abi, m.bytecode.object, admin).deploy()
    await usdt.waitForDeployment()
    console.log('  USDt:', await usdt.getAddress())
  }
  const usdtAddr = await usdt.getAddress()
  await (await usdt.mint(stakerAddr, parseUnits('200', 6))).wait(1)
  console.log('  minted 200 USDt to staker')

  // 2) fund staker with a little gas
  console.log('▶ sending 0.008 ETH to staker for gas…')
  await (await admin.sendTransaction({ to: stakerAddr, value: parseUnits('0.008', 18) })).wait()

  // 3) deploy escrow (reporter = admin)
  console.log('▶ deploying TerraceEscrow…')
  const e = art('TerraceEscrow.sol', 'TerraceEscrow')
  const escrowC = await new ContractFactory(e.abi, e.bytecode.object, admin).deploy(usdtAddr, adminAddr)
  await escrowC.waitForDeployment()
  const escrow = await escrowC.getAddress()
  console.log('  escrow:', escrow, '\n')

  const mId = keccakId(MATCH)
  const nonceOf = (a) => provider.getTransactionCount(a, 'latest')
  const STAKE = parseUnits('100', 6)

  console.log('--- BEFORE --- staker USDt:', fmt(await staker.getTokenBalance(usdtAddr)))

  // 4) staker approve + deposit (WDK-signed)
  const apv = await staker.approve({ token: usdtAddr, spender: escrow, amount: STAKE })
  console.log('approve  ', ES(apv.hash)); await waitMined(provider, apv.hash)
  const dep = await callContract(staker, { to: escrow, abi: ESCROW_ABI, fn: 'deposit', args: [mId, HOME, STAKE], nonce: await nonceOf(stakerAddr) })
  console.log('deposit  ', ES(dep.hash)); await waitMined(provider, dep.hash)
  console.log('--- AFTER DEPOSIT --- staker USDt:', fmt(await staker.getTokenBalance(usdtAddr)), '| escrow USDt:', fmt(await usdt.balanceOf(escrow)))

  // 5) reporter reports HOME (admin, ethers)
  const iface = new Interface(ESCROW_ABI)
  const rep = await admin.sendTransaction({ to: escrow, data: iface.encodeFunctionData('reportResult', [mId, HOME]) })
  console.log('report   ', ES(rep.hash)); await rep.wait()

  // 6) staker claims (WDK-signed, sole winner)
  const clm = await callContract(staker, { to: escrow, abi: ESCROW_ABI, fn: 'claim', args: [mId], nonce: await nonceOf(stakerAddr) })
  console.log('claim    ', ES(clm.hash)); await waitMined(provider, clm.hash)
  console.log('--- AFTER CLAIM --- staker USDt:', fmt(await staker.getTokenBalance(usdtAddr)), '| escrow USDt:', fmt(await usdt.balanceOf(escrow)))

  console.log('\n✅ LIVE on Sepolia. Add to .env to use in the app:')
  console.log('   USDT_ADDRESS=' + usdtAddr)
  console.log('   ESCROW_ADDRESS=' + escrow)
}

main().catch((e) => { console.error('FATAL', e?.shortMessage || e?.message || e); process.exit(1) })
