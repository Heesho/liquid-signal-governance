// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/IVoter.sol";

/**
 * @title GovernanceToken
 * @author heesho
 *
 * @notice Non-transferable staked governance token for Liquid Signal Governance (LSG).
 *
 * Users stake the UNDERLYING token to receive GovernanceToken 1:1.
 * GovernanceToken is non-transferable between accounts (only minting/burning allowed).
 * Users must clear their votes (usedWeights = 0 in Voter) before unstaking.
 *
 * This prevents:
 * - "vote, transfer, vote again" attacks
 * - Flash-loan based governance attacks
 * - Makes voting power tied to actual time-locked exposure
 *
 * @dev Inherits ERC20 for token functionality but overrides _beforeTokenTransfer
 *      to block all transfers except mint/burn operations.
 */
contract GovernanceToken is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*----------  STATE VARIABLES  --------------------------------------*/

    /// @notice The token that users stake to receive governance tokens (e.g., protocol token)
    address public immutable UNDERLYING;

    /// @notice The Voter contract that tracks voting weights
    /// @dev Used to check if user has active votes before allowing unstake
    address public voter;

    /*----------  ERRORS ------------------------------------------------*/

    error GovernanceToken__TransferDisabled();
    error GovernanceToken__VotesNotCleared();
    error GovernanceToken__InvalidZeroAddress();
    error GovernanceToken__InvalidZeroAmount();
    error GovernanceToken__VoterAlreadySet();

    /*----------  EVENTS ------------------------------------------------*/

    event GovernanceToken__Staked(address indexed account, uint256 amount);
    event GovernanceToken__Unstaked(address indexed account, uint256 amount);
    event GovernanceToken__VoterSet(address indexed voter);

    /*----------  CONSTRUCTOR  ------------------------------------------*/

    /**
     * @notice Initialize the governance token with underlying token and metadata
     * @param _underlying The ERC20 token users will stake
     * @param _name Name of the governance token (e.g., "Staked PROTO")
     * @param _symbol Symbol of the governance token (e.g., "sPROTO")
     */
    constructor(
        address _underlying,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) {
        if (_underlying == address(0)) revert GovernanceToken__InvalidZeroAddress();
        UNDERLYING = _underlying;
    }

    /*----------  EXTERNAL FUNCTIONS  -----------------------------------*/

    /**
     * @notice Stake underlying tokens to receive governance tokens 1:1
     * @dev Transfers underlying from user, mints equal governance tokens
     * @param amount The amount of underlying tokens to stake
     *
     * Flow:
     * 1. User approves this contract to spend their underlying tokens
     * 2. User calls stake(amount)
     * 3. Underlying tokens transferred from user to this contract
     * 4. Equal amount of governance tokens minted to user
     * 5. User can now vote in Voter contract with their governance token balance
     */
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert GovernanceToken__InvalidZeroAmount();

        // Pull underlying tokens from user
        IERC20(UNDERLYING).safeTransferFrom(msg.sender, address(this), amount);

        // Mint governance tokens 1:1
        _mint(msg.sender, amount);

        emit GovernanceToken__Staked(msg.sender, amount);
    }

    /**
     * @notice Unstake governance tokens to receive underlying tokens 1:1
     * @dev User must have cleared all votes (usedWeights = 0) before unstaking
     * @param amount The amount of governance tokens to unstake
     *
     * Flow:
     * 1. User must first call Voter.reset() to clear their votes
     * 2. User calls unstake(amount)
     * 3. Contract checks user has no active votes (usedWeights == 0)
     * 4. Governance tokens burned from user
     * 5. Equal amount of underlying tokens transferred to user
     *
     * @dev The vote clearing requirement prevents users from:
     *      - Voting, unstaking, transferring underlying, re-staking, voting again
     *      - Using flash loans to temporarily boost voting power
     */
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert GovernanceToken__InvalidZeroAmount();

        // If voter is set, ensure user has cleared their votes
        // This prevents vote manipulation through stake/unstake cycles
        if (voter != address(0)) {
            if (IVoter(voter).usedWeights(msg.sender) != 0) {
                revert GovernanceToken__VotesNotCleared();
            }
        }

        // Burn governance tokens
        _burn(msg.sender, amount);

        // Return underlying tokens 1:1
        IERC20(UNDERLYING).safeTransfer(msg.sender, amount);

        emit GovernanceToken__Unstaked(msg.sender, amount);
    }

    /*----------  RESTRICTED FUNCTIONS  ---------------------------------*/

    /**
     * @notice Set the voter contract address (can only be set once)
     * @dev Anyone can call this, but it can only be set once (one-time setup)
     * @param _voter The address of the Voter contract
     *
     * @dev No access control because:
     *      - Can only be set once (immutable after first set)
     *      - Setting wrong address just means unstake check doesn't work
     *      - Protocol deployer should set this immediately after deployment
     */
    function setVoter(address _voter) external {
        if (_voter == address(0)) revert GovernanceToken__InvalidZeroAddress();
        if (voter != address(0)) revert GovernanceToken__VoterAlreadySet();
        voter = _voter;
        emit GovernanceToken__VoterSet(_voter);
    }

    /*----------  INTERNAL OVERRIDES  -----------------------------------*/

    /**
     * @notice Override transfer to disable transfers between accounts
     * @dev Only minting (from == 0) and burning (to == 0) are allowed
     *
     * This is the core security mechanism that makes governance tokens non-transferable:
     * - from == address(0): This is a mint operation (allowed)
     * - to == address(0): This is a burn operation (allowed)
     * - Both non-zero: This is a transfer (blocked)
     *
     * @param from Source address (address(0) for minting)
     * @param to Destination address (address(0) for burning)
     */
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 /* amount */
    ) internal pure override {
        // Block all transfers between accounts
        // Only allow mint (from == 0) and burn (to == 0)
        if (from != address(0) && to != address(0)) {
            revert GovernanceToken__TransferDisabled();
        }
    }

    /*----------  VIEW FUNCTIONS  ---------------------------------------*/

    /**
     * @notice Get the underlying token address
     * @return The address of the token users stake
     */
    function underlying() external view returns (address) {
        return UNDERLYING;
    }
}
