/**
 * Live match data (Phase: dynamic) — real fixtures + results from TheSportsDB.
 *
 * Keyless by default (free "test" key 3). No API key required; set SPORTSDB_KEY to use a
 * Patreon key for richer data. FIFA World Cup is league 4429 (override with SPORTSDB_LEAGUE).
 *
 * This replaces the hardcoded 'ENG-FRA' + manually-invented result: the match teams and
 * the final score come from the real world, and the escrow's reporter reports the REAL
 * outcome fetched here. Node's global fetch is used (Node >= 18).
 *
 * Docs: https://www.thesportsdb.com/api/v1/json/3/  (eventsnextleague / eventspastleague / lookupevent)
 */

const KEY = process.env.SPORTSDB_KEY || '3'
const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`
export const WORLD_CUP_LEAGUE = process.env.SPORTSDB_LEAGUE || '4429'

async function get (path) {
  const res = await fetch(`${BASE}/${path}`)
  if (!res.ok) throw new Error(`TheSportsDB ${res.status} for ${path}`)
  return res.json()
}

function mapEvent (e) {
  const hRaw = e.intHomeScore
  const aRaw = e.intAwayScore
  const finished = hRaw != null && hRaw !== '' && aRaw != null && aRaw !== ''
  const hs = Number(hRaw)
  const as = Number(aRaw)
  return {
    id: e.idEvent,
    label: `${e.strHomeTeam} vs ${e.strAwayTeam}`,
    home: e.strHomeTeam,
    away: e.strAwayTeam,
    date: e.dateEvent,
    status: e.strStatus,
    homeScore: finished ? hs : null,
    awayScore: finished ? as : null,
    finished,
    // app outcome codes: 1 = home win, 2 = away win, 3 = draw
    outcome: finished ? (hs > as ? 1 : as > hs ? 2 : 3) : null
  }
}

/** Upcoming fixtures (real teams + kickoff dates) — for the prediction picker. */
export async function upcomingMatches (leagueId = WORLD_CUP_LEAGUE) {
  const d = await get(`eventsnextleague.php?id=${leagueId}`)
  return (d.events || []).map(mapEvent)
}

/** Finished matches with a real final score — most recent first. */
export async function recentFinished (leagueId = WORLD_CUP_LEAGUE) {
  const d = await get(`eventspastleague.php?id=${leagueId}`)
  return (d.events || []).map(mapEvent).filter((m) => m.finished)
}

/** Look up one event's current result (used by the reporter to auto-report). */
export async function getResult (eventId) {
  const d = await get(`lookupevent.php?id=${eventId}`)
  const e = (d.events || [])[0]
  return e ? mapEvent(e) : null
}

const OUTCOME_LABEL = { 1: 'home win', 2: 'away win', 3: 'draw' }
export const outcomeLabel = (o) => OUTCOME_LABEL[o] || 'unknown'
