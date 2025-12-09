// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/IVoter.sol";

/**
 * @title RevenueRouter
 * @author heesho
 *
 * @notice Bridge between protocol revenue sources and the Voter contract.
 *
 * @dev Design Philosophy:
 *      - Decouples LSG from protocol-specific revenue mechanics
 *      - Provides a single collection point for multiple revenue sources
 *      - Permissionless flushing (anyone can trigger distribution)
 *
 * Integration Pattern:
 *      1. Protocol sets this contract as fee recipient/treasury in their contracts
 *      2. Various protocol actions send REVENUE_TOKEN here (fees, sales, etc.)
 *      3. Revenue accumulates in this contract
 *      4. Anyone calls flush() to push revenue to Voter for distribution
 *      5. Voter updates its index and strategies can claim their share
 *
 * Example Revenue Sources:
 *      - DEX trading fees
 *      - Lending protocol interest
 *      - NFT marketplace royalties
 *      - Protocol service fees
 *
 * @dev Voter.revenueSource must be set to this contract's address
 *      for notifyAndDistribute() calls to succeed
 */
contract RevenueRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*----------  STATE VARIABLES  --------------------------------------*/

    /// @notice The Voter contract that receives revenue notifications
    address public immutable voter;

    /// @notice The token collected as revenue (e.g., WETH, USDC)
    address public immutable revenueToken;

    /*----------  ERRORS ------------------------------------------------*/

    error RevenueRouter__InvalidZeroAddress();
    error RevenueRouter__NoRevenueToFlush();

    /*----------  EVENTS ------------------------------------------------*/

    event RevenueRouter__Flushed(address indexed caller, uint256 amount);

    /*----------  CONSTRUCTOR  ------------------------------------------*/

    /**
     * @notice Initialize the RevenueRouter
     * @param _revenueToken The token to collect and distribute
     * @param _voter The Voter contract that will receive revenue
     *
     * @dev After deployment, Voter.setRevenueSource() must be called
     *      with this contract's address
     */
    constructor(address _revenueToken, address _voter) {
        if (_revenueToken == address(0)) revert RevenueRouter__InvalidZeroAddress();
        if (_voter == address(0)) revert RevenueRouter__InvalidZeroAddress();

        revenueToken = _revenueToken;
        voter = _voter;
    }

    /*----------  EXTERNAL FUNCTIONS  -----------------------------------*/

    /**
     * @notice Push all accumulated revenue to the Voter for distribution
     * @return amount The amount of revenue flushed
     *
     * @dev Permissionless - anyone can call (typically keepers/bots)
     *
     * Flow:
     *      1. Gets current balance of revenueToken
     *      2. Transfers entire balance to Voter
     *      3. Calls Voter.notifyAndDistribute() to update revenue index
     *      4. Strategies can then claim their proportional share
     *
     * @dev Reverts if no revenue to flush (prevents empty notifications)
     */
    function flush() external nonReentrant returns (uint256 amount) {
        amount = IERC20(revenueToken).balanceOf(address(this));

        if (amount == 0) revert RevenueRouter__NoRevenueToFlush();

        // Transfer revenue to Voter
        IERC20(revenueToken).safeTransfer(voter, amount);

        // Notify Voter to update distribution index
        // This makes revenue available for strategies to claim
        IVoter(voter).notifyAndDistribute(amount);

        emit RevenueRouter__Flushed(msg.sender, amount);
    }

    /**
     * @notice Flush if revenue available, otherwise do nothing (no revert)
     * @return amount The amount of revenue flushed (0 if none)
     *
     * @dev Useful for automated keepers that run on a schedule
     *      Doesn't revert on empty balance, just returns 0
     */
    function flushIfAvailable() external nonReentrant returns (uint256 amount) {
        amount = IERC20(revenueToken).balanceOf(address(this));

        if (amount > 0) {
            IERC20(revenueToken).safeTransfer(voter, amount);
            IVoter(voter).notifyAndDistribute(amount);
            emit RevenueRouter__Flushed(msg.sender, amount);
        }
        // If amount == 0, just return 0 without reverting
    }

    /*----------  VIEW FUNCTIONS  ---------------------------------------*/

    /**
     * @notice Get the current pending revenue balance
     * @return Amount of revenueToken waiting to be flushed
     *
     * @dev Useful for:
     *      - UIs showing pending revenue
     *      - Keepers deciding whether to call flush()
     *      - Monitoring protocol revenue flow
     */
    function pendingRevenue() external view returns (uint256) {
        return IERC20(revenueToken).balanceOf(address(this));
    }
}
