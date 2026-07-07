// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TerraceEscrow
 * @notice Non-custodial prediction pool for a single watch-party crew.
 *
 * Trust model (stated honestly, by design — see README):
 *  - The POOL is non-custodial: staked USDt lives in THIS contract, never in a
 *    host's personal account. Winners pull their own share via claim().
 *  - The RESULT is set by a single designated `reporter` address, fixed at deploy
 *    (the host wallet, or a keeper reading a scores API). That reporter is the
 *    trust boundary. This is deliberately NOT a trustless oracle (out of scope).
 *
 * Flow: deposit (stake on an outcome) -> reportResult (reporter sets outcome)
 *       -> claim (each correct predictor pulls their proportional share of the pool).
 *
 * `prediction` / `outcome` are app-defined uint8 codes (e.g. 1=home, 2=away, 3=draw).
 * Code 0 is reserved as "unset" and is rejected.
 */
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract TerraceEscrow {
    IERC20 public immutable usdt;
    address public immutable reporter;

    struct MatchInfo {
        bool reported;
        uint8 outcome;
        uint256 pool; // total USDt staked across all outcomes
        uint256 winningStake; // total USDt staked on the winning outcome (set on report)
    }

    struct Stake {
        uint8 prediction;
        uint256 amount;
        bool claimed;
    }

    // matchId => aggregate match state
    mapping(bytes32 => MatchInfo) public matches;
    // matchId => predictor => their stake
    mapping(bytes32 => mapping(address => Stake)) public stakes;
    // matchId => outcome code => total staked on that outcome
    mapping(bytes32 => mapping(uint8 => uint256)) public stakedOn;

    event Deposited(bytes32 indexed matchId, address indexed predictor, uint8 prediction, uint256 amount);
    event Reported(bytes32 indexed matchId, uint8 outcome, uint256 pool, uint256 winningStake);
    event Claimed(bytes32 indexed matchId, address indexed predictor, uint256 payout);

    constructor(address _usdt, address _reporter) {
        require(_usdt != address(0), "usdt=0");
        require(_reporter != address(0), "reporter=0");
        usdt = IERC20(_usdt);
        reporter = _reporter;
    }

    /**
     * @notice Stake `amount` USDt on `prediction` for `matchId`.
     * @dev Caller must have approved this contract for `amount` USDt first.
     *      One stake per predictor per match (keeps payout math simple + safe).
     */
    function deposit(bytes32 matchId, uint8 prediction, uint256 amount) external {
        require(amount > 0, "amount=0");
        require(prediction != 0, "prediction=0");
        MatchInfo storage m = matches[matchId];
        require(!m.reported, "already reported");
        Stake storage s = stakes[matchId][msg.sender];
        require(s.amount == 0, "already staked");

        require(usdt.transferFrom(msg.sender, address(this), amount), "transferFrom failed");

        s.prediction = prediction;
        s.amount = amount;
        m.pool += amount;
        stakedOn[matchId][prediction] += amount;

        emit Deposited(matchId, msg.sender, prediction, amount);
    }

    /**
     * @notice Reporter records the final `outcome` for `matchId`. One-shot.
     */
    function reportResult(bytes32 matchId, uint8 outcome) external {
        require(msg.sender == reporter, "not reporter");
        require(outcome != 0, "outcome=0");
        MatchInfo storage m = matches[matchId];
        require(!m.reported, "already reported");

        m.reported = true;
        m.outcome = outcome;
        m.winningStake = stakedOn[matchId][outcome];

        emit Reported(matchId, outcome, m.pool, m.winningStake);
    }

    /**
     * @notice Correct predictors pull their proportional share of the whole pool.
     * @dev payout = pool * yourStake / winningStake. Sum over winners == pool
     *      (minus tiny integer-division dust, which stays in the contract).
     *      Known limitation: if nobody predicted the winning outcome, the pool is
     *      unclaimable. Refund-on-no-winner is intentionally out of scope here.
     */
    function claim(bytes32 matchId) external {
        MatchInfo storage m = matches[matchId];
        require(m.reported, "not reported");
        require(m.winningStake > 0, "no winners");
        Stake storage s = stakes[matchId][msg.sender];
        require(s.amount > 0, "no stake");
        require(!s.claimed, "already claimed");
        require(s.prediction == m.outcome, "did not win");

        s.claimed = true;
        uint256 payout = (m.pool * s.amount) / m.winningStake;

        require(usdt.transfer(msg.sender, payout), "transfer failed");
        emit Claimed(matchId, msg.sender, payout);
    }

    // --- views (convenience for the app / scripts) ---

    function poolOf(bytes32 matchId) external view returns (uint256) {
        return matches[matchId].pool;
    }

    function stakeOf(bytes32 matchId, address predictor)
        external
        view
        returns (uint8 prediction, uint256 amount, bool claimed)
    {
        Stake storage s = stakes[matchId][predictor];
        return (s.prediction, s.amount, s.claimed);
    }
}
