/**
 * Deploy Terrace to Sepolia FROM the WDK wallet (account[0], derived from TERRACE_SEED).
 * No MetaMask / no separate deployer key — just fund account[0] (and account[1]) with
 * Sepolia ETH from a faucet.
 *
 * USDt to stake with:
 *   - Leave USDT_ADDRESS unset -> deploys a test USDt on Sepolia and mints 1000 to
 *     account[0] and account[1] (only needs Sepolia ETH; no USDt faucet).
 *   - Set USDT_ADDRESS to a real faucet-funded token -> uses that instead (no mint).
 *
 * Run: node scripts/deploy-sepolia.mjs   (reads .env)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JsonRpcProvider, Wallet, HDNodeWallet, ContractFactory, Contract, formatEther, parseUnits } from 'ethers'

try { process.loadEnvFile('.env') } catch { /* no .env */ }
const __dirname = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.SEPOLIA_RPC_URL || 'https://sepolia.drpc.org'
const seed = process.env.TERRACE_SEED
if (!seed) { console.error('✖ TERRACE_SEED missing in .env — run: npm run wallet:info'); process.exit(1) }

const art = (sol, name) => JSON.parse(readFileSync(join(__dirname, '..', 'contracts', 'out', sol, name + '.json'), 'utf8'))
const provider = new JsonRpcProvider(RPC)
const deployer = Wallet.fromPhrase(seed).connect(provider) // account[0]
const acct1 = HDNodeWallet.fromPhrase(seed, undefined, "m/44'/60'/0'/0/1").address
const reporter = process.env.REPORTER || deployer.address

const bal = await provider.getBalance(deployer.address)
console.log('deployer (account[0]):', deployer.address, '| ETH:', formatEther(bal))
if (bal === 0n) { console.error('✖ account[0] has 0 Sepolia ETH — fund it from a faucet first.'); process.exit(1) }

// USDt: use the provided real token, or deploy a test token and mint to both accounts
let usdt = (process.env.USDT_ADDRESS || '').trim()
if (!usdt) {
  console.log('▶ no USDT_ADDRESS set — deploying a test USDt on Sepolia + minting…')
  const m = art('MockUSDt.sol', 'MockUSDt')
  const token = await new ContractFactory(m.abi, m.bytecode.object, deployer).deploy()
  await token.waitForDeployment()
  usdt = await token.getAddress()
  for (const to of [deployer.address, acct1]) await (await token.mint(to, parseUnits('1000', 6))).wait()
  console.log('   test USDt:', usdt, '(minted 1000 to account[0] and account[1])')
} else {
  console.log('▶ using existing USDt:', usdt)
}

console.log('▶ deploying TerraceEscrow…')
const e = art('TerraceEscrow.sol', 'TerraceEscrow')
const c = await new ContractFactory(e.abi, e.bytecode.object, deployer).deploy(usdt, reporter)
await c.waitForDeployment()
const escrow = await c.getAddress()

console.log('\n✅ deployed. Add these to .env:')
console.log('   USDT_ADDRESS=' + usdt)
console.log('   ESCROW_ADDRESS=' + escrow)
console.log('   (reporter:', reporter + ')')
