/**
 * WDK wallet info — creates/loads a self-custodial wallet and reads its address,
 * native ETH balance, and USDt balance on Sepolia (read-only, no funds needed).
 *
 * Seed handling: reads TERRACE_SEED from .env. If none exists, generates one and
 * writes it to .env (0600, gitignored). The seed is NEVER printed or committed.
 *
 * Run: node scripts/wallet-info.mjs
 */

import { existsSync, writeFileSync } from 'node:fs'
import { formatUnits, formatEther, JsonRpcProvider, Contract } from 'ethers'
import { newSeedPhrase, makeAccount, USDT_ABI } from '../lib/wdk-wallet.mjs'

try { process.loadEnvFile('.env') } catch { /* no .env yet */ }

const RPC = process.env.SEPOLIA_RPC_URL || 'https://sepolia.drpc.org'
const USDT = process.env.USDT_ADDRESS || '0xd077a400968890eacc75cdc901f0356c943e4fdb'

async function main () {
  let seed = process.env.TERRACE_SEED
  if (!seed) {
    seed = newSeedPhrase()
    if (!existsSync('.env')) {
      writeFileSync('.env', `TERRACE_SEED="${seed}"\n`, { mode: 0o600 })
      console.error('[wallet-info] generated a new seed -> wrote .env (gitignored). Back it up; it controls the wallet.')
    } else {
      console.error('[wallet-info] .env exists but has no TERRACE_SEED — using an ephemeral seed for this run only.')
    }
  }

  // read USDt decimals once (defaults to 6 if the call fails)
  let decimals = 6
  try {
    const provider = new JsonRpcProvider(RPC)
    decimals = Number(await new Contract(USDT, USDT_ABI, provider).decimals())
  } catch { /* keep default */ }

  console.log('network :', RPC)
  console.log('USDt    :', USDT, `(${decimals} decimals)`)

  for (const [index, role] of [[0, 'host / reporter'], [1, 'staker']]) {
    const account = await makeAccount({ seed, index, provider: RPC })
    const address = await account.getAddress()
    const eth = await account.getBalance()
    let usdt = 0n
    try { usdt = await account.getTokenBalance(USDT) } catch { /* rpc hiccup */ }
    console.log(`\naccount[${index}] — ${role}`)
    console.log('  address   ', address)
    console.log('  ETH       ', formatEther(eth))
    console.log('  USDt      ', formatUnits(usdt, decimals))
  }

  console.log('\nFund account[1] (staker) with Sepolia ETH + test USDt to run the on-chain flow.')
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
