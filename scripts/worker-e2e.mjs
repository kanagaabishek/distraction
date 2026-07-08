/**
 * Stage 4b headless proof — drives the desktop WORKER (the GUI's brain) via the exact IPC
 * protocol the Electron main process uses, with NO Electron. Two forked Node workers act
 * as two desktop windows; we run the full flow and assert convergence.
 *
 * This verifies everything the GUI does EXCEPT the window rendering (which needs a display).
 *
 * Prereq: anvil running. Run: node scripts/worker-e2e.mjs
 */

import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER = join(__dirname, '..', 'desktop', 'worker', 'terrace-worker.mjs')
const MATCH = 'ENG-FRA'
const HOME = 1
const AWAY = 2
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function spawnWorker (tag) {
  const child = fork(WORKER, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  child._last = null
  child.on('message', (m) => {
    if (m.evt === 'state') child._last = m
    if (m.evt === 'ready') child._ready = m
    if (m.evt === 'log') console.log(`[${tag}] ${m.msg}`)
    if (m.evt === 'error') console.error(`[${tag} ERROR]`, m.msg)
  })
  child.stderr.on('data', (d) => { const s = d.toString(); if (!/Downloading|downloading|QVACRegistryClient/.test(s)) process.stderr.write(`[${tag}] ${s}`) })
  return child
}

const waitFor = async (child, pred, label, tries = 400) => {
  for (let i = 0; i < tries; i++) { if (child._last && pred(child._last)) return child._last; await sleep(250) }
  throw new Error('timeout: ' + label)
}
const waitReady = async (child, label, tries = 200) => {
  for (let i = 0; i < tries; i++) { if (child._ready) return child._ready; await sleep(250) }
  throw new Error('timeout ready: ' + label)
}

async function main () {
  const localDiscovery = process.env.PUBLIC_DHT ? false : true // PUBLIC_DHT=1 tests real public-DHT discovery (two-machine path)
  const host = spawnWorker('host')
  host.send({ cmd: 'start', mode: 'create', name: 'Alice', lang: 'fr', accountIndex: 0, localDiscovery })
  const hostReady = await waitReady(host, 'host')
  console.log('host ready:', hostReady.address, '\n  invite roomKey:', hostReady.invite.roomKey.slice(0, 16) + '…', '| escrow:', hostReady.invite.escrow)

  const guest = spawnWorker('guest')
  guest.send({ cmd: 'start', mode: 'join', invite: hostReady.invite, name: 'Bruno', lang: 'es', accountIndex: 1 })
  const guestReady = await waitReady(guest, 'guest')
  console.log('guest ready:', guestReady.address)

  await waitFor(guest, (s) => s.writable, 'guest writable')
  console.log('room live (guest is a writer)\n')

  // predict + chip in (Alice AWAY loses, Bruno HOME wins)
  host.send({ cmd: 'predict', matchLabel: MATCH, pick: 'AWAY 0-1' })
  guest.send({ cmd: 'predict', matchLabel: MATCH, pick: 'HOME 2-1' })
  host.send({ cmd: 'chat', text: 'Come on England!' })
  guest.send({ cmd: 'chat', text: 'What a goal, unbelievable!' })
  host.send({ cmd: 'stake', matchLabel: MATCH, prediction: AWAY, amount: 10 })
  guest.send({ cmd: 'stake', matchLabel: MATCH, prediction: HOME, amount: 20 })

  const twoConfirmed = (s) => Object.values(s.stakes).length === 2 && Object.values(s.stakes).every((x) => x.status === 'confirmed')
  await waitFor(host, twoConfirmed, 'host sees 2 confirmed')
  await waitFor(guest, twoConfirmed, 'guest sees 2 confirmed')

  const showChat = (s, who) => { console.log(`${who} sees chat (localized on-device):`); for (const m of s.messages) console.log(`   ${m.peer}: "${m.original}" -> "${m.translated}"`) }
  showChat(host._last, 'Alice(FR)')
  showChat(guest._last, 'Bruno(ES)')

  // report + claim
  host.send({ cmd: 'report', matchLabel: MATCH, outcome: HOME })
  await waitFor(guest, (s) => s.result?.outcome === HOME, 'guest sees result')
  guest.send({ cmd: 'claim', matchLabel: MATCH })
  await waitFor(guest, (s) => Object.values(s.stakes).some((x) => x.claim), 'guest claim recorded')
  await waitFor(host, (s) => Object.values(s.stakes).some((x) => x.claim), 'host sees claim')

  const sh = host._last; const sg = guest._last
  const norm = (s) => JSON.stringify({ stakes: s.stakes, result: s.result })
  console.log(`\nfinal pool (host view) — ${Object.keys(sh.stakes).length} distinct stakers:`)
  for (const v of Object.values(sh.stakes)) console.log(`   ${v.peer} ${v.staker?.slice(0, 8)}: ${v.prediction === HOME ? 'HOME' : 'AWAY'} ${v.amount} USDt ${v.status}` + (v.won ? ' WON' : ' lost') + (v.claim ? ` claimed(+${v.claim.payout})` : ''))
  console.log('guest wallet USDt:', sg.balances.usdt)

  if (norm(sh) !== norm(sg)) throw new Error('FAIL: workers did not converge')
  const bruno = Object.values(sh.stakes).find((v) => v.peer === 'Bruno')
  if (!bruno?.won || !bruno?.claim) throw new Error('FAIL: winner not claimed in shared state')

  console.log('\nPASS: desktop worker drives room + wallet + pool + on-device translation over IPC; two windows converge.')
  host.kill(); guest.kill()
  process.exit(0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
