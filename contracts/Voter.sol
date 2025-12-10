// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGovernanceToken} from "./interfaces/IGovernanceToken.sol";
import {IBribe} from "./interfaces/IBribe.sol";
import {IBribeFactory} from "./interfaces/IBribeFactory.sol";
import {IStrategyFactory} from "./interfaces/IStrategyFactory.sol";

/**
 * @title Voter
 * @author heesho
 * @notice Core governance contract that manages voting on strategies and distributes revenue proportionally.
 *         Users vote with their governance token balance to direct revenue to strategies.
 *         Revenue is distributed pro-rata based on strategy weight (total votes).
 */
contract Voter is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant DURATION = 7 days;       // epoch duration for voting
    uint256 public constant MAX_BRIBE_SPLIT = 5000;  // max 50% to bribes
    uint256 public constant DIVISOR = 10000;         // basis points divisor

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable governanceToken;   // token used for voting power
    address public immutable revenueToken;      // token distributed as revenue
    address public immutable treasury;          // receives revenue when no votes
    address public immutable bribeFactory;      // creates bribe contracts
    address public immutable strategyFactory;   // creates strategy contracts

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    address public revenueSource;    // authorized to notify revenue
    uint256 public bribeSplit;       // % of revenue to bribes (in basis points)
    uint256 public totalWeight;      // sum of all strategy weights
    address[] public strategies;     // list of all strategies

    /*//////////////////////////////////////////////////////////////
                            STRATEGY MAPPINGS
    //////////////////////////////////////////////////////////////*/

    mapping(address => address) public strategy_Bribe;         // strategy => bribe contract
    mapping(address => address) public strategy_BribeRouter;   // strategy => bribe router
    mapping(address => address) public strategy_PaymentToken;  // strategy => payment token
    mapping(address => uint256) public strategy_Weight;        // strategy => total votes
    mapping(address => bool) public strategy_IsValid;          // strategy => exists
    mapping(address => bool) public strategy_IsAlive;          // strategy => not killed

    /*//////////////////////////////////////////////////////////////
                            ACCOUNT MAPPINGS
    //////////////////////////////////////////////////////////////*/

    mapping(address => mapping(address => uint256)) public account_Strategy_Votes; // account => strategy => votes
    mapping(address => address[]) public account_StrategyVote;   // account => strategies voted for
    mapping(address => uint256) public account_UsedWeights;      // account => total votes used (must be 0 to unstake)
    mapping(address => uint256) public account_LastVoted;        // account => last vote timestamp

    /*//////////////////////////////////////////////////////////////
                        REVENUE DISTRIBUTION STATE
    //////////////////////////////////////////////////////////////*/

    uint256 internal index;                                      // global revenue index
    mapping(address => uint256) internal strategy_SupplyIndex;   // strategy => last index
    mapping(address => uint256) public strategy_Claimable;       // strategy => pending revenue

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Voter__AlreadyVotedThisEpoch();
    error Voter__NotAuthorizedGovernance();
    error Voter__StrategyLengthNotEqualToWeightLength();
    error Voter__NotAuthorizedRevenueSource();
    error Voter__InvalidZeroAddress();
    error Voter__StrategyExists();
    error Voter__StrategyIsDead();
    error Voter__NotStrategy();
    error Voter__BribeSplitExceedsMax();
    error Voter__AlreadyVotedForStrategy();
    error Voter__ZeroWeight();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Voter__StrategyAdded(
        address indexed strategy,
        address indexed bribe,
        address indexed bribeRouter,
        address paymentToken,
        address paymentReceiver
    );
    event Voter__StrategyKilled(address indexed strategy);
    event Voter__Voted(address indexed voter, address indexed strategy, uint256 weight);
    event Voter__Abstained(address indexed account, address indexed strategy, uint256 weight);
    event Voter__NotifyRevenue(address indexed sender, uint256 amount);
    event Voter__DistributeRevenue(address indexed sender, address indexed strategy, uint256 amount);
    event Voter__BribeRewardAdded(address indexed bribe, address indexed reward);
    event Voter__RevenueSourceSet(address indexed revenueSource);
    event Voter__BribeSplitSet(uint256 bribeSplit);

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Ensures account can only vote/reset once per epoch
    modifier onlyNewEpoch(address account) {
        if ((block.timestamp / DURATION) * DURATION <= account_LastVoted[account]) {
            revert Voter__AlreadyVotedThisEpoch();
        }
        _;
    }

    /// @notice Prevents zero address arguments
    modifier nonZeroAddress(address _account) {
        if (_account == address(0)) revert Voter__InvalidZeroAddress();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address _governanceToken,
        address _revenueToken,
        address _treasury,
        address _bribeFactory,
        address _strategyFactory
    ) {
        governanceToken = _governanceToken;
        revenueToken = _revenueToken;
        treasury = _treasury;
        bribeFactory = _bribeFactory;
        strategyFactory = _strategyFactory;
    }

    /*//////////////////////////////////////////////////////////////
                            VOTING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Resets caller's votes, withdrawing from all bribes
    function reset() external onlyNewEpoch(msg.sender) {
        account_LastVoted[msg.sender] = block.timestamp;
        _reset(msg.sender);
    }

    /// @notice Distributes caller's voting power across strategies
    /// @param _strategies Strategies to vote for
    /// @param _weights Relative weights for each strategy (normalized internally)
    function vote(address[] calldata _strategies, uint256[] calldata _weights) external onlyNewEpoch(msg.sender) {
        if (_strategies.length != _weights.length) revert Voter__StrategyLengthNotEqualToWeightLength();
        account_LastVoted[msg.sender] = block.timestamp;
        _vote(msg.sender, _strategies, _weights);
    }

    /// @notice Claims accumulated bribe rewards from multiple bribes
    /// @param _bribes Array of bribe contract addresses to claim from
    function claimBribes(address[] memory _bribes) external {
        for (uint256 i = 0; i < _bribes.length; i++) {
            IBribe(_bribes[i]).getReward(msg.sender);
        }
    }

    /*//////////////////////////////////////////////////////////////
                        REVENUE DISTRIBUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Called by revenueSource to add revenue for distribution
    /// @param amount Amount of revenueToken to add
    function notifyRevenue(uint256 amount) external {
        if (msg.sender != revenueSource) revert Voter__NotAuthorizedRevenueSource();
        IERC20(revenueToken).safeTransferFrom(msg.sender, address(this), amount);
        if (totalWeight == 0) {
            IERC20(revenueToken).safeTransfer(treasury, amount);
            return;
        }
        uint256 _ratio = amount * 1e18 / totalWeight;
        if (_ratio > 0) index += _ratio;
        emit Voter__NotifyRevenue(msg.sender, amount);
    }

    /// @notice Sends accumulated revenue to a strategy
    /// @param _strategy Strategy to distribute revenue to
    function distribute(address _strategy) public nonReentrant {
        _updateFor(_strategy);
        uint256 _claimable = strategy_Claimable[_strategy];
        if (_claimable > 0) {
            strategy_Claimable[_strategy] = 0;
            IERC20(revenueToken).safeTransfer(_strategy, _claimable);
            emit Voter__DistributeRevenue(msg.sender, _strategy, _claimable);
        }
    }

    /// @notice Distributes revenue to strategies in a range
    function distributeRange(uint256 start, uint256 finish) public {
        for (uint256 x = start; x < finish; x++) {
            distribute(strategies[x]);
        }
    }

    /// @notice Distributes revenue to all strategies
    function distributeAll() external {
        distributeRange(0, strategies.length);
    }

    /*//////////////////////////////////////////////////////////////
                            INDEX UPDATES
    //////////////////////////////////////////////////////////////*/

    /// @notice Updates revenue index for multiple strategies
    function updateFor(address[] memory _strategies) external {
        for (uint256 i = 0; i < _strategies.length; i++) {
            _updateFor(_strategies[i]);
        }
    }

    /// @notice Updates revenue index for strategies in a range
    function updateForRange(uint256 start, uint256 end) public {
        for (uint256 i = start; i < end; i++) {
            _updateFor(strategies[i]);
        }
    }

    /// @notice Updates revenue index for all strategies
    function updateAll() external {
        updateForRange(0, strategies.length);
    }

    /// @notice Updates revenue index for a single strategy
    function updateStrategy(address _strategy) external {
        _updateFor(_strategy);
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the authorized revenue source
    function setRevenueSource(address _revenueSource) external onlyOwner nonZeroAddress(_revenueSource) {
        revenueSource = _revenueSource;
        emit Voter__RevenueSourceSet(_revenueSource);
    }

    /// @notice Sets the percentage of revenue directed to bribes
    function setBribeSplit(uint256 _bribeSplit) external onlyOwner {
        if (_bribeSplit > MAX_BRIBE_SPLIT) revert Voter__BribeSplitExceedsMax();
        bribeSplit = _bribeSplit;
        emit Voter__BribeSplitSet(_bribeSplit);
    }

    /// @notice Creates a new strategy with associated bribe contract
    function addStrategy(
        address _paymentToken,
        address _paymentReceiver,
        uint256 _initPrice,
        uint256 _epochPeriod,
        uint256 _priceMultiplier,
        uint256 _minInitPrice
    ) external onlyOwner returns (address strategy, address bribe, address bribeRouter) {
        bribe = IBribeFactory(bribeFactory).createBribe(address(this));
        IBribe(bribe).addReward(_paymentToken);

        (strategy, bribeRouter) = IStrategyFactory(strategyFactory).createStrategy(
            address(this),
            revenueToken,
            _paymentToken,
            _paymentReceiver,
            _initPrice,
            _epochPeriod,
            _priceMultiplier,
            _minInitPrice
        );

        if (strategy_IsValid[strategy]) revert Voter__StrategyExists();

        strategies.push(strategy);
        strategy_IsValid[strategy] = true;
        strategy_IsAlive[strategy] = true;
        strategy_Bribe[strategy] = bribe;
        strategy_BribeRouter[strategy] = bribeRouter;
        strategy_PaymentToken[strategy] = _paymentToken;
        strategy_SupplyIndex[strategy] = index;

        emit Voter__StrategyAdded(strategy, bribe, bribeRouter, _paymentToken, _paymentReceiver);
    }

    /// @notice Deactivates a strategy, sending pending revenue to treasury
    /// @dev Weight is NOT zeroed here - users must reset/vote to reclaim their votes
    function killStrategy(address _strategy) external onlyOwner {
        if (!strategy_IsAlive[_strategy]) revert Voter__StrategyIsDead();

        _updateFor(_strategy);

        uint256 _claimable = strategy_Claimable[_strategy];
        if (_claimable > 0) {
            strategy_Claimable[_strategy] = 0;
            IERC20(revenueToken).safeTransfer(treasury, _claimable);
        }

        strategy_IsAlive[_strategy] = false;
        emit Voter__StrategyKilled(_strategy);
    }

    /// @notice Adds a new reward token to a bribe contract
    function addBribeReward(address _bribe, address _rewardToken) external onlyOwner nonZeroAddress(_rewardToken) {
        IBribe(_bribe).addReward(_rewardToken);
        emit Voter__BribeRewardAdded(_bribe, _rewardToken);
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Removes all votes for an account, withdraws from bribes
    function _reset(address account) internal {
        address[] storage _strategyVote = account_StrategyVote[account];
        uint256 _strategyVoteCnt = _strategyVote.length;
        uint256 _totalWeight = 0;

        for (uint256 i = 0; i < _strategyVoteCnt; i++) {
            address _strategy = _strategyVote[i];
            uint256 _votes = account_Strategy_Votes[account][_strategy];

            if (_votes > 0) {
                _updateFor(_strategy);
                strategy_Weight[_strategy] -= _votes;
                account_Strategy_Votes[account][_strategy] = 0;
                IBribe(strategy_Bribe[_strategy])._withdraw(
                    IBribe(strategy_Bribe[_strategy]).account_Balance(account), account
                );
                _totalWeight += _votes;
                emit Voter__Abstained(account, _strategy, _votes);
            }
        }

        totalWeight -= _totalWeight;
        account_UsedWeights[account] = 0;
        delete account_StrategyVote[account];
    }

    /// @dev Allocates account's voting power to strategies based on weights
    function _vote(address account, address[] memory _strategyVote, uint256[] memory _weights) internal {
        _reset(account);

        uint256 _strategyCnt = _strategyVote.length;
        uint256 _weight = IGovernanceToken(governanceToken).balanceOf(account); // voting power
        uint256 _totalVoteWeight = 0;
        uint256 _usedWeight = 0;

        // sum weights for valid strategies to normalize
        for (uint256 i = 0; i < _strategyCnt; i++) {
            address _strategy = _strategyVote[i];
            if (strategy_IsValid[_strategy] && strategy_IsAlive[_strategy]) _totalVoteWeight += _weights[i];
        }

        // allocate votes proportionally
        for (uint256 i = 0; i < _strategyCnt; i++) {
            address _strategy = _strategyVote[i];

            if (strategy_IsValid[_strategy] && strategy_IsAlive[_strategy]) {
                uint256 _strategyWeight = _weights[i] * _weight / _totalVoteWeight;
                if (account_Strategy_Votes[account][_strategy] != 0) revert Voter__AlreadyVotedForStrategy();
                if (_strategyWeight == 0) revert Voter__ZeroWeight();

                _updateFor(_strategy);
                account_StrategyVote[account].push(_strategy);

                strategy_Weight[_strategy] += _strategyWeight;
                account_Strategy_Votes[account][_strategy] += _strategyWeight;
                IBribe(strategy_Bribe[_strategy])._deposit(_strategyWeight, account);
                _usedWeight += _strategyWeight;

                emit Voter__Voted(account, _strategy, _strategyWeight);
            }
        }

        totalWeight += _usedWeight;
        account_UsedWeights[account] = _usedWeight;
    }

    /// @dev Updates strategy's claimable revenue based on global index
    function _updateFor(address _strategy) internal {
        uint256 _supplied = strategy_Weight[_strategy];
        if (_supplied > 0) {
            uint256 _supplyIndex = strategy_SupplyIndex[_strategy];
            uint256 _index = index;
            strategy_SupplyIndex[_strategy] = _index;

            uint256 _delta = _index - _supplyIndex;
            if (_delta > 0) {
                uint256 _share = _supplied * _delta / 1e18;
                if (strategy_IsAlive[_strategy]) strategy_Claimable[_strategy] += _share;
            }
        } else {
            strategy_SupplyIndex[_strategy] = index;
        }
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns all strategy addresses
    function getStrategies() external view returns (address[] memory) {
        return strategies;
    }

    /// @notice Returns the number of strategies
    function length() external view returns (uint256) {
        return strategies.length;
    }

    /// @notice Returns strategies an account has voted for
    function getStrategyVote(address account) external view returns (address[] memory) {
        return account_StrategyVote[account];
    }

    /// @notice Returns pending revenue from index delta (not yet added to claimable)
    /// @dev This is revenue that has been notified but not yet updated for this strategy
    function strategy_PendingRevenue(address strategy) external view returns (uint256) {
        uint256 _supplied = strategy_Weight[strategy];
        if (_supplied == 0) return 0;

        uint256 _delta = index - strategy_SupplyIndex[strategy];
        if (_delta == 0) return 0;

        return _supplied * _delta / 1e18;
    }
}
