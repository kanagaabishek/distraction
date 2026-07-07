// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {TerraceEscrow} from "../src/TerraceEscrow.sol";

/**
 * Deploy TerraceEscrow to Sepolia (or any EVM chain).
 *
 * Env:
 *   PRIVATE_KEY   deployer key (funded with Sepolia ETH for gas)
 *   USDT_ADDRESS  ERC-20 to stake (Sepolia test USDt: 0xd077a400968890eacc75cdc901f0356c943e4fdb)
 *   REPORTER      address allowed to call reportResult (defaults to deployer)
 *
 * Run:
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast
 */
contract Deploy is Script {
    function run() external returns (address escrow) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address usdt = vm.envAddress("USDT_ADDRESS");
        address reporter = vm.envOr("REPORTER", vm.addr(pk));

        vm.startBroadcast(pk);
        TerraceEscrow e = new TerraceEscrow(usdt, reporter);
        vm.stopBroadcast();

        console.log("TerraceEscrow deployed:", address(e));
        console.log("  usdt:", usdt);
        console.log("  reporter:", reporter);
        return address(e);
    }
}
