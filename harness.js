/**
 * Terminal harness to verify the Terrace P2P core across two instances.
 *
 * Run (each instance needs its own storage — the -t/--tmp-store flag gives a fresh one):
 *
 *   HOST:    pear run --dev -t . host
 *            -> prints { evt: 'ready', key: '<ROOMKEY>' }
 *   JOINER:  pear run --dev -t . guest <ROOMKEY>
 *
 * Each instance auto-appends one prediction + one chat message once it is writable,
 * then prints the linearized state every 2s. Success = both instances list BOTH
 * peers' predictions and messages.
 */

const Room = require('./lib/room')

function log (obj) {
  console.log(JSON.stringify(obj))
}

async function main () {
  const args = (global.Pear && Pear.config && Pear.config.args) || []
  const name = args[0] || 'peer'
  const bootstrap = args[1] || null

  // With `pear run -t`, each instance gets its own fresh storage dir here.
  const storage = (global.Pear && Pear.config && Pear.config.storage) || ('./store-' + name)

  const room = new Room({ storage, bootstrap, name })
  await room.ready()

  log({ evt: 'ready', name, role: bootstrap ? 'joiner' : 'host', key: room.key, writable: room.writable })

  let appended = false
  async function appendOnce () {
    if (appended || !room.writable) return
    appended = true
    await room.appendPrediction('ENG-FRA', name + ':ENG-2-1')
    await room.appendMessage('hello from ' + name)
    if (!bootstrap) await room.appendScore('ENG-FRA', 1, 0) // host posts a mock score
    log({ evt: 'appended', name })
  }

  room.onupdate = async () => {
    await appendOnce()
  }
  room.onpeer = (n) => log({ evt: 'peer', name, connections: n })

  await appendOnce() // host is writable immediately

  const timer = setInterval(async () => {
    await appendOnce()
    const s = await room.getState()
    log({
      evt: 'state',
      name,
      writable: room.writable,
      connections: room.swarm.connections.size,
      predictions: s.predictions,
      messages: s.messages.map((m) => m.peer + ': ' + m.text),
      score: s.score
    })
  }, 2000)

  if (global.Pear && Pear.teardown) {
    Pear.teardown(async () => {
      clearInterval(timer)
      await room.close()
    })
  }
}

main().catch((err) => {
  console.error('FATAL', err && err.stack || err)
})
