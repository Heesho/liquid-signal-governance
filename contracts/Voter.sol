// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IGovernanceToken.sol";
import "./interfaces/IBribe.sol";
import "./interfaces/IBribeFactory.sol";
import "./interfaces/IAuctionFactory.sol";

/**
 * @title Voter
 * @author heesho
 *
 * @notice Core contract for Liquid Signal Governance (LSG) that:
 *   - Tracks governance votes across strategies (auction + bribe bundles)
 *   - Maintains a global revenue index for proportional distribution
 *   - Splits revenue tokens across strategies based on vote weights
 *   - Manages per-strategy Bribe references and BribeRouters
 *
 * @dev Two-layer governance model:
 *      - Direct democracy (via Governor owner) decides WHICH strategies exist
 *      - Liquid signalling (token holders voting) decides HOW MUCH revenue each receives
 *
 * Revenue Distribution Flow:
 * 1. Protocol revenue flows to RevenueRouter
 * 2. RevenueRouter.flush() transfers to Voter and calls notifyAndDistribute()
 * 3. notifyAndDistribute() updates global index proportionally
 * 4. Anyone calls distribute(strategy) to send accumulated revenue to auctions
 * 5. Auctions sell revenue tokens, proceeds split between receiver and bribes
 *
 * Voting Flow:
 * 1. Users stake tokens in GovernanceToken to get voting power
 * 2. Users call vote([strategies], [weights]) to allocate votes
 * 3. Votes are normalized to user's governance token balance
 * 4. Virtual balances deposited to each strategy's Bribe contract
 * 5. Users earn bribe rewards proportional to their votes
 */
