// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IBribe {
    function voter() external view returns (address);
    function DURATION() external view returns (uint256);
    function rewardTokens(uint256 index) external view returns (address);

    function token_IsReward(address token) external view returns (bool);
    function account_Token_RewardPerTokenPaid(address account, address token) external view returns (uint256);
    function account_Token_Rewards(address account, address token) external view returns (uint256);

    function left(address rewardsToken) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function account_Balance(address account) external view returns (uint256);
    function earned(address account, address rewardsToken) external view returns (uint256);
    function getRewardForDuration(address rewardsToken) external view returns (uint256);
    function getRewardTokens() external view returns (address[] memory);
    function lastTimeRewardApplicable(address rewardsToken) external view returns (uint256);
    function rewardPerToken(address rewardsToken) external view returns (uint256);

    function getReward(address account) external;
    function notifyRewardAmount(address rewardsToken, uint256 reward) external;
    function _deposit(uint256 amount, address account) external;
    function _withdraw(uint256 amount, address account) external;
    function addReward(address rewardsToken) external;
}
