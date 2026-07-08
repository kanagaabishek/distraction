// Renderer logic — talks to the worker only through window.terrace (preload bridge).
const $ = (id) => document.getElementById(id)
const send = (msg) => window.terrace.send(msg)
let MATCH = 'ENG-FRA' // replaced by the real fixture label once the worker reports it
let invite = null
let reporterAddr = null

const setStatus = (s) => { $('status').textContent = s }

function showToast (msg, type = 'info', ms = 4500) {
  const el = document.createElement('div')
  el.className = 'toast ' + type
  el.textContent = msg
  $('toasts').appendChild(el)
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300) }, ms)
}
function tidyErr (s) {
  s = String(s)
  const m = s.match(/reverted:?\s*"?([^"\n(]+)"?/i)
  return m ? 'Failed: ' + m[1].trim() : s.split('\n')[0].slice(0, 140)
}

// --- lobby actions ---
const acctIndex = () => Number($('acct').value)
$('createBtn').onclick = () => {
  const twoMachines = $('publicNet').checked
  setStatus(twoMachines ? 'creating room on the public network…' : 'creating room + local pool…')
  // publicNet ON -> localDiscovery:false -> host skips the local testnet -> public DHT (works across machines)
  send({ cmd: 'start', mode: 'create', name: $('name').value || 'Host', lang: $('lang').value, accountIndex: acctIndex(), localDiscovery: !twoMachines })
}
$('joinBtn').onclick = () => {
  let inv
  try { inv = JSON.parse($('inviteIn').value.trim()) } catch { return setStatus('invite is not valid JSON') }
  setStatus('joining room…')
  send({ cmd: 'start', mode: 'join', invite: inv, name: $('name').value || 'Guest', lang: $('lang').value, accountIndex: acctIndex() })
}

