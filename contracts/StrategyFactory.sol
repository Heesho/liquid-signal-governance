// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./Strategy.sol";
import "./BribeRouter.sol";

/**
 * @title StrategyFactory
 * @author heesho
 * @notice Factory for deploying Strategy contracts with their BribeRouters.
 */
contract StrategyFactory {
    address public lastStrategy;
    address public lastBribeRouter;

    event StrategyFactory__StrategyCreated(
        address indexed strategy, address indexed bribeRouter, address paymentReceiver
    );

    function createStrategy(
        address _voter,
        address _revenueToken,
        address _paymentToken,
        address _paymentReceiver,
        uint256 _initPrice,
        uint256 _epochPeriod,
        uint256 _priceMultiplier,
        uint256 _minInitPrice
    ) external returns (address strategy, address bribeRouter) {
        Strategy strategyContract = new Strategy(
            _voter,
            _revenueToken,
            _paymentToken,
            _paymentReceiver,
            _initPrice,
            _epochPeriod,
            _priceMultiplier,
            _minInitPrice
        );
        strategy = address(strategyContract);

        BribeRouter bribeRouterContract = new BribeRouter(_voter, strategy, _paymentToken);
        bribeRouter = address(bribeRouterContract);

        lastStrategy = strategy;
        lastBribeRouter = bribeRouter;

        emit StrategyFactory__StrategyCreated(strategy, bribeRouter, _paymentReceiver);
    }
}
