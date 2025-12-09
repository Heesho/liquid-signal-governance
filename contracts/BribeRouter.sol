// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IVoter.sol";
import "./interfaces/IBribe.sol";

/**
 * @title BribeRouter
 * @author heesho
 * @notice Routes payment tokens from auctions to Bribe contracts for voter rewards.
 */
contract BribeRouter {
    using SafeERC20 for IERC20;

    address public immutable voter;
    address public immutable strategy;
    address public immutable paymentToken;

    event BribeRouter__Distributed(address indexed bribe, address indexed token, uint256 amount);

    constructor(address _voter, address _strategy, address _paymentToken) {
        voter = _voter;
        strategy = _strategy;
        paymentToken = _paymentToken;
    }

    function distribute() external {
        address bribe = IVoter(voter).strategy_Bribe(strategy);
        uint256 balance = IERC20(paymentToken).balanceOf(address(this));

        if (balance > 0 && balance > IBribe(bribe).left(paymentToken)) {
            IERC20(paymentToken).approve(bribe, 0);
            IERC20(paymentToken).approve(bribe, balance);
            IBribe(bribe).notifyRewardAmount(paymentToken, balance);
            emit BribeRouter__Distributed(bribe, paymentToken, balance);
        }
    }

    function getBribe() external view returns (address) {
        return IVoter(voter).strategy_Bribe(strategy);
    }
}