// --- room actions ---
$('predictBtn').onclick = () => send({ cmd: 'predict', matchLabel: MATCH, pick: `${outName()} ${$('pick').value}`.trim() })
$('stakeBtn').onclick = () => send({ cmd: 'stake', matchLabel: MATCH, prediction: Number($('outcome').value), amount: Number($('amount').value) })
$('reportBtn').onclick = () => send({ cmd: 'report', matchLabel: MATCH, outcome: Number($('reportOutcome').value) })
$('autoReportBtn').onclick = () => send({ cmd: 'autoReport', matchLabel: MATCH })
$('claimBtn').onclick = () => send({ cmd: 'claim', matchLabel: MATCH })
$('scoreBtn').onclick = () => {
  const h = $('home').value, a = $('away').value
  if (h === '' || a === '') return setStatus('enter a score first')
  send({ cmd: 'postScore', matchLabel: MATCH, home: Number(h), away: Number(a) })
}
$('chatBtn').onclick = () => { const t = $('chatIn').value.trim(); if (t) { send({ cmd: 'chat', text: t }); $('chatIn').value = '' } }
$('chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('chatBtn').click() })
$('langLive').onchange = () => send({ cmd: 'setLang', lang: $('langLive').value })
$('copyBtn').onclick = () => { navigator.clipboard.writeText(invite ? JSON.stringify(invite) : ''); setStatus('full invite copied to clipboard') }
$('leaveBtn').onclick = () => { setStatus('leaving room…'); send({ cmd: 'leave' }) }

const outName = () => ({ 1: 'Home', 2: 'Away', 3: 'Draw' })[$('outcome').value]

// --- worker events ---
window.terrace.onEvent((m) => {
  if (m.evt === 'log') { setStatus(m.msg); if (/confirmed|claimed|reported|minted|settle/i.test(m.msg)) showToast(m.msg, 'ok'); return }
  if (m.evt === 'error') { const e = tidyErr(m.msg); setStatus('⚠ ' + e); showToast(e, 'err', 6000); return }
  if (m.evt === 'busy') { $('leaveBtn').disabled = m.busy; $('leaveBtn').title = m.busy ? 'Finishing a transaction…' : 'Disconnect and return to the lobby'; return }
  if (m.evt === 'left') {
    invite = null; reporterAddr = null
    $('leaveBtn').disabled = false
    $('room').classList.add('hidden'); $('lobby').classList.remove('hidden')
    showToast('left the room', 'info'); setStatus('back in the lobby')
    return
  }
  if (m.evt === 'ready') {
    invite = m.invite
    if (m.match?.label) MATCH = m.match.label
    $('lobby').classList.add('hidden'); $('room').classList.remove('hidden')
    // short human line — the full JSON payload lives in `invite` and is what Copy sends
    $('invite').textContent = `Room: ${m.match?.label || 'watch-party'} · click “Copy invite” to share`
    const local = Array.isArray(invite?.dhtBootstrap) && invite.dhtBootstrap.length
    $('inviteHint').textContent = local
      ? 'Local discovery (same machine). For two separate machines, re-create with “two machines” checked.'
      : 'Public network — this invite works for a friend on another machine (they need their own funded wallet).'
    $('addr').textContent = m.address
    $('langLive').value = m.lang
    $('matchName').textContent = matchTitle(m.match) + ' · ' + (m.chain || '')
    applyReporter(m.isReporter, m.reporter)
    setStatus('in room as ' + m.name)
    return
  }
  if (m.evt === 'state') return renderState(m)
})

const matchTitle = (mt) => mt ? `⚽ ${mt.label}${mt.date ? ' · ' + mt.date : ''}${mt.finished ? ` · FT ${mt.homeScore}-${mt.awayScore}` : ''}` : 'match'

// only the escrow's reporter can settle — HIDE the host controls for everyone else
function applyReporter (isReporter, reporter) {
  if (reporter) reporterAddr = reporter
  const on = !!isReporter
  $('reporterControls').style.display = on ? '' : 'none'
  $('postScoreRow').style.display = on ? '' : 'none'
  $('reportHint').textContent = on
    ? '✓ You are the host — you settle this match and post scores.'
    : `The host${reporterAddr ? ' (' + reporterAddr.slice(0, 8) + '…)' : ''} settles this match.`
}

function renderState (s) {
  if (s.match?.label) { MATCH = s.match.label; $('matchName').textContent = matchTitle(s.match) }
  applyReporter(s.isReporter, s.reporter)
  $('addr').textContent = s.address
  $('usdt').textContent = s.balances.usdt
  $('eth').textContent = s.balances.eth + ' ETH'
  // scoreboard: once the result is reported, show the REAL final score; otherwise any
  // manually-posted live score; otherwise a dash. No phantom default.
  const realFT = s.result && s.match?.finished && s.match.homeScore != null
  $('score').textContent = realFT ? `${s.match.homeScore} : ${s.match.awayScore}`
    : (s.score ? `${s.score.home} : ${s.score.away}` : '—')
  $('result').textContent = s.result
    ? `Reported: ${({ 1: 'Home win', 2: 'Away win', 3: 'Draw' })[s.result.outcome]}` + (realFT ? ` (${s.match.homeScore}-${s.match.awayScore})` : '')
    : 'no result yet'

  // contextual claim — only active when THIS wallet has an unclaimed win
  const mine = s.stakes[(s.address || '').toLowerCase()]
  const claimed = !!mine?.claim

  // one chip-in per wallet per match: disable Chip in once you've staked (or after settle)
  const staked = !!mine
  $('stakeBtn').disabled = staked || !!s.result
  $('stakeHint').textContent = staked
    ? `chipped in ${mine.amount} USDt on ${({ 1: 'home', 2: 'away', 3: 'draw' })[mine.prediction] || '?'} (one per match)`
    : s.result ? 'chip-in closed — match settled' : ''
  const canClaim = !!(s.result && mine && mine.won && !claimed)
  $('claimBtn').disabled = !canClaim
  $('claimBtn').textContent = claimed ? 'Claimed ✓' : 'Claim winnings'
  $('claimHint').textContent = !mine ? '(you have no stake in this match)'
    : claimed ? `claimed +${mine.claim.payout} USDt 🎉`
      : !s.result ? '(available once the match is settled)'
        : mine.won ? 'you won — claim your share!'
          : '(no win this time)'

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
