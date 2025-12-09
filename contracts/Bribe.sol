// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Bribe
 * @author heesho
 * @notice Distributes voting rewards to GovernanceToken holders who vote for a specific strategy.
 *         Uses virtual balances (no token deposits) - Voter calls _deposit/_withdraw when users vote.
 *         Rewards stream linearly over 7 days based on virtual balance share.
 * @dev Based on Synthetix StakingRewards pattern, modified for virtual balances.
 */
contract Bribe is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant DURATION = 7 days;  // reward distribution period

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable voter;  // only voter can modify balances

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    struct Reward {
        uint256 periodFinish;           // when current reward period ends
        uint256 rewardRate;             // tokens per second
        uint256 lastUpdateTime;         // last time rewards were calculated
        uint256 rewardPerTokenStored;   // accumulated rewards per token
    }

    mapping(address => Reward) public token_RewardData;     // token => reward state
    mapping(address => bool) public token_IsReward;         // token => is valid reward
    address[] public rewardTokens;                          // list of reward tokens

    mapping(address => mapping(address => uint256)) public account_Token_RewardPerTokenPaid; // account => token => paid
    mapping(address => mapping(address => uint256)) public account_Token_Rewards;           // account => token => owed

    uint256 public totalSupply;                              // total virtual balance
    mapping(address => uint256) public account_Balance;     // account => virtual balance

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Bribe__NotAuthorizedVoter();
    error Bribe__RewardSmallerThanDuration();
    error Bribe__RewardSmallerThanLeft();
    error Bribe__NotRewardToken();
    error Bribe__RewardTokenAlreadyAdded();
    error Bribe__InvalidZeroInput();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Bribe__RewardAdded(address indexed rewardToken);
    event Bribe__RewardNotified(address indexed rewardToken, uint256 reward);
    event Bribe__Deposited(address indexed user, uint256 amount);
    event Bribe__Withdrawn(address indexed user, uint256 amount);
    event Bribe__RewardPaid(address indexed user, address indexed rewardsToken, uint256 reward);

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Updates reward state for all tokens before function execution
    modifier updateReward(address account) {
        for (uint256 i; i < rewardTokens.length; i++) {
            address token = rewardTokens[i];
            token_RewardData[token].rewardPerTokenStored = rewardPerToken(token);
            token_RewardData[token].lastUpdateTime = lastTimeRewardApplicable(token);
            if (account != address(0)) {
                account_Token_Rewards[account][token] = earned(account, token);
                account_Token_RewardPerTokenPaid[account][token] = token_RewardData[token].rewardPerTokenStored;
            }
        }
        _;
    }

    /// @dev Restricts to Voter contract only
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

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _voter) {
        voter = _voter;
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Claims all accumulated rewards for caller
    function getReward(address account) external nonReentrant updateReward(account) {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address _rewardsToken = rewardTokens[i];
            uint256 reward = account_Token_Rewards[account][_rewardsToken];
            if (reward > 0) {
                account_Token_Rewards[account][_rewardsToken] = 0;
                emit Bribe__RewardPaid(account, _rewardsToken, reward);
                IERC20(_rewardsToken).safeTransfer(account, reward);
            }
        }
    }

    /// @notice Starts a new reward distribution period
    /// @param _rewardsToken Token to distribute
    /// @param reward Amount to distribute over DURATION
    function notifyRewardAmount(address _rewardsToken, uint256 reward) external nonReentrant updateReward(address(0)) {
        if (reward < DURATION) revert Bribe__RewardSmallerThanDuration();
        if (reward < left(_rewardsToken)) revert Bribe__RewardSmallerThanLeft();
        if (!token_IsReward[_rewardsToken]) revert Bribe__NotRewardToken();

        IERC20(_rewardsToken).safeTransferFrom(msg.sender, address(this), reward);

        if (block.timestamp >= token_RewardData[_rewardsToken].periodFinish) {
            token_RewardData[_rewardsToken].rewardRate = reward / DURATION;
        } else {
            // add leftover from current period
            uint256 remaining = token_RewardData[_rewardsToken].periodFinish - block.timestamp;
            uint256 leftover = remaining * token_RewardData[_rewardsToken].rewardRate;
            token_RewardData[_rewardsToken].rewardRate = (reward + leftover) / DURATION;
        }

        token_RewardData[_rewardsToken].lastUpdateTime = block.timestamp;
        token_RewardData[_rewardsToken].periodFinish = block.timestamp + DURATION;

        emit Bribe__RewardNotified(_rewardsToken, reward);
    }

    /*//////////////////////////////////////////////////////////////
                    RESTRICTED FUNCTIONS (VOTER ONLY)
    //////////////////////////////////////////////////////////////*/

    /// @notice Creates virtual balance when user votes
    function _deposit(uint256 amount, address account) external onlyVoter nonZeroInput(amount) updateReward(account) {
        totalSupply = totalSupply + amount;
        account_Balance[account] = account_Balance[account] + amount;
        emit Bribe__Deposited(account, amount);
    }

    /// @notice Removes virtual balance when user resets votes
    function _withdraw(uint256 amount, address account) external onlyVoter nonZeroInput(amount) updateReward(account) {
        totalSupply = totalSupply - amount;
        account_Balance[account] = account_Balance[account] - amount;
        emit Bribe__Withdrawn(account, amount);
    }

    /// @notice Adds a new reward token
    function addReward(address _rewardsToken) external onlyVoter {
        if (token_IsReward[_rewardsToken]) revert Bribe__RewardTokenAlreadyAdded();
        token_IsReward[_rewardsToken] = true;
        rewardTokens.push(_rewardsToken);
        emit Bribe__RewardAdded(_rewardsToken);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns remaining rewards to distribute for a token
    function left(address _rewardsToken) public view returns (uint256) {
        if (block.timestamp >= token_RewardData[_rewardsToken].periodFinish) return 0;
        uint256 remaining = token_RewardData[_rewardsToken].periodFinish - block.timestamp;
        return remaining * token_RewardData[_rewardsToken].rewardRate;
    }

    /// @notice Returns min of current time and period end
    function lastTimeRewardApplicable(address _rewardsToken) public view returns (uint256) {
        return Math.min(block.timestamp, token_RewardData[_rewardsToken].periodFinish);
    }

    /// @notice Returns accumulated rewards per token
    function rewardPerToken(address _rewardsToken) public view returns (uint256) {
        if (totalSupply == 0) return token_RewardData[_rewardsToken].rewardPerTokenStored;
        return token_RewardData[_rewardsToken].rewardPerTokenStored
            + (
                (lastTimeRewardApplicable(_rewardsToken) - token_RewardData[_rewardsToken].lastUpdateTime)
                    * token_RewardData[_rewardsToken].rewardRate * 1e18 / totalSupply
            );
    }

    /// @notice Returns rewards earned by account for a token
    function earned(address account, address _rewardsToken) public view returns (uint256) {
        return (
            account_Balance[account]
                * (rewardPerToken(_rewardsToken) - account_Token_RewardPerTokenPaid[account][_rewardsToken]) / 1e18
        ) + account_Token_Rewards[account][_rewardsToken];
    }

    /// @notice Returns total rewards for full duration
    function getRewardForDuration(address _rewardsToken) external view returns (uint256) {
        return token_RewardData[_rewardsToken].rewardRate * DURATION;
    }

    /// @notice Returns all reward token addresses
    function getRewardTokens() external view returns (address[] memory) {
        return rewardTokens;
    }
}
