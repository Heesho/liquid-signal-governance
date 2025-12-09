// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IVoter} from "./interfaces/IVoter.sol";

/**
 * @title RevenueRouter
 * @author heesho
 * @notice Collects protocol revenue and pushes it to Voter for distribution to strategies.
 *         Acts as the authorized revenueSource for the Voter contract.
 */
contract RevenueRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable voter;        // voter contract to send revenue to
    address public immutable revenueToken; // token to distribute

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error RevenueRouter__InvalidZeroAddress();
    error RevenueRouter__NoRevenueToFlush();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event RevenueRouter__Flushed(address indexed caller, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _revenueToken, address _voter) {
        if (_revenueToken == address(0)) revert RevenueRouter__InvalidZeroAddress();
        if (_voter == address(0)) revert RevenueRouter__InvalidZeroAddress();
        revenueToken = _revenueToken;
        voter = _voter;
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Sends all accumulated revenue to Voter for distribution
    /// @return amount Amount of revenue flushed
    /// @dev Reverts if no revenue available
    function flush() external nonReentrant returns (uint256 amount) {
        amount = IERC20(revenueToken).balanceOf(address(this));
        if (amount == 0) revert RevenueRouter__NoRevenueToFlush();
        IERC20(revenueToken).safeApprove(voter, amount);
        IVoter(voter).notifyAndDistribute(amount);
        emit RevenueRouter__Flushed(msg.sender, amount);
    }

    /// @notice Sends revenue to Voter if available, no-op if empty
    /// @return amount Amount of revenue flushed (0 if none available)
    function flushIfAvailable() external nonReentrant returns (uint256 amount) {
        amount = IERC20(revenueToken).balanceOf(address(this));
        if (amount > 0) {
            IERC20(revenueToken).safeApprove(voter, amount);
            IVoter(voter).notifyAndDistribute(amount);
            emit RevenueRouter__Flushed(msg.sender, amount);
        }
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns pending revenue available to flush
    function pendingRevenue() external view returns (uint256) {
        return IERC20(revenueToken).balanceOf(address(this));
    }
}
