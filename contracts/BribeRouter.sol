// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVoter} from "./interfaces/IVoter.sol";
import {IBribe} from "./interfaces/IBribe.sol";

/**
 * @title BribeRouter
 * @author heesho
 * @notice Routes payment tokens from strategy auctions to the associated Bribe contract.
 *         When a strategy auction completes, a portion of payment goes here, then distribute() sends it to voters.
 */
contract BribeRouter {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable voter;        // voter contract to lookup bribe
    address public immutable strategy;     // strategy this router serves
    address public immutable paymentToken; // token to distribute as bribes

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event BribeRouter__Distributed(address indexed bribe, address indexed token, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _voter, address _strategy, address _paymentToken) {
        voter = _voter;
        strategy = _strategy;
        paymentToken = _paymentToken;
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Sends accumulated payment tokens to the bribe contract for distribution
    /// @dev Only distributes if balance exceeds remaining rewards in bribe (prevents small dust distributions)
    function distribute() external {
        address bribe = IVoter(voter).strategy_Bribe(strategy);
        uint256 balance = IERC20(paymentToken).balanceOf(address(this));

        if (balance > 0 && balance > IBribe(bribe).left(paymentToken)) {
            IERC20(paymentToken).safeApprove(bribe, 0);
            IERC20(paymentToken).safeApprove(bribe, balance);
            IBribe(bribe).notifyRewardAmount(paymentToken, balance);
            emit BribeRouter__Distributed(bribe, paymentToken, balance);
        }
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the bribe contract for this strategy
    function getBribe() external view returns (address) {
        return IVoter(voter).strategy_Bribe(strategy);
    }
}
