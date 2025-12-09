// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IGovernanceToken.sol";
import "./interfaces/IBribe.sol";
import "./interfaces/IBribeFactory.sol";
import "./interfaces/IStrategyFactory.sol";

/**
 * @title Voter
 * @author heesho
 * @notice Core governance contract. Tracks votes, distributes revenue to strategies proportionally.
 */
contract Voter is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    uint256 internal constant DURATION = 7 days;
    uint256 public constant MAX_BRIBE_SPLIT = 5000;
    uint256 public constant DIVISOR = 10000;

    address public immutable governanceToken;
    address public immutable revenueToken;
    address public immutable treasury;
    address public immutable bribeFactory;
    address public immutable strategyFactory;
    address public revenueSource;
    uint256 public bribeSplit;
    uint256 public totalWeight;
    address[] public strategies;

    mapping(address => address) public strategy_Bribe;
    mapping(address => address) public strategy_BribeRouter;
    mapping(address => address) public strategy_PaymentToken;
    mapping(address => uint256) public strategy_Weight;
    mapping(address => mapping(address => uint256)) public account_Strategy_Votes;
    mapping(address => address[]) public account_StrategyVote;
    mapping(address => uint256) public account_UsedWeights; // must be 0 to unstake
    mapping(address => uint256) public account_LastVoted;
    mapping(address => bool) public strategy_IsValid;
    mapping(address => bool) public strategy_IsAlive;
    uint256 internal index;
    mapping(address => uint256) internal strategy_SupplyIndex;
    mapping(address => uint256) public strategy_Claimable;

    error Voter__AlreadyVotedThisEpoch();
    error Voter__NotAuthorizedGovernance();
    error Voter__StrategyLengthNotEqualToWeightLength();
    error Voter__NotAuthorizedRevenueSource();
    error Voter__InvalidZeroAddress();
    error Voter__StrategyExists();
    error Voter__StrategyIsDead();
    error Voter__NotStrategy();
    error Voter__BribeSplitExceedsMax();

    event Voter__StrategyAdded(address indexed creator, address indexed strategy, address bribe, address bribeRouter, address paymentToken, address paymentReceiver);
    event Voter__StrategyKilled(address indexed strategy);
    event Voter__Voted(address indexed voter, address indexed strategy, uint256 weight);
    event Voter__Abstained(address indexed account, address indexed strategy, uint256 weight);
    event Voter__NotifyRevenue(address indexed sender, uint256 amount);
    event Voter__DistributeRevenue(address indexed sender, address indexed strategy, uint256 amount);
    event Voter__BribeRewardAdded(address indexed bribe, address indexed reward);
    event Voter__RevenueSourceSet(address indexed revenueSource);
    event Voter__BribeSplitSet(uint256 bribeSplit);

    modifier onlyNewEpoch(address account) {
        if ((block.timestamp / DURATION) * DURATION <= account_LastVoted[account]) revert Voter__AlreadyVotedThisEpoch();
        _;
    }

    modifier nonZeroAddress(address _account) {
        if (_account == address(0)) revert Voter__InvalidZeroAddress();
        _;
    }

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

    function reset() external onlyNewEpoch(msg.sender) {
        account_LastVoted[msg.sender] = block.timestamp;
        _reset(msg.sender);
    }

    function vote(address[] calldata _strategies, uint256[] calldata _weights) external onlyNewEpoch(msg.sender) {
        if (_strategies.length != _weights.length) revert Voter__StrategyLengthNotEqualToWeightLength();
        account_LastVoted[msg.sender] = block.timestamp;
        _vote(msg.sender, _strategies, _weights);
    }

    function claimBribes(address[] memory _bribes) external {
        for (uint256 i = 0; i < _bribes.length; i++) IBribe(_bribes[i]).getReward(msg.sender);
    }

    function notifyAndDistribute(uint256 amount) external {
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

    function distribute(address _strategy) public nonReentrant {
        _updateFor(_strategy);
        uint256 _claimable = strategy_Claimable[_strategy];
        if (_claimable > 0) {
            strategy_Claimable[_strategy] = 0;
            IERC20(revenueToken).safeTransfer(_strategy, _claimable);
            emit Voter__DistributeRevenue(msg.sender, _strategy, _claimable);
        }
    }

    function distribute(uint256 start, uint256 finish) public {
        for (uint256 x = start; x < finish; x++) distribute(strategies[x]);
    }

    function distro() external { distribute(0, strategies.length); }

    function updateFor(address[] memory _strategies) external {
        for (uint256 i = 0; i < _strategies.length; i++) _updateFor(_strategies[i]);
    }

    function updateForRange(uint256 start, uint256 end) public {
        for (uint256 i = start; i < end; i++) _updateFor(strategies[i]);
    }

    function updateAll() external { updateForRange(0, strategies.length); }

    function updateStrategy(address _strategy) external { _updateFor(_strategy); }

    function setRevenueSource(address _revenueSource) external onlyOwner nonZeroAddress(_revenueSource) {
        revenueSource = _revenueSource;
        emit Voter__RevenueSourceSet(_revenueSource);
    }

    function setBribeSplit(uint256 _bribeSplit) external onlyOwner {
        if (_bribeSplit > MAX_BRIBE_SPLIT) revert Voter__BribeSplitExceedsMax();
        bribeSplit = _bribeSplit;
        emit Voter__BribeSplitSet(_bribeSplit);
    }

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
            address(this), revenueToken, _paymentToken, _paymentReceiver,
            _initPrice, _epochPeriod, _priceMultiplier, _minInitPrice
        );

        if (strategy_IsValid[strategy]) revert Voter__StrategyExists();

        strategies.push(strategy);
        strategy_IsValid[strategy] = true;
        strategy_IsAlive[strategy] = true;
        strategy_Bribe[strategy] = bribe;
        strategy_BribeRouter[strategy] = bribeRouter;
        strategy_PaymentToken[strategy] = _paymentToken;
        strategy_SupplyIndex[strategy] = index;

        emit Voter__StrategyAdded(msg.sender, strategy, bribe, bribeRouter, _paymentToken, _paymentReceiver);
    }

    function killStrategy(address _strategy) external onlyOwner {
        if (!strategy_IsAlive[_strategy]) revert Voter__StrategyIsDead();

        // Update to capture any pending claimable
        _updateFor(_strategy);

        // Send any pending claimable to treasury (not the dead strategy)
        uint256 _claimable = strategy_Claimable[_strategy];
        if (_claimable > 0) {
            strategy_Claimable[_strategy] = 0;
            IERC20(revenueToken).safeTransfer(treasury, _claimable);
        }

        // NOTE: We do NOT zero out strategy_Weight or reduce totalWeight here.
        // Users still have account_Strategy_Votes pointing to this strategy,
        // and _reset() needs to subtract those votes from strategy_Weight.
        // If we zero it here, _reset() will underflow and users get stuck forever.
        //
        // The weight will be properly removed when users call reset() or vote()
        // in the next epoch, which calls _reset() and subtracts their votes.
        //
        // Dead strategies won't accumulate new claimable because _updateFor()
        // checks strategy_IsAlive before adding to strategy_Claimable.

        strategy_IsAlive[_strategy] = false;
        emit Voter__StrategyKilled(_strategy);
    }

    function addBribeReward(address _bribe, address _rewardToken) external onlyOwner nonZeroAddress(_rewardToken) {
        IBribe(_bribe).addReward(_rewardToken);
        emit Voter__BribeRewardAdded(_bribe, _rewardToken);
    }

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
                IBribe(strategy_Bribe[_strategy])._withdraw(IBribe(strategy_Bribe[_strategy]).balanceOf(account), account);
                _totalWeight += _votes;
                emit Voter__Abstained(account, _strategy, _votes);
            }
        }

        totalWeight -= _totalWeight;
        account_UsedWeights[account] = 0;
        delete account_StrategyVote[account];
    }

    function _vote(address account, address[] memory _strategyVote, uint256[] memory _weights) internal {
        _reset(account);

        uint256 _strategyCnt = _strategyVote.length;
        uint256 _weight = IGovernanceToken(governanceToken).balanceOf(account);
        uint256 _totalVoteWeight = 0;
        uint256 _usedWeight = 0;

        for (uint256 i = 0; i < _strategyCnt; i++) {
            address _strategy = _strategyVote[i];
            if (strategy_IsValid[_strategy] && strategy_IsAlive[_strategy]) _totalVoteWeight += _weights[i];
        }

        for (uint256 i = 0; i < _strategyCnt; i++) {
            address _strategy = _strategyVote[i];

            if (strategy_IsValid[_strategy] && strategy_IsAlive[_strategy]) {
                uint256 _strategyWeight = _weights[i] * _weight / _totalVoteWeight;
                require(account_Strategy_Votes[account][_strategy] == 0, "Already voted for strategy");
                require(_strategyWeight != 0, "Zero weight");

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

    function getStrategies() external view returns (address[] memory) { return strategies; }
    function length() external view returns (uint256) { return strategies.length; }
    function getStrategyVote(address account) external view returns (address[] memory) { return account_StrategyVote[account]; }
}
