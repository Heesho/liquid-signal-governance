// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Bribe
 * @author heesho
 *
 * @notice Distributes voting rewards to GovernanceToken holders who vote for
 *         a specific strategy on the Voter contract.
 *
 * @dev Key concepts:
 *      - Virtual Balances: No tokens are deposited. When users vote in Voter,
 *        the Voter calls _deposit() to create a virtual balance here.
 *      - Time-based Distribution: Rewards stream linearly over 7 days
 *      - Multiple Reward Tokens: Can distribute multiple token types simultaneously
 *
 * Reward Flow:
 * 1. Auction sells revenue tokens, portion of payment goes to BribeRouter
 * 2. BribeRouter calls notifyRewardAmount() to start reward distribution
 * 3. Rewards stream to voters over 7 days based on their virtual balance
 * 4. Voters call getReward() to claim accumulated rewards
 *
 * Invariants:
 *   - Bribe.balanceOf(account) == Voter.votes(account, strategy)
 *   - Bribe.totalSupply() == Voter.weights(strategy)
 *
 * @dev Based on Synthetix StakingRewards pattern, modified for virtual balances
 */
contract Bribe is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*----------  CONSTANTS  --------------------------------------------*/

    /// @notice Duration over which rewards are distributed
    uint256 public constant DURATION = 7 days;

    /*----------  STATE VARIABLES  --------------------------------------*/

    /**
     * @notice Reward state for each reward token
     * @param periodFinish Timestamp when current reward period ends
     * @param rewardRate Tokens distributed per second
     * @param lastUpdateTime Last time rewards were calculated
     * @param rewardPerTokenStored Accumulated rewards per token (scaled by 1e18)
     */
    struct Reward {
        uint256 periodFinish;
        uint256 rewardRate;
        uint256 lastUpdateTime;
        uint256 rewardPerTokenStored;
    }

    /// @notice Reward state for each reward token
    mapping(address => Reward) public rewardData;

    /// @notice Whether a token is an approved reward token
    mapping(address => bool) public isRewardToken;

    /// @notice Array of all reward token addresses
    address[] public rewardTokens;

    /// @notice The Voter contract that controls deposits/withdrawals
    address public immutable voter;

    /// @notice account => token => rewardPerToken value when last claimed
    /// @dev Used to calculate rewards since last interaction
    mapping(address => mapping(address => uint256)) public userRewardPerTokenPaid;

    /// @notice account => token => pending rewards to claim
    mapping(address => mapping(address => uint256)) public rewards;

    /// @notice Total virtual balance (sum of all vote weights for this strategy)
    uint256 private _totalSupply;

    /// @notice account => virtual balance (vote weight for this strategy)
    mapping(address => uint256) private _balances;

    /*----------  ERRORS ------------------------------------------------*/

    error Bribe__NotAuthorizedVoter();
    error Bribe__RewardSmallerThanDuration();
    error Bribe__RewardSmallerThanLeft();
    error Bribe__NotRewardToken();
    error Bribe__RewardTokenAlreadyAdded();
    error Bribe__InvalidZeroInput();

    /*----------  EVENTS ------------------------------------------------*/

    event Bribe__RewardAdded(address indexed rewardToken);
    event Bribe__RewardNotified(address indexed rewardToken, uint256 reward);
    event Bribe__Deposited(address indexed user, uint256 amount);
    event Bribe__Withdrawn(address indexed user, uint256 amount);
    event Bribe__RewardPaid(address indexed user, address indexed rewardsToken, uint256 reward);

    /*----------  MODIFIERS  --------------------------------------------*/

    /**
     * @notice Updates reward state for all tokens before any balance change
     * @param account The account to update rewards for (address(0) for global only)
     *
     * @dev This modifier implements the "checkpoint" pattern:
     *      1. Updates global rewardPerToken for each reward token
     *      2. If account specified, calculates and stores their pending rewards
     *      3. Syncs user's rewardPerTokenPaid to current value
     */
    modifier updateReward(address account) {
        for (uint256 i; i < rewardTokens.length; i++) {
            address token = rewardTokens[i];
            // Update global reward accumulator
            rewardData[token].rewardPerTokenStored = rewardPerToken(token);
            rewardData[token].lastUpdateTime = lastTimeRewardApplicable(token);

            // Update user-specific state if account provided
            if (account != address(0)) {
                // Calculate and store pending rewards
                rewards[account][token] = earned(account, token);
                // Sync to current rewardPerToken
                userRewardPerTokenPaid[account][token] = rewardData[token].rewardPerTokenStored;
            }
        }
        _;
    }

    /**
     * @notice Restricts function to Voter contract only
     * @dev Only Voter can modify virtual balances and add reward tokens
     */
    modifier onlyVoter() {
        if (msg.sender != voter) {
            revert Bribe__NotAuthorizedVoter();
        }
        _;
    }

    modifier nonZeroInput(uint256 _amount) {
        if (_amount == 0) revert Bribe__InvalidZeroInput();
        _;
    }

    /*----------  CONSTRUCTOR  ------------------------------------------*/

    /**
     * @notice Initialize Bribe contract
     * @param _voter The Voter contract address that will control this Bribe
     */
    constructor(address _voter) {
        voter = _voter;
    }

    /*----------  EXTERNAL FUNCTIONS  -----------------------------------*/

    /**
     * @notice Claim all pending rewards for an account
     * @param account The address to claim rewards for
     * @dev Anyone can call this for any account (rewards go to account)
     *
     * Flow:
     * 1. updateReward modifier calculates pending rewards
     * 2. For each reward token with balance > 0:
     *    - Reset pending rewards to 0
     *    - Transfer tokens to account
     */
    function getReward(address account)
        external
        nonReentrant
        updateReward(account)
    {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address _rewardsToken = rewardTokens[i];
            uint256 reward = rewards[account][_rewardsToken];
            if (reward > 0) {
                rewards[account][_rewardsToken] = 0;
                emit Bribe__RewardPaid(account, _rewardsToken, reward);
                IERC20(_rewardsToken).safeTransfer(account, reward);
            }
        }
    }

    /**
     * @notice Start or extend reward distribution for a token
     * @param _rewardsToken The reward token to distribute
     * @param reward The amount of tokens to distribute
     *
     * @dev Typically called by BribeRouter after auction completes
     *
     * Distribution logic:
     * - If current period ended: rewardRate = reward / DURATION
     * - If period ongoing: rewardRate = (reward + leftover) / DURATION
     *   This extends the period and increases rate
     *
     * Requirements:
     * - reward >= DURATION (at least 1 token per second to avoid dust)
     * - reward >= left() (can't reduce distribution mid-period)
     * - Token must be whitelisted via addReward()
     */
    function notifyRewardAmount(address _rewardsToken, uint256 reward)
        external
        nonReentrant
        updateReward(address(0))
    {
        // Minimum reward to prevent dust issues
        if (reward < DURATION) revert Bribe__RewardSmallerThanDuration();
        // Can't notify less than what's already committed
        if (reward < left(_rewardsToken)) revert Bribe__RewardSmallerThanLeft();
        // Must be a whitelisted reward token
        if (!isRewardToken[_rewardsToken]) revert Bribe__NotRewardToken();

        // Pull reward tokens from caller
        IERC20(_rewardsToken).safeTransferFrom(msg.sender, address(this), reward);

        if (block.timestamp >= rewardData[_rewardsToken].periodFinish) {
            // Period ended - start fresh
            rewardData[_rewardsToken].rewardRate = reward / DURATION;
        } else {
            // Period ongoing - add to existing rewards
            uint256 remaining = rewardData[_rewardsToken].periodFinish - block.timestamp;
            uint256 leftover = remaining * rewardData[_rewardsToken].rewardRate;
            rewardData[_rewardsToken].rewardRate = (reward + leftover) / DURATION;
        }

        rewardData[_rewardsToken].lastUpdateTime = block.timestamp;
        rewardData[_rewardsToken].periodFinish = block.timestamp + DURATION;

        emit Bribe__RewardNotified(_rewardsToken, reward);
    }

    /*----------  RESTRICTED FUNCTIONS (VOTER ONLY)  --------------------*/

    /**
     * @notice Create virtual balance for account (called when user votes)
     * @param amount The vote weight to deposit
     * @param account The account voting
     *
     * @dev Called by Voter._vote() when user votes for this strategy
     *      No actual tokens are transferred - just virtual balance tracking
     */
    function _deposit(uint256 amount, address account)
        external
        onlyVoter
        nonZeroInput(amount)
        updateReward(account)
    {
        _totalSupply = _totalSupply + amount;
        _balances[account] = _balances[account] + amount;
        emit Bribe__Deposited(account, amount);
    }

    /**
     * @notice Remove virtual balance for account (called when user resets votes)
     * @param amount The vote weight to withdraw
     * @param account The account resetting
     *
     * @dev Called by Voter._reset() when user clears their votes
     *      updateReward modifier ensures pending rewards are captured first
     */
    function _withdraw(uint256 amount, address account)
        external
        onlyVoter
        nonZeroInput(amount)
        updateReward(account)
    {
        _totalSupply = _totalSupply - amount;
        _balances[account] = _balances[account] - amount;
        emit Bribe__Withdrawn(account, amount);
    }

    /**
     * @notice Whitelist a new reward token
     * @param _rewardsToken The token to add as a reward
     *
     * @dev Called by Voter when creating strategy (adds payment token)
     *      Can also be called later via Voter.addBribeReward()
     */
    function addReward(address _rewardsToken)
        external
        onlyVoter
    {
        if (isRewardToken[_rewardsToken]) revert Bribe__RewardTokenAlreadyAdded();
        isRewardToken[_rewardsToken] = true;
        rewardTokens.push(_rewardsToken);
        emit Bribe__RewardAdded(_rewardsToken);
    }

    /*----------  VIEW FUNCTIONS  ---------------------------------------*/

    /**
     * @notice Get remaining rewards to be distributed for a token
     * @param _rewardsToken The reward token to check
     * @return leftover Amount of tokens still to be distributed
     */
    function left(address _rewardsToken) public view returns (uint256 leftover) {
        if (block.timestamp >= rewardData[_rewardsToken].periodFinish) return 0;
        uint256 remaining = rewardData[_rewardsToken].periodFinish - block.timestamp;
        return remaining * rewardData[_rewardsToken].rewardRate;
    }

    /**
     * @notice Get total virtual balance (total votes for this strategy)
     */
    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    /**
     * @notice Get virtual balance for an account (their votes for this strategy)
     * @param account The account to query
     */
    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    /**
     * @notice Get the last timestamp where rewards are applicable
     * @param _rewardsToken The reward token to check
     * @return The earlier of: current time or period end
     */
    function lastTimeRewardApplicable(address _rewardsToken) public view returns (uint256) {
        return Math.min(block.timestamp, rewardData[_rewardsToken].periodFinish);
    }

    /**
     * @notice Calculate current reward per token (accumulated)
     * @param _rewardsToken The reward token to calculate for
     * @return Accumulated rewards per unit of virtual balance (scaled by 1e18)
     *
     * @dev Formula: stored + (timeDelta * rewardRate * 1e18 / totalSupply)
     */
    function rewardPerToken(address _rewardsToken) public view returns (uint256) {
        if (_totalSupply == 0) return rewardData[_rewardsToken].rewardPerTokenStored;
        return rewardData[_rewardsToken].rewardPerTokenStored +
            ((lastTimeRewardApplicable(_rewardsToken) - rewardData[_rewardsToken].lastUpdateTime)
            * rewardData[_rewardsToken].rewardRate * 1e18 / _totalSupply);
    }

    /**
     * @notice Calculate pending rewards for an account
     * @param account The account to calculate for
     * @param _rewardsToken The reward token to calculate
     * @return Pending reward amount (not yet claimed)
     *
     * @dev Formula: (balance * (rewardPerToken - userPaid) / 1e18) + stored
     */
    function earned(address account, address _rewardsToken) public view returns (uint256) {
        return (_balances[account] *
            (rewardPerToken(_rewardsToken) - userRewardPerTokenPaid[account][_rewardsToken]) / 1e18)
            + rewards[account][_rewardsToken];
    }

    /**
     * @notice Get total rewards distributed over the full duration
     * @param _rewardsToken The reward token to query
     * @return Total rewards for the 7-day period at current rate
     */
    function getRewardForDuration(address _rewardsToken) external view returns (uint256) {
        return rewardData[_rewardsToken].rewardRate * DURATION;
    }

    /**
     * @notice Get all reward token addresses
     * @return Array of reward token addresses
     */
    function getRewardTokens() external view returns (address[] memory) {
        return rewardTokens;
    }
}