contract Voter is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    /*----------  CONSTANTS  --------------------------------------------*/

    /// @notice Voting epoch duration - users can only vote once per epoch
    uint256 internal constant DURATION = 7 days;

    /// @notice Maximum percentage of auction payments that can go to bribes (50%)
    uint256 public constant MAX_BRIBE_SPLIT = 5000;

    /// @notice Basis points divisor for percentage calculations
    uint256 public constant DIVISOR = 10000;

    /*----------  STATE VARIABLES  --------------------------------------*/

    /// @notice The governance token used for voting power (non-transferable staked token)
    address public immutable governanceToken;

    /// @notice The token distributed as revenue (e.g., WETH, USDC)
    address public immutable revenueToken;

    /// @notice Fallback recipient when no votes exist
    address public immutable treasury;

    /// @notice Factory contract for creating new Bribe contracts
    address public immutable bribeFactory;

    /// @notice Factory contract for creating new Auction + BribeRouter pairs
    address public immutable auctionFactory;

    /// @notice The authorized source of revenue (typically RevenueRouter)
    /// @dev Only this address can call notifyAndDistribute()
    address public revenueSource;

    /// @notice Percentage of auction payments that go to bribes (in basis points)
    /// @dev e.g., 2000 = 20% to bribes, 80% to payment receiver
    uint256 public bribeSplit;

    /// @notice Sum of all vote weights across all strategies
    uint256 public totalWeight;

    /// @notice Array of all strategy addresses (auctions)
    address[] public strategies;

    /// @notice strategy => Bribe contract address
    mapping(address => address) public bribes;

    /// @notice strategy => BribeRouter contract address
    mapping(address => address) public bribeRouterOf;

    /// @notice strategy => payment token for that strategy's auction
    mapping(address => address) public paymentTokenOf;

    /// @notice strategy => total vote weight for that strategy
    mapping(address => uint256) public weights;

    /// @notice account => strategy => vote amount
    mapping(address => mapping(address => uint256)) public votes;

    /// @notice account => array of strategies they voted for
    mapping(address => address[]) public strategyVote;

    /// @notice account => total voting weight used by account
    /// @dev Must be 0 before user can unstake from GovernanceToken
    mapping(address => uint256) public usedWeights;

    /// @notice account => timestamp of last vote
    mapping(address => uint256) public lastVoted;

    /// @notice strategy => whether it's a valid strategy
    mapping(address => bool) public isStrategy;

    /// @notice strategy => whether it can receive revenue (not killed)
    mapping(address => bool) public isAlive;

    /// @notice Global revenue index - increases when revenue is notified
    /// @dev Used for proportional distribution calculation
    uint256 internal index;

    /// @notice strategy => index value when strategy last claimed
    /// @dev Delta between index and supplyIndex determines pending revenue
    mapping(address => uint256) internal supplyIndex;

    /// @notice strategy => pending revenue to be distributed
    mapping(address => uint256) public claimable;

    /*----------  ERRORS ------------------------------------------------*/

    error Voter__AlreadyVotedThisEpoch();
    error Voter__NotAuthorizedGovernance();
    error Voter__StrategyLengthNotEqualToWeightLength();
    error Voter__NotAuthorizedRevenueSource();
    error Voter__InvalidZeroAddress();
    error Voter__StrategyExists();
    error Voter__StrategyIsDead();
    error Voter__NotStrategy();
    error Voter__BribeSplitExceedsMax();

    /*----------  EVENTS ------------------------------------------------*/

    event Voter__StrategyAdded(
        address indexed creator,
        address indexed strategy,
        address bribe,
        address bribeRouter,
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

    /*----------  MODIFIERS  --------------------------------------------*/

    /**
     * @notice Ensures account hasn't voted in the current epoch
     * @dev Epoch boundaries are at DURATION intervals from Unix epoch
     *      e.g., if DURATION = 7 days, epochs start every Thursday 00:00 UTC
     */
    modifier onlyNewEpoch(address account) {
        // Calculate current epoch start: floor(timestamp / DURATION) * DURATION
        if ((block.timestamp / DURATION) * DURATION <= lastVoted[account]) {
            revert Voter__AlreadyVotedThisEpoch();
        }
        _;
    }

    modifier nonZeroAddress(address _account) {
        if (_account == address(0)) revert Voter__InvalidZeroAddress();
        _;
    }

    /*----------  CONSTRUCTOR  ------------------------------------------*/

    /**
     * @notice Initialize the Voter contract
     * @param _governanceToken GovernanceToken address (voting power source)
     * @param _revenueToken Token distributed as revenue (e.g., WETH)
     * @param _treasury Fallback recipient when no votes exist
     * @param _bribeFactory Factory for creating Bribe contracts
     * @param _auctionFactory Factory for creating Auction + BribeRouter pairs
     */
    constructor(
        address _governanceToken,
        address _revenueToken,
        address _treasury,
        address _bribeFactory,
        address _auctionFactory
    ) {
        governanceToken = _governanceToken;
        revenueToken = _revenueToken;
        treasury = _treasury;
        bribeFactory = _bribeFactory;
        auctionFactory = _auctionFactory;
    }

    /*----------  VOTING FUNCTIONS  -------------------------------------*/

    /**
     * @notice Clear all votes for the caller
     * @dev Must be called before unstaking from GovernanceToken
     *      Can only be called once per epoch (to prevent vote manipulation)
     *
     * Flow:
     * 1. Records current timestamp as lastVoted
     * 2. Removes votes from all strategies user voted for
     * 3. Withdraws virtual balance from all Bribe contracts
     * 4. Sets usedWeights to 0 (allows unstaking)
     */
    function reset() external onlyNewEpoch(msg.sender) {
        address account = msg.sender;
        lastVoted[account] = block.timestamp;
        _reset(account);
    }

    /**
     * @notice Vote for strategies with specified weight distribution
     * @param _strategies Array of strategy addresses to vote for
     * @param _weights Array of relative weights (will be normalized)
     *
     * @dev Weights are relative, not absolute. Example:
     *      - vote([A, B], [1, 1]) = 50% each
     *      - vote([A, B], [3, 1]) = 75% A, 25% B
     *      - Actual vote amounts = (weight[i] / sum(weights)) * governanceTokenBalance
     *
     * Flow:
     * 1. First resets any existing votes
     * 2. Gets user's governance token balance as total voting power
     * 3. Normalizes weights to sum to user's balance
     * 4. Deposits virtual balance to each strategy's Bribe contract
     * 5. Updates strategy weights and user's usedWeights
     */
    function vote(address[] calldata _strategies, uint256[] calldata _weights)
        external
        onlyNewEpoch(msg.sender)
    {
        if (_strategies.length != _weights.length) {
            revert Voter__StrategyLengthNotEqualToWeightLength();
        }
        lastVoted[msg.sender] = block.timestamp;
        _vote(msg.sender, _strategies, _weights);
    }

    /**
     * @notice Claim bribe rewards from multiple Bribe contracts
     * @param _bribes Array of Bribe contract addresses to claim from
     * @dev Convenience function to batch claim rewards
     */
    function claimBribes(address[] memory _bribes) external {
        for (uint256 i = 0; i < _bribes.length; i++) {
            IBribe(_bribes[i]).getReward(msg.sender);
        }
    }

    /*----------  REVENUE DISTRIBUTION  ---------------------------------*/

    /**
     * @notice Notify Voter of new revenue and update distribution index
     * @param amount Amount of REVENUE_TOKEN received
     * @dev Only callable by revenueSource (typically RevenueRouter)
     *
     * Revenue Distribution Math:
     * - index += (amount * 1e18) / totalWeight
     * - Each strategy's share = (strategyWeight * indexDelta) / 1e18
     * - This allows O(1) updates regardless of strategy count
     *
     * If no votes exist (totalWeight == 0), revenue goes to TREASURY
     */
    function notifyAndDistribute(uint256 amount) external {
        if (msg.sender != revenueSource) revert Voter__NotAuthorizedRevenueSource();

        // If no votes, send to treasury as fallback
        if (totalWeight == 0) {
            IERC20(revenueToken).safeTransfer(treasury, amount);
            return;
        }

        // Calculate revenue per unit of vote weight (scaled by 1e18)
        uint256 _ratio = amount * 1e18 / totalWeight;
        if (_ratio > 0) {
            index += _ratio;
        }

        emit Voter__NotifyRevenue(msg.sender, amount);
    }

    /**
     * @notice Send accumulated revenue to a specific strategy (auction)
     * @param _strategy The strategy address to distribute to
     * @dev Anyone can call this - it's permissionless
     *
     * Flow:
     * 1. Updates strategy's claimable amount based on index delta
     * 2. Transfers claimable REVENUE_TOKEN to the strategy (auction)
     * 3. Auction can then sell the tokens via Dutch auction
     */
    function distribute(address _strategy) public nonReentrant {
        // Update claimable based on current index
        _updateFor(_strategy);

        uint256 _claimable = claimable[_strategy];
        if (_claimable > 0) {
            claimable[_strategy] = 0;
            // Send revenue to the auction contract
            IERC20(revenueToken).safeTransfer(_strategy, _claimable);
            emit Voter__DistributeRevenue(msg.sender, _strategy, _claimable);
        }
    }

    /**
     * @notice Distribute revenue to a range of strategies
     * @param start Start index in strategies array
     * @param finish End index (exclusive) in strategies array
     */
    function distribute(uint256 start, uint256 finish) public {
        for (uint256 x = start; x < finish; x++) {
            distribute(strategies[x]);
        }
    }

    /**
     * @notice Distribute revenue to all strategies
     * @dev Convenience function - may run out of gas with many strategies
     */
    function distro() external {
        distribute(0, strategies.length);
    }

    /**
     * @notice Update claimable amounts for specific strategies
     * @param _strategies Array of strategy addresses to update
     */
    function updateFor(address[] memory _strategies) external {
        for (uint256 i = 0; i < _strategies.length; i++) {
            _updateFor(_strategies[i]);
        }
    }

    /**
     * @notice Update claimable amounts for a range of strategies
     * @param start Start index in strategies array
     * @param end End index (exclusive) in strategies array
     */
    function updateForRange(uint256 start, uint256 end) public {
        for (uint256 i = start; i < end; i++) {
            _updateFor(strategies[i]);
        }
    }

    /**
     * @notice Update claimable amounts for all strategies
     */
    function updateAll() external {
        updateForRange(0, strategies.length);
    }

    /**
     * @notice Update claimable amount for a single strategy
     * @param _strategy The strategy address to update
     */
    function updateStrategy(address _strategy) external {
        _updateFor(_strategy);
    }

    /*----------  ADMIN FUNCTIONS (GOVERNANCE CONTROLLED)  --------------*/

    /**
     * @notice Set the authorized revenue source
     * @param _revenueSource Address authorized to call notifyAndDistribute()
     * @dev Typically set to RevenueRouter address
     */
    function setRevenueSource(address _revenueSource)
        external
        onlyOwner
        nonZeroAddress(_revenueSource)
    {
        revenueSource = _revenueSource;
        emit Voter__RevenueSourceSet(_revenueSource);
    }

    /**
     * @notice Set the global bribe split percentage
     * @param _bribeSplit Percentage in basis points (e.g., 2000 = 20%)
     * @dev This is read by Auction contracts when processing payments
     *      Higher bribeSplit = more incentives for voters
     *      Lower bribeSplit = more revenue to payment receiver
     */
    function setBribeSplit(uint256 _bribeSplit) external onlyOwner {
        if (_bribeSplit > MAX_BRIBE_SPLIT) revert Voter__BribeSplitExceedsMax();
        bribeSplit = _bribeSplit;
        emit Voter__BribeSplitSet(_bribeSplit);
    }

    /**
     * @notice Create a new strategy (Auction + Bribe + BribeRouter bundle)
     * @param _paymentToken Token used to buy revenue tokens in auction
     * @param _paymentReceiver Where auction payments go (treasury, burn, etc.)
     * @param _initPrice Initial auction price
     * @param _epochPeriod Auction duration before price hits zero
     * @param _priceMultiplier Next epoch price = payment * multiplier
     * @param _minInitPrice Minimum starting price for auctions
     * @return strategy The deployed auction contract address
     *
     * @dev Creates three contracts:
     *      1. Bribe - tracks virtual balances and distributes rewards
     *      2. Auction - Dutch auction selling REVENUE_TOKEN
     *      3. BribeRouter - routes auction payments to Bribe
     */
    function addStrategy(
        address _paymentToken,
        address _paymentReceiver,
        uint256 _initPrice,
        uint256 _epochPeriod,
        uint256 _priceMultiplier,
        uint256 _minInitPrice
    ) external onlyOwner returns (address strategy) {
        // Create Bribe contract for this strategy
        address _bribe = IBribeFactory(bribeFactory).createBribe(address(this));
        // Add payment token as a reward token (from auction sales)
        IBribe(_bribe).addReward(_paymentToken);

        // Create Auction and BribeRouter
        address _bribeRouter;
        (strategy, _bribeRouter) = IAuctionFactory(auctionFactory).createAuction(
            address(this),      // voter
            revenueToken,       // token being auctioned
            _paymentToken,      // token buyers pay with
            _paymentReceiver,   // where payments go
            _initPrice,
            _epochPeriod,
            _priceMultiplier,
            _minInitPrice
        );

        if (isStrategy[strategy]) revert Voter__StrategyExists();

        // Register strategy
        strategies.push(strategy);
        isStrategy[strategy] = true;
        isAlive[strategy] = true;
        bribes[strategy] = _bribe;
        bribeRouterOf[strategy] = _bribeRouter;
        paymentTokenOf[strategy] = _paymentToken;
        supplyIndex[strategy] = index; // Start from current index

        emit Voter__StrategyAdded(
            msg.sender,
            strategy,
            _bribe,
            _bribeRouter,
            _paymentToken,
            _paymentReceiver
        );
    }

    /**
     * @notice Add an existing contract as a strategy
     * @param _strategy Existing auction/contract address
     * @param _paymentToken Token used for payments
     * @param _bribeRouter Existing BribeRouter address (or address(0))
     *
     * @dev Useful for:
     *      - Adding non-auction contracts (e.g., ERC20 that auto-routes payments)
     *      - Migrating from other systems
     *      - Custom auction implementations
     */
    function addExistingStrategy(
        address _strategy,
        address _paymentToken,
        address _bribeRouter
    ) external onlyOwner nonZeroAddress(_strategy) {
        if (isStrategy[_strategy]) revert Voter__StrategyExists();

        // Create new Bribe for this strategy
        address _bribe = IBribeFactory(bribeFactory).createBribe(address(this));
        IBribe(_bribe).addReward(_paymentToken);

        // Register strategy
        strategies.push(_strategy);
        isStrategy[_strategy] = true;
        isAlive[_strategy] = true;
        bribes[_strategy] = _bribe;
        bribeRouterOf[_strategy] = _bribeRouter;
        paymentTokenOf[_strategy] = _paymentToken;
        supplyIndex[_strategy] = index;

        emit Voter__StrategyAdded(
            msg.sender,
            _strategy,
            _bribe,
            _bribeRouter,
            _paymentToken,
            address(0) // No payment receiver for existing strategies
        );
    }

    /**
     * @notice Disable a strategy from receiving revenue
     * @param _strategy The strategy to kill
     * @dev Killed strategies:
     *      - Stop accumulating claimable revenue
     *      - Still allow existing claimable to be distributed
     *      - Still allow votes (but votes don't earn new revenue)
     *      - Cannot be revived
     */
    function killStrategy(address _strategy) external onlyOwner {
        if (!isAlive[_strategy]) revert Voter__StrategyIsDead();
        isAlive[_strategy] = false;
        claimable[_strategy] = 0; // Forfeit pending revenue
        emit Voter__StrategyKilled(_strategy);
    }

    /**
     * @notice Add additional reward token to a Bribe contract
     * @param _bribe The Bribe contract address
     * @param _rewardToken The new reward token to add
     * @dev Allows bribes to distribute multiple token types
     */
    function addBribeReward(address _bribe, address _rewardToken)
        external
        onlyOwner
        nonZeroAddress(_rewardToken)
    {
        IBribe(_bribe).addReward(_rewardToken);
        emit Voter__BribeRewardAdded(_bribe, _rewardToken);
    }

    /*----------  INTERNAL FUNCTIONS  -----------------------------------*/

    /**
     * @notice Internal function to reset all votes for an account
     * @param account The account to reset votes for
     *
     * @dev For each strategy the account voted for:
     *      1. Updates strategy's claimable (captures pending revenue)
     *      2. Removes votes from strategy weight
     *      3. Withdraws virtual balance from Bribe
     *      4. Emits Abstained event
     */
    function _reset(address account) internal {
        address[] storage _strategyVote = strategyVote[account];
        uint256 _strategyVoteCnt = _strategyVote.length;
        uint256 _totalWeight = 0;

        for (uint256 i = 0; i < _strategyVoteCnt; i++) {
            address _strategy = _strategyVote[i];
            uint256 _votes = votes[account][_strategy];

            if (_votes > 0) {
                // Update claimable before changing weights
                _updateFor(_strategy);

                // Remove votes from strategy
                weights[_strategy] -= _votes;
                votes[account][_strategy] = 0;

                // Withdraw virtual balance from Bribe
                IBribe(bribes[_strategy])._withdraw(
                    IBribe(bribes[_strategy]).balanceOf(account),
                    account
                );

                _totalWeight += _votes;
                emit Voter__Abstained(account, _strategy, _votes);
            }
        }

        // Update global weight and clear user's vote tracking
        totalWeight -= _totalWeight;
        usedWeights[account] = 0;
        delete strategyVote[account];
    }

    /**
     * @notice Internal function to cast votes for an account
     * @param account The account casting votes
     * @param _strategyVote Array of strategies to vote for
     * @param _weights Array of relative weights
     *
     * @dev Vote weight calculation:
     *      1. Sum all weights for valid strategies
     *      2. For each strategy: actualVotes = (weight[i] * balance) / totalWeight
     *      3. This normalizes votes to user's governance token balance
     */
    function _vote(
        address account,
        address[] memory _strategyVote,
        uint256[] memory _weights
    ) internal {
        // First reset any existing votes
        _reset(account);

        uint256 _strategyCnt = _strategyVote.length;
        // User's total voting power = their governance token balance
        uint256 _weight = IGovernanceToken(governanceToken).balanceOf(account);
        uint256 _totalVoteWeight = 0;
        uint256 _usedWeight = 0;

        // First pass: sum weights for valid strategies only
        for (uint256 i = 0; i < _strategyCnt; i++) {
            address _strategy = _strategyVote[i];
            if (isStrategy[_strategy] && isAlive[_strategy]) {
                _totalVoteWeight += _weights[i];
            }
        }

        // Second pass: allocate votes proportionally
        for (uint256 i = 0; i < _strategyCnt; i++) {
            address _strategy = _strategyVote[i];

            if (isStrategy[_strategy] && isAlive[_strategy]) {
                // Normalize: (userWeight * governanceBalance) / totalUserWeights
                uint256 _strategyWeight = _weights[i] * _weight / _totalVoteWeight;
                require(votes[account][_strategy] == 0, "Already voted for strategy");
                require(_strategyWeight != 0, "Zero weight");

                // Update claimable before changing weights
                _updateFor(_strategy);

                // Record vote
                strategyVote[account].push(_strategy);
                weights[_strategy] += _strategyWeight;
                votes[account][_strategy] += _strategyWeight;

                // Deposit virtual balance to Bribe (for reward calculation)
                IBribe(bribes[_strategy])._deposit(_strategyWeight, account);
                _usedWeight += _strategyWeight;

                emit Voter__Voted(account, _strategy, _strategyWeight);
            }
        }

        // Update totals
        totalWeight += _usedWeight;
        usedWeights[account] = _usedWeight;
    }

    /**
     * @notice Update claimable revenue for a strategy
     * @param _strategy The strategy to update
     *
     * @dev Revenue calculation:
     *      claimable += (strategyWeight * (index - supplyIndex)) / 1e18
     *
     *      This is a "lazy" update pattern:
     *      - Global index increases when revenue arrives
     *      - Strategy's claimable only calculated when needed
     *      - Allows O(1) revenue notification regardless of strategy count
     */
    function _updateFor(address _strategy) internal {
        uint256 _supplied = weights[_strategy];
        if (_supplied > 0) {
            uint256 _supplyIndex = supplyIndex[_strategy];
            uint256 _index = index;
            supplyIndex[_strategy] = _index;

            // Calculate share of revenue since last update
            uint256 _delta = _index - _supplyIndex;
            if (_delta > 0) {
                uint256 _share = _supplied * _delta / 1e18;
                // Only accrue to alive strategies
                if (isAlive[_strategy]) {
                    claimable[_strategy] += _share;
                }
            }
        } else {
            // No votes = just sync index (no revenue to claim)
            supplyIndex[_strategy] = index;
        }
    }

    /*----------  VIEW FUNCTIONS  ---------------------------------------*/

    /**
     * @notice Get all strategy addresses
     * @return Array of strategy (auction) addresses
     */
    function getStrategies() external view returns (address[] memory) {
        return strategies;
    }

    /**
     * @notice Get the number of strategies
     * @return Number of registered strategies
     */
    function length() external view returns (uint256) {
        return strategies.length;
    }

    /**
     * @notice Get strategies an account voted for
     * @param account The account to query
     * @return Array of strategy addresses the account voted for
     */
    function getStrategyVote(address account) external view returns (address[] memory) {
        return strategyVote[account];
    }
}
