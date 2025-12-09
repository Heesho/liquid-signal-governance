// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IRevenueRouter {
    function voter() external view returns (address);
    function revenueToken() external view returns (address);

    function flush() external returns (uint256 amount);
    function flushIfAvailable() external returns (uint256 amount);
    function pendingRevenue() external view returns (uint256);
}
