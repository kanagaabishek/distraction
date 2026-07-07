// Renderer logic — talks to the worker only through window.terrace (preload bridge).
const $ = (id) => document.getElementById(id)
const send = (msg) => window.terrace.send(msg)
const MATCH = 'ENG-FRA'
let invite = null

const setStatus = (s) => { $('status').textContent = s }

// --- lobby actions ---
$('createBtn').onclick = () => {
  setStatus('creating room + local pool…')
  send({ cmd: 'start', mode: 'create', name: $('name').value || 'Host', lang: $('lang').value })
}
$('joinBtn').onclick = () => {
  let inv
  try { inv = JSON.parse($('inviteIn').value.trim()) } catch { return setStatus('invite is not valid JSON') }
  setStatus('joining room…')
  send({ cmd: 'start', mode: 'join', invite: inv, name: $('name').value || 'Guest', lang: $('lang').value })
}

// --- room actions ---
$('predictBtn').onclick = () => send({ cmd: 'predict', matchLabel: MATCH, pick: `${outName()} ${$('pick').value}`.trim() })
$('stakeBtn').onclick = () => send({ cmd: 'stake', matchLabel: MATCH, prediction: Number($('outcome').value), amount: Number($('amount').value) })
$('reportBtn').onclick = () => send({ cmd: 'report', matchLabel: MATCH, outcome: Number($('reportOutcome').value) })
$('claimBtn').onclick = () => send({ cmd: 'claim', matchLabel: MATCH })
$('scoreBtn').onclick = () => send({ cmd: 'postScore', matchLabel: MATCH, home: Number($('home').value), away: Number($('away').value) })
$('chatBtn').onclick = () => { const t = $('chatIn').value.trim(); if (t) { send({ cmd: 'chat', text: t }); $('chatIn').value = '' } }
$('chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('chatBtn').click() })
$('langLive').onchange = () => send({ cmd: 'setLang', lang: $('langLive').value })
$('copyBtn').onclick = () => { navigator.clipboard.writeText($('invite').textContent) ; setStatus('invite copied') }

const outName = () => ({ 1: 'Home', 2: 'Away', 3: 'Draw' })[$('outcome').value]

// --- worker events ---
window.terrace.onEvent((m) => {
  if (m.evt === 'log') return setStatus(m.msg)
  if (m.evt === 'error') return setStatus('⚠ ' + m.msg)
  if (m.evt === 'ready') {
    invite = m.invite
    $('lobby').classList.add('hidden'); $('room').classList.remove('hidden')
    $('invite').textContent = JSON.stringify(invite)
    $('addr').textContent = m.address
    $('langLive').value = m.lang
    $('matchName').textContent = MATCH
    setStatus('in room as ' + m.name)
    return
  }
  if (m.evt === 'state') return renderState(m)
})

function renderState (s) {
  $('addr').textContent = s.address
  $('usdt').textContent = s.balances.usdt
  $('eth').textContent = s.balances.eth + ' ETH'
  $('score').textContent = s.score ? `${s.score.home} : ${s.score.away}` : '—'
  $('result').textContent = s.result ? `Reported: ${({ 1: 'Home win', 2: 'Away win', 3: 'Draw' })[s.result.outcome]}` : 'no result yet'

  // stakes table
  const tb = $('stakes').querySelector('tbody'); tb.innerHTML = ''
  for (const v of Object.values(s.stakes)) {
    const tr = document.createElement('tr')
    const status = `<span class="pill ${v.status}">${v.status}</span>`
    const res = v.won == null ? '' : `<span class="pill ${v.won ? 'won' : 'lost'}">${v.won ? 'won' : 'lost'}</span>`
    const clm = v.claim ? `+${v.claim.payout} USDt` : ''
    tr.innerHTML = `<td>${v.peer}</td><td>${({ 1: 'Home', 2: 'Away', 3: 'Draw' })[v.prediction] || v.prediction}</td><td>${v.amount}</td><td>${status}</td><td>${res}</td><td>${clm}</td>`
    tb.appendChild(tr)
  }

  // chat (translated on this device)
  const c = $('chat'); c.innerHTML = ''
  for (const mm of s.messages) {
    const d = document.createElement('div'); d.className = 'msg'
    const showOrig = mm.translated !== mm.original
    d.innerHTML = `<div class="who">${mm.peer}</div><div class="tr">${escape(mm.translated)}</div>` + (showOrig ? `<div class="orig">original: ${escape(mm.original)}</div>` : '')
    c.appendChild(d)
  }
  c.scrollTop = c.scrollHeight
}

const escape = (t) => String(t).replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]))
