// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IVoter} from "./interfaces/IVoter.sol";

/**
 * @title GovernanceToken
 * @author heesho
 * @notice Non-transferable staked governance token with ERC20Votes support for DAO compatibility.
 *         Stake underlying 1:1, clear votes before unstaking.
 *         Compatible with Aragon, Tally, Snapshot, and OpenZeppelin Governor.
 */
contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable token;  // underlying token to stake

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    address public voter;  // voter contract that tracks votes

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error GovernanceToken__TransferDisabled();
    error GovernanceToken__VotesNotCleared();
    error GovernanceToken__InvalidZeroAddress();
    error GovernanceToken__InvalidZeroAmount();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event GovernanceToken__Staked(address indexed account, uint256 amount);
    event GovernanceToken__Unstaked(address indexed account, uint256 amount);
    event GovernanceToken__VoterSet(address indexed voter);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address _token,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) ERC20Permit(_name) {
        if (_token == address(0)) revert GovernanceToken__InvalidZeroAddress();
        token = _token;
    }

    /*//////////////////////////////////////////////////////////////
                            STAKING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Stakes underlying tokens 1:1 for governance tokens
    /// @param amount Amount of underlying tokens to stake
    /// @dev Auto-delegates to self on first stake for ERC20Votes compatibility
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert GovernanceToken__InvalidZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
        if (delegates(msg.sender) == address(0)) {
            _delegate(msg.sender, msg.sender);
        }
        emit GovernanceToken__Staked(msg.sender, amount);
    }

    /// @notice Unstakes governance tokens 1:1 for underlying tokens
    /// @param amount Amount to unstake
    /// @dev Requires all votes to be cleared first (account_UsedWeights == 0)
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert GovernanceToken__InvalidZeroAmount();
        if (voter != address(0) && IVoter(voter).account_UsedWeights(msg.sender) != 0) {
            revert GovernanceToken__VotesNotCleared();
        }
        _burn(msg.sender, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
        emit GovernanceToken__Unstaked(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the voter contract address
    function setVoter(address _voter) external onlyOwner {
        voter = _voter;
        emit GovernanceToken__VoterSet(_voter);
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Prevents transfers between accounts (only mint/burn allowed)
    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override {
        super._beforeTokenTransfer(from, to, amount);
        if (from != address(0) && to != address(0)) revert GovernanceToken__TransferDisabled();
    }

    /// @dev Required override for ERC20Votes
    function _afterTokenTransfer(address from, address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._afterTokenTransfer(from, to, amount);
    }

    /// @dev Required override for ERC20Votes
    function _mint(address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._mint(to, amount);
    }

    /// @dev Required override for ERC20Votes
    function _burn(address account, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._burn(account, amount);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the underlying token address
    function underlying() external view returns (address) {
        return token;
    }
}
