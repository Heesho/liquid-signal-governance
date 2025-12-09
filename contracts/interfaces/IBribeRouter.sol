// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IBribeRouter {
    function voter() external view returns (address);
    function strategy() external view returns (address);
    function paymentToken() external view returns (address);

    function distribute() external;
    function getBribe() external view returns (address);
}
