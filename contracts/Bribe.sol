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
 * 1. Strategy sells revenue tokens, portion of payment goes to BribeRouter
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

    struct Reward {
        uint256 periodFinish;
        uint256 rewardRate;
        uint256 lastUpdateTime;
        uint256 rewardPerTokenStored;
    }

    mapping(address => Reward) public token_RewardData;
    mapping(address => bool) public token_IsReward;
    address[] public rewardTokens;
    address public immutable voter;
    mapping(address => mapping(address => uint256)) public account_Token_RewardPerTokenPaid;
    mapping(address => mapping(address => uint256)) public account_Token_Rewards;
    uint256 private _totalSupply;
    mapping(address => uint256) private account_Balance;

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

    function notifyRewardAmount(address _rewardsToken, uint256 reward) external nonReentrant updateReward(address(0)) {
        if (reward < DURATION) revert Bribe__RewardSmallerThanDuration();
        if (reward < left(_rewardsToken)) revert Bribe__RewardSmallerThanLeft();
        if (!token_IsReward[_rewardsToken]) revert Bribe__NotRewardToken();

        IERC20(_rewardsToken).safeTransferFrom(msg.sender, address(this), reward);

        if (block.timestamp >= token_RewardData[_rewardsToken].periodFinish) {
            token_RewardData[_rewardsToken].rewardRate = reward / DURATION;
        } else {
            uint256 remaining = token_RewardData[_rewardsToken].periodFinish - block.timestamp;
            uint256 leftover = remaining * token_RewardData[_rewardsToken].rewardRate;
            token_RewardData[_rewardsToken].rewardRate = (reward + leftover) / DURATION;
        }

        token_RewardData[_rewardsToken].lastUpdateTime = block.timestamp;
        token_RewardData[_rewardsToken].periodFinish = block.timestamp + DURATION;

        emit Bribe__RewardNotified(_rewardsToken, reward);
    }

    /*----------  RESTRICTED FUNCTIONS (VOTER ONLY)  --------------------*/

    function _deposit(uint256 amount, address account) external onlyVoter nonZeroInput(amount) updateReward(account) {
        _totalSupply = _totalSupply + amount;
        account_Balance[account] = account_Balance[account] + amount;
        emit Bribe__Deposited(account, amount);
    }

    function _withdraw(uint256 amount, address account) external onlyVoter nonZeroInput(amount) updateReward(account) {
        _totalSupply = _totalSupply - amount;
        account_Balance[account] = account_Balance[account] - amount;
        emit Bribe__Withdrawn(account, amount);
    }

    function addReward(address _rewardsToken) external onlyVoter {
        if (token_IsReward[_rewardsToken]) revert Bribe__RewardTokenAlreadyAdded();
        token_IsReward[_rewardsToken] = true;
        rewardTokens.push(_rewardsToken);
        emit Bribe__RewardAdded(_rewardsToken);
    }

    /*----------  VIEW FUNCTIONS  ---------------------------------------*/

    function left(address _rewardsToken) public view returns (uint256) {
        if (block.timestamp >= token_RewardData[_rewardsToken].periodFinish) return 0;
        uint256 remaining = token_RewardData[_rewardsToken].periodFinish - block.timestamp;
        return remaining * token_RewardData[_rewardsToken].rewardRate;
    }

    function totalSupply() external view returns (uint256) { return _totalSupply; }

    function balanceOf(address account) external view returns (uint256) { return account_Balance[account]; }

    function lastTimeRewardApplicable(address _rewardsToken) public view returns (uint256) {
        return Math.min(block.timestamp, token_RewardData[_rewardsToken].periodFinish);
    }

    function rewardPerToken(address _rewardsToken) public view returns (uint256) {
        if (_totalSupply == 0) return token_RewardData[_rewardsToken].rewardPerTokenStored;
        return token_RewardData[_rewardsToken].rewardPerTokenStored +
            ((lastTimeRewardApplicable(_rewardsToken) - token_RewardData[_rewardsToken].lastUpdateTime)
            * token_RewardData[_rewardsToken].rewardRate * 1e18 / _totalSupply);
    }

    function earned(address account, address _rewardsToken) public view returns (uint256) {
        return (account_Balance[account] *
            (rewardPerToken(_rewardsToken) - account_Token_RewardPerTokenPaid[account][_rewardsToken]) / 1e18)
            + account_Token_Rewards[account][_rewardsToken];
    }

    function getRewardForDuration(address _rewardsToken) external view returns (uint256) {
        return token_RewardData[_rewardsToken].rewardRate * DURATION;
    }

    function getRewardTokens() external view returns (address[] memory) { return rewardTokens; }
}
