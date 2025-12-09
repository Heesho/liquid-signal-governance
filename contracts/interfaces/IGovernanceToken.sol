// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IGovernanceToken {
    function UNDERLYING() external view returns (address);
    function voter() external view returns (address);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function stake(uint256 amount) external;
    function unstake(uint256 amount) external;
    function setVoter(address _voter) external;
}
