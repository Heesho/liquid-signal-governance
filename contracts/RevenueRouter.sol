// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/IVoter.sol";

/**
 * @title RevenueRouter
 * @author heesho
 * @notice Collects protocol revenue and pushes it to Voter for distribution.
 */
contract RevenueRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable voter;
    address public immutable revenueToken;

    error RevenueRouter__InvalidZeroAddress();
    error RevenueRouter__NoRevenueToFlush();

    event RevenueRouter__Flushed(address indexed caller, uint256 amount);

    constructor(address _revenueToken, address _voter) {
        if (_revenueToken == address(0)) revert RevenueRouter__InvalidZeroAddress();
        if (_voter == address(0)) revert RevenueRouter__InvalidZeroAddress();
        revenueToken = _revenueToken;
        voter = _voter;
    }

    function flush() external nonReentrant returns (uint256 amount) {
        amount = IERC20(revenueToken).balanceOf(address(this));
        if (amount == 0) revert RevenueRouter__NoRevenueToFlush();
        IERC20(revenueToken).safeApprove(voter, amount);
        IVoter(voter).notifyAndDistribute(amount);
        emit RevenueRouter__Flushed(msg.sender, amount);
    }

    function flushIfAvailable() external nonReentrant returns (uint256 amount) {
        amount = IERC20(revenueToken).balanceOf(address(this));
        if (amount > 0) {
            IERC20(revenueToken).safeApprove(voter, amount);
            IVoter(voter).notifyAndDistribute(amount);
            emit RevenueRouter__Flushed(msg.sender, amount);
        }
    }

    function pendingRevenue() external view returns (uint256) {
        return IERC20(revenueToken).balanceOf(address(this));
    }
}
