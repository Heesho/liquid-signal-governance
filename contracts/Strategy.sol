// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVoter} from "./interfaces/IVoter.sol";

/**
 * @title Strategy
 * @author heesho
 * @notice Dutch auction selling revenue tokens. Price decays linearly from initPrice to 0 over epochPeriod.
 *         When bought, price resets to (paymentAmount * priceMultiplier), bounded by [minInitPrice, ABS_MAX_INIT_PRICE].
 */
contract Strategy {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant MIN_EPOCH_PERIOD = 1 hours;          // min auction duration
    uint256 public constant MAX_EPOCH_PERIOD = 365 days;         // max auction duration
    uint256 public constant MIN_PRICE_MULTIPLIER = 1.1e18;       // min 1.1x price increase
    uint256 public constant MAX_PRICE_MULTIPLIER = 3e18;         // max 3x price increase
    uint256 public constant ABS_MIN_INIT_PRICE = 1e6;            // absolute min starting price
    uint256 public constant ABS_MAX_INIT_PRICE = type(uint192).max; // absolute max starting price
    uint256 public constant PRICE_MULTIPLIER_SCALE = 1e18;       // scale for price multiplier
    uint256 public constant DIVISOR = 10000;                     // basis points divisor

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable voter;           // voter contract for bribe split
    IERC20 public immutable revenueToken;     // token being auctioned
    IERC20 public immutable paymentToken;     // token used to pay
    address public immutable paymentReceiver; // receives payment (minus bribe split)
    uint256 public immutable epochPeriod;     // duration of price decay
    uint256 public immutable priceMultiplier; // multiplier for next epoch's init price
    uint256 public immutable minInitPrice;    // floor for init price

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    struct Slot0 {
        uint8 locked;       // 1=unlocked, 2=locked (reentrancy)
        uint16 epochId;     // increments each buy (frontrun protection)
        uint192 initPrice;  // starting price for current epoch
        uint40 startTime;   // epoch start timestamp
    }

    Slot0 internal slot0;

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Strategy__DeadlinePassed();
    error Strategy__EpochIdMismatch();
    error Strategy__MaxPaymentAmountExceeded();
    error Strategy__EmptyAssets();
    error Strategy__Reentrancy();
    error Strategy__InitPriceBelowMin();
    error Strategy__InitPriceExceedsMax();
    error Strategy__EpochPeriodBelowMin();
    error Strategy__EpochPeriodExceedsMax();
    error Strategy__PriceMultiplierBelowMin();
    error Strategy__PriceMultiplierExceedsMax();
    error Strategy__MinInitPriceBelowMin();
    error Strategy__MinInitPriceExceedsAbsMaxInitPrice();
    error Strategy__PaymentReceiverIsThis();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Strategy__Buy(
        address indexed buyer, address indexed assetsReceiver, uint256 revenueAmount, uint256 paymentAmount
    );

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier nonReentrant() {
        if (slot0.locked == 2) revert Strategy__Reentrancy();
        slot0.locked = 2;
        _;
        slot0.locked = 1;
    }

    modifier nonReentrantView() {
        if (slot0.locked == 2) revert Strategy__Reentrancy();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

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
        if (_initPrice < _minInitPrice) revert Strategy__InitPriceBelowMin();
        if (_initPrice > ABS_MAX_INIT_PRICE) revert Strategy__InitPriceExceedsMax();
        if (_epochPeriod < MIN_EPOCH_PERIOD) revert Strategy__EpochPeriodBelowMin();
        if (_epochPeriod > MAX_EPOCH_PERIOD) revert Strategy__EpochPeriodExceedsMax();
        if (_priceMultiplier < MIN_PRICE_MULTIPLIER) revert Strategy__PriceMultiplierBelowMin();
        if (_priceMultiplier > MAX_PRICE_MULTIPLIER) revert Strategy__PriceMultiplierExceedsMax();
        if (_minInitPrice < ABS_MIN_INIT_PRICE) revert Strategy__MinInitPriceBelowMin();
        if (_minInitPrice > ABS_MAX_INIT_PRICE) revert Strategy__MinInitPriceExceedsAbsMaxInitPrice();
        if (_paymentReceiver == address(this)) revert Strategy__PaymentReceiverIsThis();

        voter = _voter;
        revenueToken = IERC20(_revenueToken);
        paymentToken = IERC20(_paymentToken);
        paymentReceiver = _paymentReceiver;
        epochPeriod = _epochPeriod;
        priceMultiplier = _priceMultiplier;
        minInitPrice = _minInitPrice;

        slot0.initPrice = uint192(_initPrice);
        slot0.startTime = uint40(block.timestamp);
        slot0.locked = 1;
    }

    /*//////////////////////////////////////////////////////////////
                            AUCTION FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Buys all revenue tokens at current dutch auction price
    /// @param assetsReceiver Address to receive revenue tokens
    /// @param epochId Must match current epochId (frontrun protection)
    /// @param deadline Transaction must execute before this timestamp
    /// @param maxPaymentAmount Maximum payment willing to make (slippage protection)
    /// @return paymentAmount Actual payment amount
    function buy(address assetsReceiver, uint256 epochId, uint256 deadline, uint256 maxPaymentAmount)
        external
        nonReentrant
        returns (uint256 paymentAmount)
    {
        if (block.timestamp > deadline) revert Strategy__DeadlinePassed();

        Slot0 memory slot0Cache = slot0;
        if (uint16(epochId) != slot0Cache.epochId) revert Strategy__EpochIdMismatch();

        uint256 revenueBalance = revenueToken.balanceOf(address(this));
        if (revenueBalance == 0) revert Strategy__EmptyAssets();

        paymentAmount = getPriceFromCache(slot0Cache);
        if (paymentAmount > maxPaymentAmount) revert Strategy__MaxPaymentAmountExceeded();

        if (paymentAmount > 0) {
            paymentToken.safeTransferFrom(msg.sender, address(this), paymentAmount);

            // split payment between bribe and receiver
            uint256 bribeSplit = IVoter(voter).bribeSplit();
            uint256 bribeAmount = paymentAmount * bribeSplit / DIVISOR;
            uint256 receiverAmount = paymentAmount - bribeAmount;

            if (bribeAmount > 0) {
                address bribeRouter = IVoter(voter).strategy_BribeRouter(address(this));
                paymentToken.safeTransfer(bribeRouter, bribeAmount);
            }

            if (receiverAmount > 0) paymentToken.safeTransfer(paymentReceiver, receiverAmount);
        }

        revenueToken.safeTransfer(assetsReceiver, revenueBalance);

        // calculate next epoch's init price
        uint256 newInitPrice = paymentAmount * priceMultiplier / PRICE_MULTIPLIER_SCALE;
        if (newInitPrice > ABS_MAX_INIT_PRICE) newInitPrice = ABS_MAX_INIT_PRICE;
        else if (newInitPrice < minInitPrice) newInitPrice = minInitPrice;

        // advance epoch
        unchecked {
            slot0Cache.epochId++;
        }
        slot0Cache.initPrice = uint192(newInitPrice);
        slot0Cache.startTime = uint40(block.timestamp);
        slot0 = slot0Cache;

        emit Strategy__Buy(msg.sender, assetsReceiver, revenueBalance, paymentAmount);
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Calculates current price based on linear decay from initPrice to 0
    function getPriceFromCache(Slot0 memory slot0Cache) internal view returns (uint256) {
        uint256 timePassed = block.timestamp - slot0Cache.startTime;
        if (timePassed > epochPeriod) return 0;
        return slot0Cache.initPrice - slot0Cache.initPrice * timePassed / epochPeriod;
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns current auction price
    function getPrice() external view nonReentrantView returns (uint256) {
        return getPriceFromCache(slot0);
    }

    /// @notice Returns current slot0 state
    function getSlot0() external view nonReentrantView returns (Slot0 memory) {
        return slot0;
    }

    /// @notice Returns revenue token balance available for purchase
    function getRevenueBalance() external view returns (uint256) {
        return revenueToken.balanceOf(address(this));
    }

    /// @notice Returns the bribe router for this strategy
    function getBribeRouter() external view returns (address) {
        return IVoter(voter).strategy_BribeRouter(address(this));
    }
}
