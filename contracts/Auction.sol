// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IVoter.sol";

/**
 * @title Auction (Dutch Auction)
 * @author heesho
 *
 * @notice Dutch auction that sells REVENUE_TOKEN for a payment token.
 *
 * @dev How Dutch Auctions Work:
 *      - Price starts high (initPrice) at the beginning of each epoch
 *      - Price decays linearly to 0 over epochPeriod
 *      - First buyer to call buy() gets ALL available revenue tokens
 *      - Payment is split: bribeSplit% to BribeRouter, rest to paymentReceiver
 *
 * Price Discovery:
 *      - If bought early (high price): next epoch starts at payment * priceMultiplier
 *      - If bought late (low price): next epoch starts lower
 *      - If no one buys: price stays at minInitPrice
 *      - This creates a self-adjusting price discovery mechanism
 *
 * Revenue Flow:
 *      1. Voter.distribute() sends REVENUE_TOKEN to this Auction
 *      2. Buyer calls buy() at current price
 *      3. Buyer receives all REVENUE_TOKEN
 *      4. Payment split: paymentReceiver gets (100-bribeSplit)%, BribeRouter gets bribeSplit%
 *      5. BribeRouter.distribute() sends to Bribe for voter rewards
 *
 * @dev Slot0 packing: All epoch state fits in one storage slot for gas efficiency
 *      - locked (1 byte): Reentrancy guard
 *      - epochId (2 bytes): Increments each buy, used for frontrunning protection
 *      - initPrice (24 bytes): Starting price for current epoch
 *      - startTime (5 bytes): Epoch start timestamp
 */
