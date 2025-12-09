// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IVoter.sol";
import "./interfaces/IBribe.sol";

/**
 * @title BribeRouter
 * @author heesho
 *
 * @notice Routes payment tokens from strategy auctions to their corresponding Bribe contracts.
 *
 * @dev Payment Flow:
 *      1. Auction.buy() is called, buyer pays with paymentToken
 *      2. Auction splits payment: (1-bribeSplit)% to paymentReceiver, bribeSplit% to BribeRouter
 *      3. Payment tokens accumulate in BribeRouter
 *      4. Anyone calls BribeRouter.distribute()
 *      5. BribeRouter calls Bribe.notifyRewardAmount() to start reward distribution
 *      6. Voters who voted for this strategy earn rewards over 7 days
 *
 * Why a separate router?
 *      - Auctions shouldn't know about Bribe internals
 *      - Allows batching multiple auction payments before distributing
 *      - Provides a clean separation of concerns
 *      - Distribution can be triggered by keepers/bots
 *
 * @dev Each strategy has its own BribeRouter, deployed alongside its Auction
 */
contract BribeRouter {
    using SafeERC20 for IERC20;

    /*----------  STATE VARIABLES  --------------------------------------*/

    /// @notice The Voter contract (used to look up the Bribe address)
    address public immutable voter;

    /// @notice The strategy (auction) this router is associated with
    address public immutable strategy;

    /// @notice The token received from auction payments
    address public immutable paymentToken;

    /*----------  EVENTS ------------------------------------------------*/

    event BribeRouter__Distributed(address indexed bribe, address indexed token, uint256 amount);

    /*----------  CONSTRUCTOR  ------------------------------------------*/

    /**
     * @notice Initialize the BribeRouter
     * @param _voter The Voter contract address
     * @param _strategy The strategy (auction) this router serves
     * @param _paymentToken The token received from auction payments
     */
    constructor(address _voter, address _strategy, address _paymentToken) {
        voter = _voter;
        strategy = _strategy;
        paymentToken = _paymentToken;
    }

    /*----------  EXTERNAL FUNCTIONS  -----------------------------------*/

    /**
     * @notice Push accumulated payment tokens to the strategy's Bribe
     * @dev Permissionless - anyone can call (typically keepers/bots)
     *
     * Distribution logic:
     * - Only distributes if balance > Bribe.left(paymentToken)
     * - This prevents overwriting an ongoing distribution with less tokens
     * - If Bribe is mid-distribution, tokens accumulate until balance exceeds left()
     *
     * @dev Uses approve(0) then approve(balance) pattern for tokens that
     *      don't allow changing non-zero allowance directly (e.g., USDT)
     */
    function distribute() external {
        // Look up the Bribe contract for this strategy
        address bribe = IVoter(voter).bribes(strategy);
        uint256 balance = IERC20(paymentToken).balanceOf(address(this));

        // Only distribute if we have more than what's left in current distribution
        // This ensures we don't interrupt ongoing distributions with smaller amounts
        if (balance > 0 && balance > IBribe(bribe).left(paymentToken)) {
            // Reset approval then set new approval (for tokens like USDT)
            IERC20(paymentToken).approve(bribe, 0);
            IERC20(paymentToken).approve(bribe, balance);

            // Start/extend reward distribution in Bribe
            IBribe(bribe).notifyRewardAmount(paymentToken, balance);

            emit BribeRouter__Distributed(bribe, paymentToken, balance);
        }
    }

    /*----------  VIEW FUNCTIONS  ---------------------------------------*/

    /**
     * @notice Get the Bribe contract address for this strategy
     * @return The Bribe contract that receives distributions
     */
    function getBribe() external view returns (address) {
        return IVoter(voter).bribes(strategy);
    }
}
