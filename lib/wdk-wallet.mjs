/**
 * WDK self-custodial wallet helpers (Phase 2a).
 *
 * Thin wrappers over the Wallet Development Kit so the rest of the app uses WDK's
 * actual account APIs for self-custody + signing — not a raw ethers wallet. ethers
 * is used here ONLY as an ABI codec (encoding calldata), exactly as WDK does
 * internally; every transaction is signed and broadcast by the WDK account.
 *
 * Docs: https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm/usage
 */

import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { Interface, id as keccakId } from 'ethers'

/** Generate a fresh BIP-39 seed phrase. Store it in .env — never in code/repo. */
export function newSeedPhrase () {
  return WDK.getRandomSeedPhrase()
}

/**
 * Build a self-custodial EVM account from a seed.
 * @returns a WDK WalletAccountEvm (signs + broadcasts its own transactions).
 */
export async function makeAccount ({ seed, index = 0, provider }) {
  const wdk = new WDK(seed).registerWallet('ethereum', WalletManagerEvm, { provider })
  return wdk.getAccount('ethereum', index)
}

/** App match ids are bytes32 = keccak256 of a label, matching Solidity keccak256(bytes(label)). */
export function matchId (label) {
  return keccakId(label)
}

export const ESCROW_ABI = [
  'function deposit(bytes32 matchId, uint8 prediction, uint256 amount)',
  'function reportResult(bytes32 matchId, uint8 outcome)',
  'function claim(bytes32 matchId)',
  'function poolOf(bytes32 matchId) view returns (uint256)',
  'function stakeOf(bytes32 matchId, address predictor) view returns (uint8 prediction, uint256 amount, bool claimed)'
]

export const USDT_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)'
]

/**
 * Call a contract write method THROUGH the WDK account (self-custody signing).
 * @returns { hash, fee }
 */
export async function callContract (account, { to, abi, fn, args = [], value = 0, nonce }) {
  const iface = new Interface(abi)
  const data = iface.encodeFunctionData(fn, args)
  const tx = { to, value, data }
  // Optionally pin the nonce. WDK derives it from getTransactionCount('pending'),
  // but ethers' provider dedup-cache can serve a stale value for back-to-back sends
  // on an instant-mining node; passing an explicit nonce avoids the collision.
  if (nonce != null) tx.nonce = nonce
  return account.sendTransaction(tx)
}
