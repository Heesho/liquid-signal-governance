// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Strategy} from "./Strategy.sol";
import {BribeRouter} from "./BribeRouter.sol";

/**
 * @title StrategyFactory
 * @author heesho
 * @notice Factory for deploying Strategy contracts with their associated BribeRouters.
 *         Used by Voter.addStrategy() to create new strategies.
 */
contract StrategyFactory {

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    address public lastStrategy;     // most recently created strategy (for verification)
    address public lastBribeRouter;  // most recently created bribe router (for verification)

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event StrategyFactory__StrategyCreated(
        address indexed strategy, address indexed bribeRouter, address paymentReceiver
    );

    /*//////////////////////////////////////////////////////////////
                          FACTORY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploys a new Strategy and its BribeRouter
    /// @param _voter Voter contract address
    /// @param _revenueToken Token the strategy auctions
    /// @param _paymentToken Token used to pay for auctions
    /// @param _paymentReceiver Address receiving auction payments (minus bribe split)
    /// @param _initPrice Starting auction price
    /// @param _epochPeriod Duration of price decay
    /// @param _priceMultiplier Multiplier for next epoch's init price
    /// @param _minInitPrice Floor for init price
    /// @return strategy Address of deployed Strategy
    /// @return bribeRouter Address of deployed BribeRouter
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
