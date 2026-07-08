/**
 * LIVE Sepolia multi-fan, multi-winner run — the demo money-shot.
 *
 * Three fans stake different amounts on the SAME match across different picks (two on the
 * real outcome, one wrong). The reporter (account[0]) reports the REAL result from the
 * fixture. Each winner claims their PROPORTIONAL share of the whole pool; the loser gets
 * nothing; the escrow nets back to 0. Every deposit/report/claim is a real WDK-signed tx
 * with an Etherscan link.
 *
 * Reuses the deployed escrow + test USDt. Run: node scripts/sepolia-multi.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JsonRpcProvider, Wallet, HDNodeWallet, NonceManager, Contract, Interface, parseUnits, formatUnits, formatEther } from 'ethers'
import { makeAccount, callContract, ESCROW_ABI, waitMined, matchId as toMatchId } from '../lib/wdk-wallet.mjs'
import { recentFinished, outcomeLabel } from '../lib/match-data.mjs'

try { process.loadEnvFile('.env') } catch {}
const __dirname = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
const ESCROW = process.env.ESCROW_ADDRESS || '0xBF1371ADF18D989DEbd7d688650441BA31B7286B'
const USDT = process.env.USDT_ADDRESS || '0x18a150BB1B561253B34d91f3922Bb0b12794e5A2'
const seed = process.env.TERRACE_SEED
if (!seed) { console.error('✖ run: npm run wallet:info'); process.exit(1) }
const art = (sol, n) => JSON.parse(readFileSync(join(__dirname, '..', 'contracts', 'out', sol, n + '.json'), 'utf8'))
const ES = (h) => `https://sepolia.etherscan.io/tx/${h}`
const u6 = (n) => parseUnits(String(n), 6)
const f6 = (b) => formatUnits(b, 6)
const addrOf = (i) => HDNodeWallet.fromPhrase(seed, undefined, `m/44'/60'/0'/0/${i}`).address

async function main () {
  const provider = new JsonRpcProvider(RPC)
  const admin = new NonceManager(Wallet.fromPhrase(seed).connect(provider)) // account[0] = reporter
  const usdt = new Contract(USDT, art('MockUSDt.sol', 'MockUSDt').abi, admin)
  const escrowRead = new Contract(ESCROW, ESCROW_ABI, provider)

  // real match + real outcome
  const fin = await recentFinished()
  const match = fin[0] || { label: 'England vs France', outcome: 3, homeScore: 0, awayScore: 0 }
  const RESULT = match.outcome
  const lose = RESULT === 1 ? 2 : 1
  const label = `${match.label} · pool-${Date.now().toString(36)}` // unique matchId per run
  const mId = toMatchId(label)
  console.log(`match (TheSportsDB): ${match.label}  FT ${match.homeScore}-${match.awayScore}  → real result: ${outcomeLabel(RESULT)}`)
  console.log('escrow:', ESCROW, '| reporter(acct0):', await (await admin.getAddress()))
  console.log('pool id:', label, '\n')

  // three fans (accounts 1,2,3): two on the real outcome (winners), one wrong (loser)
  const fans = [
    { idx: 1, name: 'Ana', pred: RESULT, amt: 30 },
    { idx: 2, name: 'Beto', pred: RESULT, amt: 60 },
    { idx: 3, name: 'Cal', pred: lose, amt: 90 }
  ]
  for (const f of fans) { f.address = addrOf(f.idx); f.acct = await makeAccount({ seed, index: f.idx, provider: RPC }) }

  // bootstrap: ensure each fan has USDt to stake + a little ETH for gas
  console.log('▶ funding fans (mint USDt + gas as needed)…')
  for (const f of fans) {
    const bal = await usdt.balanceOf(f.address)
    if (bal < u6(f.amt)) await (await usdt.mint(f.address, u6(f.amt))).wait(1)
    const eth = await provider.getBalance(f.address)
    if (eth < parseUnits('0.004', 18)) await (await admin.sendTransaction({ to: f.address, value: parseUnits('0.006', 18) })).wait(1)
  }

  const escrowBefore = await usdt.balanceOf(ESCROW)
  const nonceOf = (a) => provider.getTransactionCount(a, 'latest')

  // 1) each fan approves + deposits (WDK-signed)
  console.log('\n▶ deposits (each fan, WDK-signed):')
  for (const f of fans) {
    const apv = await f.acct.approve({ token: USDT, spender: ESCROW, amount: u6(f.amt) })
    await waitMined(provider, apv.hash)
    const dep = await callContract(f.acct, { to: ESCROW, abi: ESCROW_ABI, fn: 'deposit', args: [mId, f.pred, u6(f.amt)], nonce: await nonceOf(f.address) })
    await waitMined(provider, dep.hash)
    console.log(`   ${f.name} staked ${f.amt} on ${outcomeLabel(f.pred)}  ${ES(dep.hash)}`)
  }
  console.log('   pool now:', f6(await escrowRead.poolOf(mId)), 'USDt')

  // 2) reporter reports the REAL outcome
  const iface = new Interface(ESCROW_ABI)
  const rep = await admin.sendTransaction({ to: ESCROW, data: iface.encodeFunctionData('reportResult', [mId, RESULT]) })
  await rep.wait(1)
  console.log(`\n▶ reported REAL result: ${outcomeLabel(RESULT)}  ${ES(rep.hash)}`)

  // 3) winners claim their proportional share; loser gets nothing
  console.log('\n▶ claims:')
  const results = []
  for (const f of fans) {
    const won = f.pred === RESULT
    if (!won) { results.push({ ...f, won, before: null, after: null, tx: null }); continue }
    const before = await f.acct.getTokenBalance(USDT)
    const clm = await callContract(f.acct, { to: ESCROW, abi: ESCROW_ABI, fn: 'claim', args: [mId], nonce: await nonceOf(f.address) })
    await waitMined(provider, clm.hash)
    const after = await f.acct.getTokenBalance(USDT)
    results.push({ ...f, won, payout: after - before, tx: clm.hash })
    console.log(`   ${f.name} claimed +${f6(after - before)} USDt  ${ES(clm.hash)}`)
  }

  // verification
  const escrowAfter = await usdt.balanceOf(ESCROW)
  const pool = 30 + 60 + 90
  const winStake = fans.filter((f) => f.pred === RESULT).reduce((s, f) => s + f.amt, 0)
  console.log('\n── final pool table ──')
  for (const r of results) {
    const expect = r.won ? (pool * r.amt / winStake) : 0
    console.log(`   ${r.name.padEnd(5)} ${outcomeLabel(r.pred).padEnd(9)} staked ${String(r.amt).padStart(3)}  ${r.won ? 'WON  +' + f6(r.payout) + ' (expected ' + expect + ')' : 'lost'}`)
  }
  const drained = (escrowAfter - escrowBefore) === 0n
  console.log(`\nescrow net for this pool: ${f6(escrowAfter - escrowBefore)} USDt  (${drained ? 'DRAINED to 0 ✓' : 'NOT 0 ✗'})`)

  // assert proportional split is exactly right
  let ok = drained
  for (const r of results.filter((x) => x.won)) {
    const expect = u6(pool * r.amt / winStake)
    if (r.payout !== expect) { ok = false; console.log(`   ✗ ${r.name} payout ${f6(r.payout)} != expected ${f6(expect)}`) }
  }
  console.log(ok ? '\n✅ PASS: multi-winner proportional split correct on real Sepolia, escrow drained.'
    : '\n❌ FAIL: split math or drain mismatch (reporting, NOT editing the contract).')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e?.shortMessage || e?.message || e); process.exit(1) })
