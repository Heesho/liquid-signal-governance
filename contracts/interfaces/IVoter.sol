// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IVoter {
    function governanceToken() external view returns (address);
    function revenueToken() external view returns (address);
    function treasury() external view returns (address);
    function bribeFactory() external view returns (address);
    function strategyFactory() external view returns (address);
    function revenueSource() external view returns (address);
    function bribeSplit() external view returns (uint256);
    function totalWeight() external view returns (uint256);
    function strategies(uint256 index) external view returns (address);

    function strategy_Bribe(address strategy) external view returns (address);
    function strategy_BribeRouter(address strategy) external view returns (address);
    function strategy_PaymentToken(address strategy) external view returns (address);
    function strategy_Weight(address strategy) external view returns (uint256);
    function strategy_IsValid(address strategy) external view returns (bool);
    function strategy_IsAlive(address strategy) external view returns (bool);
    function strategy_Claimable(address strategy) external view returns (uint256);
    function account_Strategy_Votes(address account, address strategy) external view returns (uint256);
    function account_UsedWeights(address account) external view returns (uint256);
    function account_LastVoted(address account) external view returns (uint256);

    function reset() external;
    function vote(address[] calldata strategies, uint256[] calldata weights) external;
    function claimBribes(address[] memory bribes) external;
    function notifyAndDistribute(uint256 amount) external;
    function distribute(address strategy) external;
    function distribute(uint256 start, uint256 finish) external;
    function distro() external;
    function updateFor(address[] memory strategies) external;
    function updateForRange(uint256 start, uint256 end) external;
    function updateAll() external;
    function updateStrategy(address strategy) external;
    function setRevenueSource(address source) external;
    function setBribeSplit(uint256 bribeSplit) external;
    function addStrategy(address paymentToken, address paymentReceiver, uint256 initPrice, uint256 epochPeriod, uint256 priceMultiplier, uint256 minInitPrice) external returns (address strategy, address bribe, address bribeRouter);
    function killStrategy(address strategy) external;
    function addBribeReward(address bribe, address rewardToken) external;
    function getStrategies() external view returns (address[] memory);
    function length() external view returns (uint256);
    function getStrategyVote(address account) external view returns (address[] memory);

    function MAX_BRIBE_SPLIT() external pure returns (uint256);
    function DIVISOR() external pure returns (uint256);
}
