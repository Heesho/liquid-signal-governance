// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IBribeFactory {
    function lastBribe() external view returns (address);

    function createBribe(address voter) external returns (address);
}
