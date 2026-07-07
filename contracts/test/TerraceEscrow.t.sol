// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TerraceEscrow} from "../src/TerraceEscrow.sol";
import {MockUSDt} from "../src/MockUSDt.sol";

contract TerraceEscrowTest is Test {
    MockUSDt usdt;
    TerraceEscrow escrow;

    address reporter;
    address alice; // predicts HOME (wins)
    address bob; // predicts AWAY (loses)
    address carol; // predicts HOME (wins)

    bytes32 constant MATCH = keccak256("ENG-FRA");
    uint8 constant HOME = 1;
    uint8 constant AWAY = 2;

    function setUp() public {
        reporter = makeAddr("reporter");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");

        usdt = new MockUSDt();
        escrow = new TerraceEscrow(address(usdt), reporter);

        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        _fund(carol, 1_000e6);
    }

    function _fund(address who, uint256 amount) internal {
        usdt.mint(who, amount);
        vm.prank(who);
        usdt.approve(address(escrow), type(uint256).max);
    }

    function _deposit(address who, uint8 prediction, uint256 amount) internal {
        vm.prank(who);
        escrow.deposit(MATCH, prediction, amount);
    }

    function test_HappyPath_ProportionalPayout() public {
        // alice stakes 100 on HOME, bob 300 on AWAY, carol 100 on HOME
        _deposit(alice, HOME, 100e6);
        _deposit(bob, AWAY, 300e6);
        _deposit(carol, HOME, 100e6);

        assertEq(escrow.poolOf(MATCH), 500e6, "pool");
        assertEq(usdt.balanceOf(address(escrow)), 500e6, "escrow holds pool");

        // HOME wins. winningStake = 200 (alice+carol). pool = 500.
        vm.prank(reporter);
        escrow.reportResult(MATCH, HOME);

        // alice share = 500 * 100 / 200 = 250 ; carol same = 250
        uint256 aliceBefore = usdt.balanceOf(alice);
        vm.prank(alice);
        escrow.claim(MATCH);
        assertEq(usdt.balanceOf(alice) - aliceBefore, 250e6, "alice payout");

        vm.prank(carol);
        escrow.claim(MATCH);
        assertEq(usdt.balanceOf(carol) - (1_000e6 - 100e6), 250e6, "carol payout");

        // whole pool distributed, escrow drained
        assertEq(usdt.balanceOf(address(escrow)), 0, "escrow drained");
    }

    function test_Loser_CannotClaim() public {
        _deposit(alice, HOME, 100e6);
        _deposit(bob, AWAY, 100e6);
        vm.prank(reporter);
        escrow.reportResult(MATCH, HOME);

        vm.prank(bob);
        vm.expectRevert("did not win");
        escrow.claim(MATCH);
    }

    function test_OnlyReporter_CanReport() public {
        _deposit(alice, HOME, 100e6);
        vm.prank(alice);
        vm.expectRevert("not reporter");
        escrow.reportResult(MATCH, HOME);
    }

    function test_NoDoubleClaim() public {
        _deposit(alice, HOME, 100e6);
        vm.prank(reporter);
        escrow.reportResult(MATCH, HOME);
        vm.prank(alice);
        escrow.claim(MATCH);
        vm.prank(alice);
        vm.expectRevert("already claimed");
        escrow.claim(MATCH);
    }

    function test_NoDepositAfterReport() public {
        _deposit(alice, HOME, 100e6);
        vm.prank(reporter);
        escrow.reportResult(MATCH, HOME);
        vm.prank(bob);
        vm.expectRevert("already reported");
        escrow.deposit(MATCH, AWAY, 100e6);
    }

    function test_NoDoubleStake() public {
        _deposit(alice, HOME, 100e6);
        vm.prank(alice);
        vm.expectRevert("already staked");
        escrow.deposit(MATCH, HOME, 50e6);
    }

    function test_ClaimBeforeReport_Reverts() public {
        _deposit(alice, HOME, 100e6);
        vm.prank(alice);
        vm.expectRevert("not reported");
        escrow.claim(MATCH);
    }

    function test_SoleWinner_TakesWholePool() public {
        _deposit(alice, HOME, 100e6);
        _deposit(bob, AWAY, 400e6);
        vm.prank(reporter);
        escrow.reportResult(MATCH, HOME);
        vm.prank(alice);
        escrow.claim(MATCH);
        // sole HOME staker gets the entire 500 pool
        assertEq(usdt.balanceOf(alice), 1_000e6 - 100e6 + 500e6, "sole winner whole pool");
    }
}
