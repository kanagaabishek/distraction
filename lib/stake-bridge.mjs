/**
 * Stake bridge (Phase 2b) — the seam between the P2P room and the on-chain escrow.
 *
 * Ordering (as designed): emit the stake as PENDING in Autobase immediately on user
 * action so every peer sees it without waiting on the chain; do the WDK-signed deposit;
 * then flip it to CONFIRMED once the deposit tx has a receipt. The contract stays the
 * source of truth — the room state references it (matchId, staker, tx hash) and
 * `reconcile()` checks the two agree.
 *
 * room.js has no chain deps; all ethers/WDK lives here.
 */

import { Interface } from 'ethers'
import { callContract, ESCROW_ABI, waitMined, matchId as toMatchId } from './wdk-wallet.mjs'

const nonceOf = (provider, addr) => provider.getTransactionCount(addr, 'latest')

/**
 * Stake `amount` (BigInt base units) on `prediction` for `matchLabel`.
 * Emits pending -> deposits on-chain (approve + deposit, WDK-signed) -> emits confirmed.
 */
export async function stake (room, account, { provider, escrow, usdt, matchLabel, prediction, amount }) {
  const staker = await account.getAddress()
  const mId = toMatchId(matchLabel)

  // 1) PENDING — instant, all peers see it
  await room.appendStake({ matchId: matchLabel, prediction, amount, staker, status: 'pending' })

  // 2) on-chain approve + deposit, both signed by the WDK account (self-custody)
  const apv = await account.approve({ token: usdt, spender: escrow, amount })
  await waitMined(provider, apv.hash)
  const dep = await callContract(account, {
    to: escrow, abi: ESCROW_ABI, fn: 'deposit', args: [mId, prediction, amount], nonce: await nonceOf(provider, staker)
  })
  await waitMined(provider, dep.hash)

  // 3) CONFIRMED — reference the real deposit tx
  await room.confirmStake({ matchId: matchLabel, staker, txHash: dep.hash })
  return { staker, txHash: dep.hash }
}

/** Reporter records the outcome on-chain (WDK-signed) then mirrors it into the room. */
export async function report (room, reporterAccount, { provider, escrow, matchLabel, outcome }) {
  const reporter = await reporterAccount.getAddress()
  const mId = toMatchId(matchLabel)
  const rep = await callContract(reporterAccount, {
    to: escrow, abi: ESCROW_ABI, fn: 'reportResult', args: [mId, outcome], nonce: await nonceOf(provider, reporter)
  })
  await waitMined(provider, rep.hash)
  await room.appendResult({ matchId: matchLabel, outcome, txHash: rep.hash })
  return { txHash: rep.hash }
}

/** Winner pulls their share on-chain (WDK-signed) then records the claim + payout in the room. */
export async function claim (room, account, { provider, escrow, usdt, matchLabel }) {
  const staker = await account.getAddress()
  const mId = toMatchId(matchLabel)
  const before = await account.getTokenBalance(usdt)
  const clm = await callContract(account, {
    to: escrow, abi: ESCROW_ABI, fn: 'claim', args: [mId], nonce: await nonceOf(provider, staker)
  })
  await waitMined(provider, clm.hash)
  const after = await account.getTokenBalance(usdt)
  const payout = after - before
  await room.appendClaim({ matchId: matchLabel, staker, txHash: clm.hash, payout })
  return { staker, txHash: clm.hash, payout }
}

/**
 * Reconcile the room's mirror against the on-chain source of truth for one staker.
 * Reads escrow.stakeOf + matches and compares to the room state. The contract wins;
 * any disagreement is surfaced, not hidden.
 */
export async function reconcile (provider, { escrow, matchLabel, staker, roomStake }) {
  const iface = new Interface(ESCROW_ABI)
  const mId = toMatchId(matchLabel)

  const call = async (fn, args) => {
    const data = iface.encodeFunctionData(fn, args)
    const raw = await provider.call({ to: escrow, data })
    return iface.decodeFunctionResult(fn, raw)
  }

  const [prediction, amount, claimed] = await call('stakeOf', [mId, staker])
  const onchain = { prediction: Number(prediction), amount: amount.toString(), claimed }

  const room = roomStake
    ? { prediction: Number(roomStake.prediction), amount: String(roomStake.amount), claimed: roomStake.claim != null }
    : null

  const agree = !!room &&
    room.prediction === onchain.prediction &&
    room.amount === onchain.amount &&
    room.claimed === onchain.claimed

  return { agree, onchain, room }
}
