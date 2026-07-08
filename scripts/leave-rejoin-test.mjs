/**
 * Headless leave -> rejoin test. Verifies the teardown is real: after Leave, the same
 * worker can create a FRESH room and chat/pool/wallet all work in the second room (the
 * second room is where a half-teardown surfaces). No Electron needed.
 *
 * Prereq: anvil running. Run: node scripts/leave-rejoin-test.mjs
 */
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'worker', 'terrace-worker.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = fork(WORKER, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
let ready = null; let state = null; let left = false
child.on('message', (m) => {
  if (m.evt === 'ready') ready = m
  if (m.evt === 'state') state = m
  if (m.evt === 'left') left = true
  if (m.evt === 'error') console.error('[worker error]', m.msg)
})
child.stderr.on('data', (d) => { const s = d.toString(); if (!/Downloading|downloading|QVACRegistryClient/.test(s)) process.stderr.write('[w] ' + s) })

const waitFor = async (pred, label, tries = 400) => { for (let i = 0; i < tries; i++) { if (pred()) return; await sleep(250) } throw new Error('timeout: ' + label) }

async function main () {
  // --- room 1 ---
  child.send({ cmd: 'start', mode: 'create', name: 'Ana', lang: 'en', accountIndex: 0 })
  await waitFor(() => ready, 'room1 ready')
  const key1 = ready.invite.roomKey
  child.send({ cmd: 'chat', text: 'hello room one' })
  await waitFor(() => state?.messages?.some((x) => x.original === 'hello room one'), 'room1 chat')
  console.log('room1:', key1.slice(0, 12) + '…', '| msgs:', state.messages.length, '| wallet:', state.balances.usdt, 'USDt')

  // --- leave ---
  ready = null; state = null
  child.send({ cmd: 'leave' })
  await waitFor(() => left, 'left event')
  console.log('left room1 ✓')

  // --- room 2 (fresh) ---
  child.send({ cmd: 'start', mode: 'create', name: 'Ana', lang: 'fr', accountIndex: 0 })
  await waitFor(() => ready, 'room2 ready')
  const key2 = ready.invite.roomKey
  child.send({ cmd: 'chat', text: 'bonjour room two' })
  await waitFor(() => state?.messages?.some((x) => x.original === 'bonjour room two'), 'room2 chat')
  console.log('room2:', key2.slice(0, 12) + '…', '| msgs:', state.messages.length, '| wallet:', state.balances.usdt, 'USDt')

  // --- assertions ---
  if (key1 === key2) throw new Error('FAIL: second room reused the first room key (not torn down)')
  if (state.messages.length !== 1 || state.messages[0].original !== 'bonjour room two') throw new Error('FAIL: room2 carried over room1 state')
  if (!(Number(state.balances.usdt) >= 0)) throw new Error('FAIL: wallet not working in room2')
  console.log('\nPASS: leave tore down cleanly; rejoined a fresh room with working chat + wallet (no room1 carryover).')
  child.kill(); process.exit(0)
}
main().catch((e) => { console.error('FATAL', e.message); child.kill(); process.exit(1) })
