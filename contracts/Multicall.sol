// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IVoter.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IBribe.sol";
import "./interfaces/IGovernanceToken.sol";
import "./interfaces/IRevenueRouter.sol";
import "./interfaces/IBribeRouter.sol";

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

    struct SystemOverview {
        // Revenue Router
        address revenueRouter;
        uint256 revenueRouterWethBalance;

        // Voter
        address voterAddress;
        uint256 voterTotalClaimable;
        uint256 totalWeight;
        uint256 bribeSplit;

        // Governance Token
        address governanceToken;
        uint256 governanceTokenTotalSupply;
        address underlyingToken;
        uint8 underlyingTokenDecimals;
        string underlyingTokenSymbol;

        // Epoch timing
        uint256 currentEpochStart;
        uint256 nextEpochStart;
        uint256 timeUntilNextEpoch;
        uint256 epochDuration;

        // Strategy count
        uint256 strategyCount;
    }

    struct StrategyOverview {
        // Strategy info
        address strategy;
        address bribe;
        address bribeRouter;
        address paymentToken;
        string paymentTokenSymbol;
        uint8 paymentTokenDecimals;
        bool isAlive;

        // WETH in strategy
        uint256 strategyWethBalance;
        uint256 strategyClaimable;
        uint256 strategyPendingRevenue;
        uint256 strategyTotalPotentialWeth;

        // Strategy tokens in bribe router
        uint256 bribeRouterTokenBalance;

        // Strategy tokens in bribe contract
        uint256 bribeTokensLeft;
        uint256 bribeTotalSupply;

        // Voting
        uint256 strategyWeight;
        uint256 votePercent;

        // Auction info
        uint256 epochId;
        uint256 epochPeriod;
        uint256 startTime;
        uint256 initPrice;
        uint256 currentPrice;
        uint256 timeUntilAuctionEnd;
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
        data.pendingRevenue = IVoter(voter).getStrategyPendingRevenue(strategy);
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

    /*----------  SYSTEM OVERVIEW FUNCTIONS  ----------------------------*/

    uint256 private constant DURATION = 7 days;

    function getSystemOverview() external view returns (SystemOverview memory data) {
        // Revenue Router
        data.revenueRouter = IVoter(voter).revenueSource();
        address revenueToken = IVoter(voter).revenueToken();
        data.revenueRouterWethBalance = IERC20(revenueToken).balanceOf(data.revenueRouter);

        // Voter
        data.voterAddress = voter;
        data.totalWeight = IVoter(voter).totalWeight();
        data.bribeSplit = IVoter(voter).bribeSplit();

        // Calculate total claimable across all strategies
        uint256 length = IVoter(voter).length();
        data.strategyCount = length;
        uint256 totalClaimable = 0;
        for (uint256 i = 0; i < length; i++) {
            address strategy = IVoter(voter).strategies(i);
            totalClaimable += IVoter(voter).strategy_Claimable(strategy);
        }
        data.voterTotalClaimable = totalClaimable;

        // Governance Token
        data.governanceToken = IVoter(voter).governanceToken();
        data.governanceTokenTotalSupply = IGovernanceToken(data.governanceToken).totalSupply();
        data.underlyingToken = IGovernanceToken(data.governanceToken).token();
        data.underlyingTokenDecimals = IERC20Metadata(data.underlyingToken).decimals();
        data.underlyingTokenSymbol = IERC20Metadata(data.underlyingToken).symbol();

        // Epoch timing (voting epochs are 7 days)
        data.epochDuration = DURATION;
        data.currentEpochStart = (block.timestamp / DURATION) * DURATION;
        data.nextEpochStart = data.currentEpochStart + DURATION;
        data.timeUntilNextEpoch = data.nextEpochStart - block.timestamp;

        return data;
    }

    function getStrategyOverview(address strategy) public view returns (StrategyOverview memory data) {
        data.strategy = strategy;
        data.bribe = IVoter(voter).strategy_Bribe(strategy);
        data.bribeRouter = IVoter(voter).strategy_BribeRouter(strategy);
        data.paymentToken = IVoter(voter).strategy_PaymentToken(strategy);
        data.paymentTokenSymbol = IERC20Metadata(data.paymentToken).symbol();
        data.paymentTokenDecimals = IERC20Metadata(data.paymentToken).decimals();
        data.isAlive = IVoter(voter).strategy_IsAlive(strategy);

        // WETH balances
        data.strategyWethBalance = IStrategy(strategy).getRevenueBalance();
        data.strategyClaimable = IVoter(voter).strategy_Claimable(strategy);
        data.strategyPendingRevenue = IVoter(voter).getStrategyPendingRevenue(strategy);

        // Calculate router portion of pending WETH
        address revenueSource = IVoter(voter).revenueSource();
        address revenueToken = IVoter(voter).revenueToken();
        uint256 routerBalance = IERC20(revenueToken).balanceOf(revenueSource);
        uint256 totalWeight = IVoter(voter).totalWeight();
        uint256 strategyWeight = IVoter(voter).strategy_Weight(strategy);
        uint256 routerPortion = totalWeight == 0 ? 0 : (routerBalance * strategyWeight) / totalWeight;
        data.strategyTotalPotentialWeth = data.strategyWethBalance + data.strategyClaimable + data.strategyPendingRevenue + routerPortion;

        // Strategy tokens in bribe router
        data.bribeRouterTokenBalance = IERC20(data.paymentToken).balanceOf(data.bribeRouter);

        // Strategy tokens in bribe contract (what's left to distribute)
        address[] memory rewardTokens = IBribe(data.bribe).getRewardTokens();
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i] == data.paymentToken) {
                data.bribeTokensLeft = IBribe(data.bribe).left(data.paymentToken);
                break;
            }
        }
        data.bribeTotalSupply = IBribe(data.bribe).totalSupply();

        // Voting info
        data.strategyWeight = strategyWeight;
        data.votePercent = totalWeight == 0 ? 0 : (100 * strategyWeight * 1e18) / totalWeight;

        // Auction info
        data.epochId = IStrategy(strategy).epochId();
        data.epochPeriod = IStrategy(strategy).epochPeriod();
        data.startTime = IStrategy(strategy).startTime();
        data.initPrice = IStrategy(strategy).initPrice();
        data.currentPrice = IStrategy(strategy).getPrice();

        // Time until auction epoch ends
        uint256 auctionEnd = data.startTime + data.epochPeriod;
        data.timeUntilAuctionEnd = block.timestamp >= auctionEnd ? 0 : auctionEnd - block.timestamp;

        return data;
    }

    function getAllStrategyOverviews() external view returns (StrategyOverview[] memory) {
        uint256 length = IVoter(voter).length();
        StrategyOverview[] memory dataArray = new StrategyOverview[](length);
        for (uint256 i = 0; i < length; i++) {
            address strategy = IVoter(voter).strategies(i);
            dataArray[i] = getStrategyOverview(strategy);
        }
        return dataArray;
    }

    function getFullSystemView() external view returns (
        SystemOverview memory system,
        StrategyOverview[] memory strategies
    ) {
        // Get system overview
        system = this.getSystemOverview();

        // Get all strategy overviews
        uint256 length = IVoter(voter).length();
        strategies = new StrategyOverview[](length);
        for (uint256 i = 0; i < length; i++) {
            address strategy = IVoter(voter).strategies(i);
            strategies[i] = getStrategyOverview(strategy);
        }

        return (system, strategies);
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

    /// @notice Flushes revenue router and distributes to all strategies and bribes
    /// @dev Use this to move the protocol along without buying
    function flushAndDistributeAll() external {
        // Flush revenue from router to voter if available
        address revenueSource = IVoter(voter).revenueSource();
        IRevenueRouter(revenueSource).flushIfAvailable();

        // Distribute all pending revenue to all strategies
        IVoter(voter).distributeAll();

        // Distribute bribe router rewards for all strategies
        uint256 length = IVoter(voter).length();
        for (uint256 i = 0; i < length; i++) {
            address strategy = IVoter(voter).strategies(i);
            address paymentToken = IVoter(voter).strategy_PaymentToken(strategy);
            address bribeRouter = IVoter(voter).strategy_BribeRouter(strategy);

            // Bribe.notifyRewardAmount requires reward >= DURATION (604800)
            uint256 bribeBalance = IERC20(paymentToken).balanceOf(bribeRouter);
            if (bribeBalance >= 604800) {
                IBribeRouter(bribeRouter).distribute();
            }
        }
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
        // Flush revenue from router to voter if available
        address revenueSource = IVoter(voter).revenueSource();
        IRevenueRouter(revenueSource).flushIfAvailable();

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

        // Distribute bribe router rewards to bribe contract (only if above minimum)
        // Bribe.notifyRewardAmount requires reward >= DURATION (604800)
        address bribeRouter = IVoter(voter).strategy_BribeRouter(strategy);
        uint256 bribeBalance = IERC20(paymentToken).balanceOf(bribeRouter);
        if (bribeBalance >= 604800) {
            IBribeRouter(bribeRouter).distribute();
        }

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
        // Flush revenue from router to voter if available
        address revenueSource = IVoter(voter).revenueSource();
        IRevenueRouter(revenueSource).flushIfAvailable();

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

        // Distribute bribe router rewards to bribe contract (only if above minimum)
        // Bribe.notifyRewardAmount requires reward >= DURATION (604800)
        address bribeRouter = IVoter(voter).strategy_BribeRouter(strategy);
        uint256 bribeBalance = IERC20(paymentToken).balanceOf(bribeRouter);
        if (bribeBalance >= 604800) {
            IBribeRouter(bribeRouter).distribute();
        }

        // Refund any unused payment tokens to caller
        uint256 remaining = IERC20(paymentToken).balanceOf(address(this));
        if (remaining > 0) {
            IERC20(paymentToken).safeTransfer(msg.sender, remaining);
        }

        return paymentAmount;
    }
}
