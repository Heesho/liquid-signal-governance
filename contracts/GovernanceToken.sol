// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IVoter.sol";

/**
 * @title GovernanceToken
 * @author heesho
 * @notice Non-transferable staked governance token. Stake underlying 1:1, clear votes before unstaking.
 */
contract GovernanceToken is ERC20, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    address public immutable token;
    address public voter;

    error GovernanceToken__TransferDisabled();
    error GovernanceToken__VotesNotCleared();
    error GovernanceToken__InvalidZeroAddress();
    error GovernanceToken__InvalidZeroAmount();

    event GovernanceToken__Staked(address indexed account, uint256 amount);
    event GovernanceToken__Unstaked(address indexed account, uint256 amount);
    event GovernanceToken__VoterSet(address indexed voter);

    constructor(address _token, string memory _name, string memory _symbol) ERC20(_name, _symbol) {
        if (_token == address(0)) revert GovernanceToken__InvalidZeroAddress();
        token = _token;
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert GovernanceToken__InvalidZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
        emit GovernanceToken__Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert GovernanceToken__InvalidZeroAmount();
        if (voter != address(0) && IVoter(voter).account_UsedWeights(msg.sender) != 0) {
            revert GovernanceToken__VotesNotCleared();
        }
        _burn(msg.sender, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
        emit GovernanceToken__Unstaked(msg.sender, amount);
    }

    function setVoter(address _voter) external onlyOwner {
        voter = _voter;
        emit GovernanceToken__VoterSet(_voter);
    }

    function _beforeTokenTransfer(address from, address to, uint256) internal pure override {
        if (from != address(0) && to != address(0)) revert GovernanceToken__TransferDisabled();
    }

    function underlying() external view returns (address) {
        return token;
    }
}
