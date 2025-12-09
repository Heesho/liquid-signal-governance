// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IStrategyFactory {
    function lastStrategy() external view returns (address);
    function lastBribeRouter() external view returns (address);

    function createStrategy(
        address voter,
        address revenueToken,
        address paymentToken,
        address paymentReceiver,
        uint256 initPrice,
        uint256 epochPeriod,
        uint256 priceMultiplier,
        uint256 minInitPrice
    ) external returns (address strategy, address bribeRouter);
}
