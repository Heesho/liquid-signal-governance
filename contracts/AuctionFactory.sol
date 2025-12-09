// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./Auction.sol";
import "./BribeRouter.sol";

/**
 * @title AuctionFactory
 * @author heesho
 *
 * @notice Simple factory for deploying Auction contracts with their BribeRouters.
 *
 * @dev This is a stateless deployment utility:
 *      - Anyone can call createAuction() to deploy a new Auction + BribeRouter pair
 *      - No access control - the Voter contract uses this when adding strategies
 *      - Tracks last deployed addresses for convenience
 *
 * Deployment Flow:
 *      1. Voter.addStrategy() calls this factory
 *      2. Factory deploys new Auction contract
 *      3. Factory deploys new BribeRouter pointing to the Auction
 *      4. Returns both addresses to Voter
 *      5. Voter registers the strategy with its Bribe, BribeRouter, etc.
 *
 * Why deploy together?
 *      - BribeRouter needs to know which Auction (strategy) it serves
 *      - Ensures 1:1 relationship between Auction and BribeRouter
 *      - Simplifies strategy setup in Voter
 */
contract AuctionFactory {
    /*----------  STATE VARIABLES  --------------------------------------*/

    /// @notice Address of the most recently created Auction
    /// @dev Useful for verification after deployment
    address public lastAuction;

    /// @notice Address of the most recently created BribeRouter
    /// @dev Useful for verification after deployment
    address public lastBribeRouter;

    /*----------  EVENTS ------------------------------------------------*/

    event AuctionFactory__AuctionCreated(
        address indexed auction,
        address indexed bribeRouter,
        address paymentReceiver
    );

    /*----------  FACTORY FUNCTIONS  ------------------------------------*/

    /**
     * @notice Deploy a new Auction with its BribeRouter
     * @param _voter The Voter contract address
     * @param _revenueToken Token being auctioned (e.g., WETH)
     * @param _paymentToken Token buyers pay with (e.g., USDC)
     * @param _paymentReceiver Where auction payments go (treasury, burn, etc.)
     * @param _initPrice Starting price for first epoch
     * @param _epochPeriod Duration of each auction epoch
     * @param _priceMultiplier Next price = payment * multiplier
     * @param _minInitPrice Floor price for initPrice
     * @return auction The deployed Auction address
     * @return bribeRouter The deployed BribeRouter address
     *
     * @dev The Auction will:
     *      - Sell revenueToken for paymentToken via Dutch auction
     *      - Split payments: bribeSplit% to bribeRouter, rest to paymentReceiver
     *      - Look up bribeSplit from Voter at buy time
     *
     * The BribeRouter will:
     *      - Accumulate bribe portion of payments
     *      - Forward to Bribe when distribute() is called
     */
    function createAuction(
        address _voter,
        address _revenueToken,
        address _paymentToken,
        address _paymentReceiver,
        uint256 _initPrice,
        uint256 _epochPeriod,
        uint256 _priceMultiplier,
        uint256 _minInitPrice
    ) external returns (address auction, address bribeRouter) {
        // Deploy the Auction contract
        Auction auctionContract = new Auction(
            _voter,
            _revenueToken,
            _paymentToken,
            _paymentReceiver,
            _initPrice,
            _epochPeriod,
            _priceMultiplier,
            _minInitPrice
        );
        auction = address(auctionContract);

        // Deploy BribeRouter that points to the auction (strategy)
        // The BribeRouter needs to know the strategy to look up its Bribe from Voter
        BribeRouter bribeRouterContract = new BribeRouter(_voter, auction, _paymentToken);
        bribeRouter = address(bribeRouterContract);

        // Track for convenience
        lastAuction = auction;
        lastBribeRouter = bribeRouter;

        emit AuctionFactory__AuctionCreated(auction, bribeRouter, _paymentReceiver);
    }
}
