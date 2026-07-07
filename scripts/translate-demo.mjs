/**
 * Stage 3 proof — two room peers of different nations share ONE room; each reads the chat
 * in their own language, all inference ON-DEVICE (QVAC Bergamot NMT). The Autobase log
 * keeps the ORIGINAL English text; translation happens locally at display time.
 *
 * peerA reads French, peerB reads Spanish. Both send English-canonical chat lines.
 * Proof printed: canonical log (identical on both peers) + each peer's localized view.
 *
 * Run: node scripts/translate-demo.mjs   (first run downloads the small NMT models once)
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import createTestnet from '@hyperswarm/testnet'
import Room from '../lib/room.js'
import { Translator } from '../lib/translate-bridge.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, label, tries = 240, ms = 250) {
  for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(ms) }
  throw new Error('timeout waiting for: ' + label)
}

async function main () {
  const testnet = await createTestnet(3)
  const dir = (n) => join(tmpdir(), `terrace-3-${n}-${process.pid}-${Date.now()}`)
  const roomA = new Room({ storage: dir('A'), name: 'Alice(FR)', dhtBootstrap: testnet.bootstrap })
  await roomA.ready()
  const roomB = new Room({ storage: dir('B'), name: 'Bruno(ES)', bootstrap: roomA.key, dhtBootstrap: testnet.bootstrap })
  await roomB.ready()
  await until(() => roomB.writable, 'peerB writable')
  console.error('room live, both peers connected\n')

  // both fans chat in English (the room's canonical language)
  await roomA.appendMessage('Come on England!')
  await roomB.appendMessage('What a goal, unbelievable!')

  const sees2 = async (room) => (await room.getState()).messages.length === 2
  await until(() => sees2(roomA), 'roomA sees 2 msgs')
  await until(() => sees2(roomB), 'roomB sees 2 msgs')

  // canonical log — must be identical on both peers and hold the ORIGINAL text
  const msgsA = (await roomA.getState()).messages
  const msgsB = (await roomB.getState()).messages
  const canonical = (m) => m.map((x) => `${x.peer}: ${x.text}`).join(' | ')
  console.log('CANONICAL LOG (Autobase, original English — identical on both peers):')
  console.log('  peerA:', canonical(msgsA))
  console.log('  peerB:', canonical(msgsB))

  // each peer localizes at read time (on-device NMT)
  const trA = new Translator({ targetLang: 'fr' })
  const trB = new Translator({ targetLang: 'es' })
  console.error('\nloading on-device NMT models (one-time download, then cached)...')
  const viewA = await trA.localize(msgsA, { from: 'en' })
  const viewB = await trB.localize(msgsB, { from: 'en' })

  console.log('\nAlice reads the room in FRENCH (on-device):')
  for (const r of viewA) console.log(`  ${r.peer}:  "${r.original}"  ->  "${r.translated}"`)
  console.log('\nBruno reads the room in SPANISH (on-device):')
  for (const r of viewB) console.log(`  ${r.peer}:  "${r.original}"  ->  "${r.translated}"`)

  // assertions
  if (canonical(msgsA) !== canonical(msgsB)) throw new Error('FAIL: canonical logs differ between peers')
  if (!viewA.every((r) => r.original) || msgsA.some((m, i) => m.text !== viewA[i].original)) {
    throw new Error('FAIL: original text was mutated')
  }
  const changed = viewA.some((r) => r.translated !== r.original) && viewB.some((r) => r.translated !== r.original)
  if (!changed) throw new Error('FAIL: translation produced no change (model not running?)')

  console.log('\nPASS: same canonical room, each peer reads it in their own language on-device; originals preserved.')
  await trA.close(); await trB.close()
  await roomA.close(); await roomB.close()
  await testnet.destroy()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