contract Auction {
    using SafeERC20 for IERC20;

    /*----------  CONSTANTS  --------------------------------------------*/

    /// @notice Minimum allowed epoch duration (1 hour)
    uint256 public constant MIN_EPOCH_PERIOD = 1 hours;

    /// @notice Maximum allowed epoch duration (1 year)
    uint256 public constant MAX_EPOCH_PERIOD = 365 days;

    /// @notice Minimum price multiplier (1.1x = 110%)
    /// @dev Ensures price discovery trends upward on competitive buys
    uint256 public constant MIN_PRICE_MULTIPLIER = 1.1e18;

    /// @notice Maximum price multiplier (3x = 300%)
    uint256 public constant MAX_PRICE_MULTIPLIER = 3e18;

    /// @notice Absolute minimum for minInitPrice (dust protection)
    uint256 public constant ABS_MIN_INIT_PRICE = 1e6;

    /// @notice Absolute maximum for initPrice (fits in uint192)
    uint256 public constant ABS_MAX_INIT_PRICE = type(uint192).max;

    /// @notice Scale for price multiplier calculations
    uint256 public constant PRICE_MULTIPLIER_SCALE = 1e18;

    /// @notice Basis points divisor for bribeSplit calculations
    uint256 public constant DIVISOR = 10000;

    /*----------  STATE VARIABLES  --------------------------------------*/

    /// @notice The Voter contract (for looking up bribeRouter and bribeSplit)
    address public immutable voter;

    /// @notice Token being sold (e.g., WETH from protocol revenue)
    IERC20 public immutable revenueToken;

    /// @notice Token buyers pay with (e.g., USDC, protocol token)
    IERC20 public immutable paymentToken;

    /// @notice Where auction payments go (treasury, burn address, etc.)
    address public immutable paymentReceiver;

    /// @notice Duration of each auction epoch
    uint256 public immutable epochPeriod;

    /// @notice Multiplier for next epoch's price (scaled by 1e18)
    /// @dev e.g., 2e18 = 2x, so paying 100 USDC -> next epoch starts at 200 USDC
    uint256 public immutable priceMultiplier;

    /// @notice Floor price - initPrice can't go below this
    uint256 public immutable minInitPrice;

    /**
     * @notice Packed epoch state (fits in one 32-byte slot)
     * @param locked Reentrancy guard flag (1 = unlocked, 2 = locked)
     * @param epochId Increments each buy, used for frontrunning protection
     * @param initPrice Starting price for current epoch
     * @param startTime Timestamp when current epoch started
     */
    struct Slot0 {
        uint8 locked;
        uint16 epochId;
        uint192 initPrice;
        uint40 startTime;
    }

    /// @notice Current epoch state
    Slot0 internal slot0;

    /*----------  ERRORS ------------------------------------------------*/

    error Auction__DeadlinePassed();
    error Auction__EpochIdMismatch();
    error Auction__MaxPaymentAmountExceeded();
    error Auction__EmptyAssets();
    error Auction__Reentrancy();
    error Auction__InitPriceBelowMin();
    error Auction__InitPriceExceedsMax();
    error Auction__EpochPeriodBelowMin();
    error Auction__EpochPeriodExceedsMax();
    error Auction__PriceMultiplierBelowMin();
    error Auction__PriceMultiplierExceedsMax();
    error Auction__MinInitPriceBelowMin();
    error Auction__MinInitPriceExceedsAbsMaxInitPrice();
    error Auction__PaymentReceiverIsThis();

    /*----------  EVENTS ------------------------------------------------*/

    event Auction__Buy(
        address indexed buyer,
        address indexed assetsReceiver,
        uint256 revenueAmount,
        uint256 paymentAmount
    );

    /*----------  MODIFIERS  --------------------------------------------*/

    /**
     * @notice Custom reentrancy guard using slot0.locked
     * @dev Uses the same storage slot as epoch data for gas efficiency
     */
    modifier nonReentrant() {
        if (slot0.locked == 2) revert Auction__Reentrancy();
        slot0.locked = 2;
        _;
        slot0.locked = 1;
    }

    /**
     * @notice View-only reentrancy check (doesn't modify state)
     * @dev Prevents reading inconsistent state during reentrancy
     */
    modifier nonReentrantView() {
        if (slot0.locked == 2) revert Auction__Reentrancy();
        _;
    }

    /*----------  CONSTRUCTOR  ------------------------------------------*/

    /**
     * @notice Deploy a new Dutch Auction
     * @param _voter Voter contract address
     * @param _revenueToken Token being auctioned
     * @param _paymentToken Token buyers pay with
     * @param _paymentReceiver Where payments go (minus bribe split)
     * @param _initPrice Starting price for first epoch
     * @param _epochPeriod Duration of each epoch
     * @param _priceMultiplier Next price = payment * multiplier
     * @param _minInitPrice Floor price for initPrice
     */
    constructor(
        address _voter,
        address _revenueToken,
        address _paymentToken,
        address _paymentReceiver,
        uint256 _initPrice,
        uint256 _epochPeriod,
        uint256 _priceMultiplier,
        uint256 _minInitPrice
    ) {
        // Validate parameters
        if (_initPrice < _minInitPrice) revert Auction__InitPriceBelowMin();
        if (_initPrice > ABS_MAX_INIT_PRICE) revert Auction__InitPriceExceedsMax();
        if (_epochPeriod < MIN_EPOCH_PERIOD) revert Auction__EpochPeriodBelowMin();
        if (_epochPeriod > MAX_EPOCH_PERIOD) revert Auction__EpochPeriodExceedsMax();
        if (_priceMultiplier < MIN_PRICE_MULTIPLIER) revert Auction__PriceMultiplierBelowMin();
        if (_priceMultiplier > MAX_PRICE_MULTIPLIER) revert Auction__PriceMultiplierExceedsMax();
        if (_minInitPrice < ABS_MIN_INIT_PRICE) revert Auction__MinInitPriceBelowMin();
        if (_minInitPrice > ABS_MAX_INIT_PRICE) revert Auction__MinInitPriceExceedsAbsMaxInitPrice();
        if (_paymentReceiver == address(this)) revert Auction__PaymentReceiverIsThis();

        // Set immutables
        voter = _voter;
        revenueToken = IERC20(_revenueToken);
        paymentToken = IERC20(_paymentToken);
        paymentReceiver = _paymentReceiver;
        epochPeriod = _epochPeriod;
        priceMultiplier = _priceMultiplier;
        minInitPrice = _minInitPrice;

        // Initialize first epoch
        slot0.initPrice = uint192(_initPrice);
        slot0.startTime = uint40(block.timestamp);
        slot0.locked = 1; // Unlocked state
    }

    /*----------  EXTERNAL FUNCTIONS  -----------------------------------*/

    /**
     * @notice Buy all available revenue tokens at current price
     * @param assetsReceiver Address to receive the revenue tokens
     * @param epochId Expected epoch ID (reverts if mismatch - frontrunning protection)
     * @param deadline Transaction deadline timestamp
     * @param maxPaymentAmount Maximum payment willing to make (slippage protection)
     * @return paymentAmount Actual payment amount
     *
     * @dev Frontrunning Protection:
     *      - epochId must match current epoch (prevents sandwich attacks)
     *      - deadline prevents stale transactions
     *      - maxPaymentAmount prevents paying more than expected
     *
     * Payment Distribution:
     *      - bribeSplit% goes to BribeRouter (looked up from Voter)
     *      - Remainder goes to paymentReceiver
     *
     * Next Epoch:
     *      - initPrice = payment * priceMultiplier (clamped to min/max)
     *      - epochId increments (uint16 wraps around)
     *      - startTime = current block timestamp
     */
    function buy(
        address assetsReceiver,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPaymentAmount
    ) external nonReentrant returns (uint256 paymentAmount) {
        // Check deadline
        if (block.timestamp > deadline) revert Auction__DeadlinePassed();

        // Cache slot0 to memory for gas efficiency
        Slot0 memory slot0Cache = slot0;

        // Frontrunning protection: ensure we're in expected epoch
        if (uint16(epochId) != slot0Cache.epochId) revert Auction__EpochIdMismatch();

        // Get available revenue tokens
        uint256 revenueBalance = revenueToken.balanceOf(address(this));
        if (revenueBalance == 0) revert Auction__EmptyAssets();

        // Calculate current price (linear decay from initPrice to 0)
        paymentAmount = getPriceFromCache(slot0Cache);

        // Slippage protection
        if (paymentAmount > maxPaymentAmount) revert Auction__MaxPaymentAmountExceeded();

        // Process payment if price > 0
        if (paymentAmount > 0) {
            // Pull payment from buyer
            paymentToken.safeTransferFrom(msg.sender, address(this), paymentAmount);

            // Get bribe configuration from Voter
            address bribeRouter = IVoter(voter).bribeRouterOf(address(this));
            uint256 bribeSplit = IVoter(voter).bribeSplit();

            // Calculate split amounts
            uint256 bribeAmount = paymentAmount * bribeSplit / DIVISOR;
            uint256 receiverAmount = paymentAmount - bribeAmount;

            // Send bribe portion to BribeRouter
            if (bribeAmount > 0 && bribeRouter != address(0)) {
                paymentToken.safeTransfer(bribeRouter, bribeAmount);
            } else {
                // No bribe router = all to receiver
                receiverAmount = paymentAmount;
            }

            // Send remainder to payment receiver
            if (receiverAmount > 0) {
                paymentToken.safeTransfer(paymentReceiver, receiverAmount);
            }
        }

        // Transfer all revenue tokens to buyer
        revenueToken.safeTransfer(assetsReceiver, revenueBalance);

        // Calculate next epoch's starting price
        // newInitPrice = paymentAmount * priceMultiplier / scale
        uint256 newInitPrice = paymentAmount * priceMultiplier / PRICE_MULTIPLIER_SCALE;

        // Clamp to valid range
        if (newInitPrice > ABS_MAX_INIT_PRICE) {
            newInitPrice = ABS_MAX_INIT_PRICE;
        } else if (newInitPrice < minInitPrice) {
            newInitPrice = minInitPrice;
        }

        // Setup next epoch
        unchecked {
            slot0Cache.epochId++; // Safe: uint16 wrap is intentional
        }
        slot0Cache.initPrice = uint192(newInitPrice);
        slot0Cache.startTime = uint40(block.timestamp);

        // Write back to storage
        slot0 = slot0Cache;

        emit Auction__Buy(msg.sender, assetsReceiver, revenueBalance, paymentAmount);
    }

    /*----------  INTERNAL FUNCTIONS  -----------------------------------*/

    /**
     * @notice Calculate current price from cached slot0
     * @param slot0Cache Cached slot0 data
     * @return Current price (linear decay from initPrice to 0)
     *
     * @dev Price formula: initPrice * (1 - timePassed / epochPeriod)
     *      - At startTime: price = initPrice
     *      - At startTime + epochPeriod: price = 0
     *      - After epochPeriod: price = 0
     */
    function getPriceFromCache(Slot0 memory slot0Cache) internal view returns (uint256) {
        uint256 timePassed = block.timestamp - slot0Cache.startTime;

        // If epoch period has passed, price is 0
        if (timePassed > epochPeriod) {
            return 0;
        }

        // Linear decay: initPrice - (initPrice * timePassed / epochPeriod)
        return slot0Cache.initPrice - slot0Cache.initPrice * timePassed / epochPeriod;
    }

    /*----------  VIEW FUNCTIONS  ---------------------------------------*/

    /**
     * @notice Get the current auction price
     * @return Current price in payment tokens
     */
    function getPrice() external view nonReentrantView returns (uint256) {
        return getPriceFromCache(slot0);
    }

    /**
     * @notice Get the current epoch state
     * @return Current Slot0 struct
     */
    function getSlot0() external view nonReentrantView returns (Slot0 memory) {
        return slot0;
    }

    /**
     * @notice Get the current revenue token balance
     * @return Amount of revenue tokens available for auction
     */
    function getRevenueBalance() external view returns (uint256) {
        return revenueToken.balanceOf(address(this));
    }

    /**
     * @notice Get the BribeRouter address for this auction
     * @return BribeRouter contract address (looked up from Voter)
     */
    function getBribeRouter() external view returns (address) {
        return IVoter(voter).bribeRouterOf(address(this));
    }
}
