/**
 * Headless double-stake guard test. Stake once (confirms), then try to chip in AGAIN.
 * The second attempt must be rejected with an error and must NOT write a phantom pending —
 * the pool keeps the ORIGINAL confirmed amount. Reproduces the "failed stake but money
 * updated" bug and proves it's fixed. Prereq: anvil. Run: node scripts/double-stake-test.mjs
 */
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'worker', 'terrace-worker.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = fork(WORKER, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
let ready = null; let state = null; const errors = []
child.on('message', (m) => {
  if (m.evt === 'ready') ready = m
  if (m.evt === 'state') state = m
  if (m.evt === 'error') errors.push(m.msg)
})
child.stderr.on('data', (d) => { const s = d.toString(); if (!/Downloading|downloading|QVACRegistryClient/.test(s)) process.stderr.write('[w] ' + s) })
const waitFor = async (p, l, t = 400) => { for (let i = 0; i < t; i++) { if (p()) return; await sleep(250) } throw new Error('timeout: ' + l) }
const mine = () => Object.values(state?.stakes || {})[0]

async function main () {
  child.send({ cmd: 'start', mode: 'create', name: 'Ana', lang: 'en', accountIndex: 0 })
  await waitFor(() => ready, 'ready')

  child.send({ cmd: 'stake', matchLabel: 'x', prediction: 1, amount: 10 })
  await waitFor(() => mine()?.status === 'confirmed' && mine()?.amount === '10.0', 'first stake confirmed at 10')
  console.log('first stake:', mine().amount, mine().status)

  const errsBefore = errors.length
  child.send({ cmd: 'stake', matchLabel: 'x', prediction: 2, amount: 99 }) // try to double-stake a different amount
  await waitFor(() => errors.length > errsBefore, 'rejection error')
  await sleep(1500) // give any (wrongly-written) phantom time to appear

  const s = mine()
  console.log('after 2nd attempt:', s.amount, s.status, '| error:', errors[errors.length - 1])
  if (s.amount !== '10.0' || s.status !== 'confirmed') throw new Error(`FAIL: phantom overwrite — pool shows ${s.amount}/${s.status}`)
  if (!/already/i.test(errors[errors.length - 1])) throw new Error('FAIL: no rejection error for double-stake')
  console.log('\nPASS: second chip-in rejected, no phantom — pool stayed at 10 USDt confirmed.')
  child.kill(); process.exit(0)
}
main().catch((e) => { console.error('FATAL', e.message); child.kill(); process.exit(1) })
