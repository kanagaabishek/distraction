#!/usr/bin/env node
/**
 * Cross-platform launcher — `npm start` on Windows, macOS, or Linux (no bash needed).
 *
 * Targets REAL Sepolia (the already-deployed escrow), so it needs only Node + Electron —
 * NO Foundry/anvil. Set SEPOLIA_RPC_URL + ESCROW_ADDRESS + USDT_ADDRESS (+ TERRACE_SEED)
 * in .env. For local anvil mode use ./start.sh on macOS/Linux/WSL (that needs Foundry).
 *
 * Set TERRACE_DRY_RUN=1 to print the plan without launching.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const desktop = join(root, 'desktop')
try { process.loadEnvFile(join(root, '.env')) } catch { /* no .env */ }

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: 'inherit', ...opts })
  p.on('error', rej)
  p.on('exit', (code) => code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`)))
})

async function main () {
  if (!process.env.SEPOLIA_RPC_URL) {
    console.error('✖ No SEPOLIA_RPC_URL in .env.')
    console.error('  This cross-platform launcher targets Sepolia (needs no Foundry/anvil).')
    console.error('  Set SEPOLIA_RPC_URL + ESCROW_ADDRESS + USDT_ADDRESS + TERRACE_SEED in .env,')
    console.error('  or on macOS/Linux/WSL use ./start.sh for local anvil mode.')
    process.exit(1)
  }
  if (!process.env.ESCROW_ADDRESS) console.warn('⚠ ESCROW_ADDRESS not set — deploy first (npm run wallet:info, then a funded deploy).')

  // the Electron main forks the worker with this Node (QVAC needs Node >= 22.17)
  process.env.TERRACE_NODE = process.execPath

  console.log('Terrace → Electron desktop app, targeting Sepolia:', process.env.SEPOLIA_RPC_URL)
  console.log('  escrow:', process.env.ESCROW_ADDRESS || '(unset)', '| node:', process.execPath)

  if (process.env.TERRACE_DRY_RUN) {
    const haveElectron = existsSync(join(desktop, 'node_modules', 'electron'))
    console.log(`[dry-run] desktop electron installed: ${haveElectron}; would ${haveElectron ? '' : 'npm install then '}npm start in ${desktop}`)
    return
  }

  if (!existsSync(join(desktop, 'node_modules', 'electron'))) {
    console.log('installing desktop dependencies (first run)…')
    await run(npm, ['install'], { cwd: desktop })
  }
  await run(npm, ['start'], { cwd: desktop })
}

main().catch((e) => { console.error(e.message); process.exit(1) })
