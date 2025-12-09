// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IStrategy {
    struct Slot0 {
        uint8 locked;
        uint16 epochId;
        uint192 initPrice;
        uint40 startTime;
    }

    function voter() external view returns (address);
    function revenueToken() external view returns (address);
    function paymentToken() external view returns (address);
    function paymentReceiver() external view returns (address);
    function epochPeriod() external view returns (uint256);
    function priceMultiplier() external view returns (uint256);
    function minInitPrice() external view returns (uint256);

    function getPrice() external view returns (uint256);
    function getSlot0() external view returns (Slot0 memory);
    function getRevenueBalance() external view returns (uint256);
    function getBribeRouter() external view returns (address);

    function buy(
        address assetsReceiver,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPaymentAmount
    ) external returns (uint256 paymentAmount);

    function MIN_EPOCH_PERIOD() external pure returns (uint256);
    function MAX_EPOCH_PERIOD() external pure returns (uint256);
    function MIN_PRICE_MULTIPLIER() external pure returns (uint256);
    function MAX_PRICE_MULTIPLIER() external pure returns (uint256);
    function ABS_MIN_INIT_PRICE() external pure returns (uint256);
    function ABS_MAX_INIT_PRICE() external pure returns (uint256);
    function PRICE_MULTIPLIER_SCALE() external pure returns (uint256);
    function DIVISOR() external pure returns (uint256);
}
