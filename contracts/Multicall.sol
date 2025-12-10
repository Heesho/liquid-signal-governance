// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IVoter.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IBribe.sol";
import "./interfaces/IGovernanceToken.sol";

contract Multicall {
    using SafeERC20 for IERC20;

    /*----------  STATE VARIABLES  --------------------------------------*/

    address public immutable voter;

    /*----------  STRUCTS  ----------------------------------------------*/

    struct StrategyData {
        address strategy;
        address bribe;
        address bribeRouter;
        address paymentToken;
        address paymentReceiver;

        bool isAlive;
        uint8 paymentTokenDecimals;

        uint256 strategyWeight;
        uint256 votePercent;
        uint256 claimable;
        uint256 pendingRevenue;
        uint256 routerRevenue;
        uint256 totalPotentialRevenue;

        // Auction data
        uint256 epochPeriod;
        uint256 priceMultiplier;
        uint256 minInitPrice;
        uint256 epochId;
        uint256 initPrice;
        uint256 startTime;
        uint256 currentPrice;
        uint256 revenueBalance;

        // Account data
        uint256 accountVotes;
        uint256 accountPaymentTokenBalance;
    }

    struct BribeData {
        address strategy;
        address bribe;
        bool isAlive;

        address[] rewardTokens;
        uint8[] rewardTokenDecimals;
        uint256[] rewardsPerToken;
        uint256[] accountRewardsEarned;
        uint256[] rewardsLeft;

        uint256 voteWeight;
        uint256 votePercent;
        uint256 totalSupply;

        uint256 accountVote;
    }

    struct VoterData {
        address governanceToken;
        address revenueToken;
        address treasury;
        address underlyingToken;
        uint8 underlyingTokenDecimals;
        uint256 totalWeight;
        uint256 strategyCount;
        uint256 governanceTokenTotalSupply;
        uint256 accountGovernanceTokenBalance;
        uint256 accountUnderlyingTokenBalance;
        uint256 accountUsedWeights;
        uint256 accountLastVoted;
    }

    /*----------  CONSTRUCTOR  ------------------------------------------*/

    constructor(address _voter) {
        voter = _voter;
    }

    /*----------  VIEW FUNCTIONS  ---------------------------------------*/

    function getVoterData(address account) external view returns (VoterData memory data) {
        data.governanceToken = IVoter(voter).governanceToken();
        data.revenueToken = IVoter(voter).revenueToken();
        data.treasury = IVoter(voter).treasury();
        data.underlyingToken = IGovernanceToken(data.governanceToken).token();
        data.underlyingTokenDecimals = IERC20Metadata(data.underlyingToken).decimals();
        data.totalWeight = IVoter(voter).totalWeight();
        data.strategyCount = IVoter(voter).length();
        data.governanceTokenTotalSupply = IGovernanceToken(data.governanceToken).totalSupply();

        if (account != address(0)) {
            data.accountGovernanceTokenBalance = IGovernanceToken(data.governanceToken).balanceOf(account);
            data.accountUnderlyingTokenBalance = IERC20(data.underlyingToken).balanceOf(account);
            data.accountUsedWeights = IVoter(voter).account_UsedWeights(account);
            data.accountLastVoted = IVoter(voter).account_LastVoted(account);
        }

        return data;
    }

    function getStrategyData(address strategy, address account) public view returns (StrategyData memory data) {
        data.strategy = strategy;
        data.bribe = IVoter(voter).strategy_Bribe(strategy);
        data.bribeRouter = IVoter(voter).strategy_BribeRouter(strategy);
        data.paymentToken = IVoter(voter).strategy_PaymentToken(strategy);
        data.paymentReceiver = IStrategy(strategy).paymentReceiver();

        data.isAlive = IVoter(voter).strategy_IsAlive(strategy);
        data.paymentTokenDecimals = IERC20Metadata(data.paymentToken).decimals();

        data.strategyWeight = IVoter(voter).strategy_Weight(strategy);
        uint256 totalWeight = IVoter(voter).totalWeight();
        data.votePercent = totalWeight == 0 ? 0 : (100 * data.strategyWeight * 1e18) / totalWeight;
        data.claimable = IVoter(voter).strategy_Claimable(strategy);

        // Pending revenue calculations
        data.pendingRevenue = IVoter(voter).strategy_PendingRevenue(strategy);
        address revenueSource = IVoter(voter).revenueSource();
        address revenueToken = IVoter(voter).revenueToken();
        uint256 routerBalance = IERC20(revenueToken).balanceOf(revenueSource);
        data.routerRevenue = totalWeight == 0 ? 0 : (routerBalance * data.strategyWeight) / totalWeight;

        // Auction data
        data.epochPeriod = IStrategy(strategy).epochPeriod();
        data.priceMultiplier = IStrategy(strategy).priceMultiplier();
        data.minInitPrice = IStrategy(strategy).minInitPrice();
        data.epochId = IStrategy(strategy).epochId();
        data.initPrice = IStrategy(strategy).initPrice();
        data.startTime = IStrategy(strategy).startTime();
        data.currentPrice = IStrategy(strategy).getPrice();
        data.revenueBalance = IStrategy(strategy).getRevenueBalance();

        // Total potential revenue (what buyer gets if they flush + distribute + buy)
        data.totalPotentialRevenue = data.revenueBalance + data.claimable + data.pendingRevenue + data.routerRevenue;

        // Account data
        if (account != address(0)) {
            data.accountVotes = IVoter(voter).account_Strategy_Votes(account, strategy);
            data.accountPaymentTokenBalance = IERC20(data.paymentToken).balanceOf(account);
        }

        return data;
    }

    function getStrategiesData(uint256 start, uint256 stop, address account) external view returns (StrategyData[] memory) {
        StrategyData[] memory dataArray = new StrategyData[](stop - start);
        for (uint256 i = start; i < stop; i++) {
            address strategy = IVoter(voter).strategies(i);
            dataArray[i - start] = getStrategyData(strategy, account);
        }
        return dataArray;
    }

    function getAllStrategiesData(address account) external view returns (StrategyData[] memory) {
        uint256 length = IVoter(voter).length();
        StrategyData[] memory dataArray = new StrategyData[](length);
        for (uint256 i = 0; i < length; i++) {
            address strategy = IVoter(voter).strategies(i);
            dataArray[i] = getStrategyData(strategy, account);
        }
        return dataArray;
    }

    function getBribeData(address strategy, address account) public view returns (BribeData memory data) {
        data.strategy = strategy;
        data.bribe = IVoter(voter).strategy_Bribe(strategy);
        data.isAlive = IVoter(voter).strategy_IsAlive(strategy);

        data.rewardTokens = IBribe(data.bribe).getRewardTokens();
        data.totalSupply = IBribe(data.bribe).totalSupply();

        uint256 rewardCount = data.rewardTokens.length;

        // Reward token decimals
        uint8[] memory decimals = new uint8[](rewardCount);
        for (uint256 i = 0; i < rewardCount; i++) {
            decimals[i] = IERC20Metadata(data.rewardTokens[i]).decimals();
        }
        data.rewardTokenDecimals = decimals;

        // Rewards per token (reward rate normalized by total supply)
        uint256[] memory rewardsPerToken = new uint256[](rewardCount);
        for (uint256 i = 0; i < rewardCount; i++) {
            rewardsPerToken[i] = data.totalSupply == 0
                ? 0
                : (IBribe(data.bribe).getRewardForDuration(data.rewardTokens[i]) * 1e18) / data.totalSupply;
        }
        data.rewardsPerToken = rewardsPerToken;

        // Account rewards earned
        uint256[] memory accountRewardsEarned = new uint256[](rewardCount);
        for (uint256 i = 0; i < rewardCount; i++) {
            accountRewardsEarned[i] = account == address(0)
                ? 0
                : IBribe(data.bribe).earned(account, data.rewardTokens[i]);
        }
        data.accountRewardsEarned = accountRewardsEarned;

        // Rewards left
        uint256[] memory rewardsLeft = new uint256[](rewardCount);
        for (uint256 i = 0; i < rewardCount; i++) {
            rewardsLeft[i] = IBribe(data.bribe).left(data.rewardTokens[i]);
        }
        data.rewardsLeft = rewardsLeft;

        // Vote data
        data.voteWeight = IVoter(voter).strategy_Weight(strategy);
        uint256 totalWeight = IVoter(voter).totalWeight();
        data.votePercent = totalWeight == 0 ? 0 : (100 * data.voteWeight * 1e18) / totalWeight;

        // Account vote (virtual balance in bribe)
        data.accountVote = account == address(0) ? 0 : IBribe(data.bribe).account_Balance(account);

        return data;
    }

    function getBribesData(uint256 start, uint256 stop, address account) external view returns (BribeData[] memory) {
        BribeData[] memory dataArray = new BribeData[](stop - start);
        for (uint256 i = start; i < stop; i++) {
            address strategy = IVoter(voter).strategies(i);
            dataArray[i - start] = getBribeData(strategy, account);
        }
        return dataArray;
    }

    function getAllBribesData(address account) external view returns (BribeData[] memory) {
        uint256 length = IVoter(voter).length();
        BribeData[] memory dataArray = new BribeData[](length);
        for (uint256 i = 0; i < length; i++) {
            address strategy = IVoter(voter).strategies(i);
            dataArray[i] = getBribeData(strategy, account);
        }
        return dataArray;
    }

    /*----------  HELPER FUNCTIONS  -------------------------------------*/

    function getStrategies() external view returns (address[] memory) {
        return IVoter(voter).getStrategies();
    }

    function getStrategy(uint256 index) external view returns (address) {
        return IVoter(voter).strategies(index);
    }

    function getStrategyCount() external view returns (uint256) {
        return IVoter(voter).length();
    }

    /*----------  DISTRIBUTE FUNCTIONS  ----------------------------------*/

    /// @notice Distributes pending revenue to a single strategy
    /// @param strategy The strategy to distribute to
    function distribute(address strategy) external {
        IVoter(voter).distribute(strategy);
    }

    /// @notice Distributes pending revenue to all strategies
    function distributeAll() external {
        IVoter(voter).distributeAll();
    }

    /*----------  BUY FUNCTIONS  ----------------------------------------*/

    /// @notice Distributes pending revenue to a strategy then executes buy
    /// @dev Pulls payment tokens from caller, executes buy, refunds excess
    /// @param strategy The strategy to buy from
    /// @param epochId Must match current epochId (frontrun protection)
    /// @param deadline Transaction must execute before this timestamp
    /// @param maxPaymentAmount Maximum payment willing to make (slippage protection)
    /// @return paymentAmount Actual payment amount used
    function distributeAndBuy(
        address strategy,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPaymentAmount
    ) external returns (uint256 paymentAmount) {
        // Distribute pending revenue to this strategy to maximize revenue available
        IVoter(voter).distribute(strategy);

        // Get payment token for this strategy
        address paymentToken = IVoter(voter).strategy_PaymentToken(strategy);

        // Pull payment tokens from caller
        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), maxPaymentAmount);

        // Approve strategy to spend payment tokens
        IERC20(paymentToken).safeApprove(strategy, 0);
        IERC20(paymentToken).safeApprove(strategy, maxPaymentAmount);

        // Execute buy - revenue tokens sent directly to caller
        paymentAmount = IStrategy(strategy).buy(msg.sender, epochId, deadline, maxPaymentAmount);

        // Refund any unused payment tokens to caller
        uint256 remaining = IERC20(paymentToken).balanceOf(address(this));
        if (remaining > 0) {
            IERC20(paymentToken).safeTransfer(msg.sender, remaining);
        }

        return paymentAmount;
    }

    /// @notice Distributes all pending revenue to all strategies then executes buy on one
    /// @dev More thorough distribution but higher gas cost
    /// @param strategy The strategy to buy from
    /// @param epochId Must match current epochId (frontrun protection)
    /// @param deadline Transaction must execute before this timestamp
    /// @param maxPaymentAmount Maximum payment willing to make (slippage protection)
    /// @return paymentAmount Actual payment amount used
    function distributeAllAndBuy(
        address strategy,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPaymentAmount
    ) external returns (uint256 paymentAmount) {
        // Distribute all pending revenue to all strategies
        IVoter(voter).distributeAll();

        // Get payment token for this strategy
        address paymentToken = IVoter(voter).strategy_PaymentToken(strategy);

        // Pull payment tokens from caller
        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), maxPaymentAmount);

        // Approve strategy to spend payment tokens
        IERC20(paymentToken).safeApprove(strategy, 0);
        IERC20(paymentToken).safeApprove(strategy, maxPaymentAmount);

        // Execute buy - revenue tokens sent directly to caller
        paymentAmount = IStrategy(strategy).buy(msg.sender, epochId, deadline, maxPaymentAmount);

        // Refund any unused payment tokens to caller
        uint256 remaining = IERC20(paymentToken).balanceOf(address(this));
        if (remaining > 0) {
            IERC20(paymentToken).safeTransfer(msg.sender, remaining);
        }

        return paymentAmount;
    }
}
