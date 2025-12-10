# Liquid Signal Governance (LSG) Specification

## 0. Goal of LSG

**Problem:** A protocol earns onchain revenue (e.g., WETH fees) and needs a *flexible, credibly neutral* way to decide:

* What to do with that revenue (accumulate assets, burn, fund builders, etc.)
* How to adjust those decisions over time
* Without relying on a multisig or hard-coded splits

**Solution (LSG):**

1. **Direct democracy** decides *which strategies (gauges) exist*.
2. **Liquid signalling** decides *how much revenue each strategy receives* on an ongoing basis.

LSG is designed to be:

* **Generic**: No protocol-specific logic; works for any ERC20-based protocol.
* **Composable**: Strategies are just contracts; LSG doesn't care what they do with revenue.
* **Onchain**: Decisions are visible, adjustable, and enforceable via smart contracts.

---

## 1. Core Components

At the highest level, an LSG integration for a protocol has:

| Component | Description |
|-----------|-------------|
| **Revenue Token** | The token in which protocol revenue arrives (e.g., WETH, USDC) |
| **GovernanceToken** | A staked, non-transferable governance representation with ERC20Votes support |
| **Voter** | Routes revenue to strategies based on governance token votes |
| **Strategy** | Contracts that receive revenue and implement Dutch auction behavior |
| **Bribe** | Per-strategy reward contracts for voters |
| **BribeRouter** | Route auction payments to Bribes |
| **RevenueRouter** | Bridge between protocol revenue sources and Voter |

---

## 2. GovernanceToken

**Purpose:** Represent long-term, non-flashloanable voting power with DAO compatibility.

### Properties

* `token` (immutable): Address of the staked ERC20
* `voter`: Address of the Voter contract (set by owner)
* Non-transferable between accounts (only minting/burning allowed)
* 1:1 exchange rate with underlying token
* Inherits ERC20, ERC20Permit, ERC20Votes for DAO compatibility (Aragon, Tally, Snapshot, OpenZeppelin Governor)

### Key Functions

```solidity
function stake(uint256 amount) external;
function unstake(uint256 amount) external;  // Requires account_UsedWeights == 0
function setVoter(address _voter) external; // Owner only
function underlying() external view returns (address);
```

### Constraints

* Users must **clear votes** (`account_UsedWeights = 0` in Voter) before unstaking
* Transfers between accounts are disabled (reverts with `GovernanceToken__TransferDisabled`)
* Only minting (staking) and burning (unstaking) are allowed
* Zero amounts revert with `GovernanceToken__InvalidZeroAmount`

**Why:** Prevents "vote, transfer, vote again" and flash-loan based governance attacks.

---

## 3. Voter (Liquid Signal Router)

**Purpose:** Core contract that:

* Tracks governance votes across strategies
* Maintains a global revenue index
* Splits revenue token across strategies based on vote weights
* Manages per-strategy Bribe references and BribeRouters
* Controls bribe split percentage for all strategies

### Configuration

```solidity
// Immutables
address public immutable governanceToken;   // GovernanceToken
address public immutable revenueToken;      // e.g., WETH
address public immutable treasury;          // Default receiver when no votes
address public immutable bribeFactory;      // BribeFactory
address public immutable strategyFactory;   // StrategyFactory

// State
address public revenueSource;    // RevenueRouter (authorized to notify revenue)
uint256 public bribeSplit;       // % of strategy payments to bribes (basis points)
uint256 public totalWeight;      // sum of all strategy weights

// Constants
uint256 public constant DURATION = 7 days;       // epoch duration for voting
uint256 public constant MAX_BRIBE_SPLIT = 5000;  // max 50% to bribes
uint256 public constant DIVISOR = 10000;         // basis points divisor
```

### Strategy Model

From the Voter's perspective, a **Strategy** is identified by an address with:

* A **Bribe** contract (`strategy_Bribe[strategy]`) for voter incentives
* A **BribeRouter** (`strategy_BribeRouter[strategy]`) that feeds the Bribe
* A **payment token** (`strategy_PaymentToken[strategy]`)
* A **weight** (`strategy_Weight[strategy]`): total governance weight allocated
* A boolean `strategy_IsValid[strategy]` (whether strategy exists)
* A boolean `strategy_IsAlive[strategy]` (to kill/pause a strategy)

### Voting Data Structures

```solidity
mapping(address => uint256) public strategy_Weight;                    // strategy => total weight
mapping(address => mapping(address => uint256)) public account_Strategy_Votes; // account => strategy => votes
mapping(address => address[]) public account_StrategyVote;             // account => strategies voted on
mapping(address => uint256) public account_UsedWeights;                // account => total votes used
mapping(address => uint256) public account_LastVoted;                  // account => last vote timestamp
```

### Epoch Rules

* `DURATION = 7 days`
* Users can vote or reset at most once per 7-day epoch
* Enforced via `onlyNewEpoch(account)` modifier

### Revenue Distribution Accounting

```solidity
uint256 internal index;                                    // Global revenue index (scaled by 1e18)
mapping(address => uint256) internal strategy_SupplyIndex; // strategy => last index at update
mapping(address => uint256) public strategy_Claimable;     // strategy => claimable revenueToken
```

When new revenue arrives via `notifyRevenue`:
1. If `totalWeight == 0`, send to treasury
2. Calculate `ratio = amount * 1e18 / totalWeight`
3. Increase `index += ratio`
4. For each strategy, `_updateFor(strategy)`:
   * `delta = index - strategy_SupplyIndex[strategy]`
   * `share = strategy_Weight[strategy] * delta / 1e18`
   * `strategy_Claimable[strategy] += share` (if alive)

### Core Functions

**Voting:**
```solidity
function vote(address[] calldata _strategies, uint256[] calldata _weights) external;
function reset() external;
function claimBribes(address[] memory _bribes) external;
```

**Revenue Flow:**
```solidity
function notifyRevenue(uint256 amount) external;       // Only revenueSource
function distribute(address _strategy) public;
function distributeRange(uint256 start, uint256 finish) public;
function distributeAll() external;
```

**Index Updates:**
```solidity
function updateFor(address[] memory _strategies) external;
function updateForRange(uint256 start, uint256 end) public;
function updateAll() external;
function updateStrategy(address _strategy) external;
```

**Admin (Owner Controlled):**
```solidity
function setRevenueSource(address _revenueSource) external;
function setBribeSplit(uint256 _bribeSplit) external;
function addStrategy(
    address _paymentToken,
    address _paymentReceiver,
    uint256 _initPrice,
    uint256 _epochPeriod,
    uint256 _priceMultiplier,
    uint256 _minInitPrice
) external returns (address strategy, address bribe, address bribeRouter);
function killStrategy(address _strategy) external;
function addBribeReward(address _bribe, address _rewardToken) external;
```

**View Functions:**
```solidity
function getStrategies() external view returns (address[] memory);
function length() external view returns (uint256);
function getStrategyVote(address account) external view returns (address[] memory);
function strategy_PendingRevenue(address strategy) external view returns (uint256);
```

---

## 4. Strategy (Dutch Auction)

A **Strategy** receives `revenueToken` from Voter and sells it via Dutch auction. Price decays linearly from `initPrice` to 0 over `epochPeriod`.

### Common Use Cases

| Type | Description |
|------|-------------|
| **Accumulation** | Convert revenueToken to target asset via Dutch auction, send to treasury |
| **Buyback & Burn** | Swap revenueToken → protocol token, burn |
| **Builder Funding** | Swap revenueToken → USDC, send to dev multisig |

### Configuration

```solidity
// Constants
uint256 public constant MIN_EPOCH_PERIOD = 1 hours;
uint256 public constant MAX_EPOCH_PERIOD = 365 days;
uint256 public constant MIN_PRICE_MULTIPLIER = 1.1e18;   // min 1.1x
uint256 public constant MAX_PRICE_MULTIPLIER = 3e18;     // max 3x
uint256 public constant ABS_MIN_INIT_PRICE = 1e6;
uint256 public constant ABS_MAX_INIT_PRICE = type(uint192).max;
uint256 public constant PRICE_MULTIPLIER_SCALE = 1e18;
uint256 public constant DIVISOR = 10000;

// Immutables
address public immutable voter;           // voter contract for bribe split lookup
IERC20 public immutable revenueToken;     // token being auctioned
IERC20 public immutable paymentToken;     // token used to pay
address public immutable paymentReceiver; // receives payment (minus bribe split)
uint256 public immutable epochPeriod;     // duration of price decay
uint256 public immutable priceMultiplier; // multiplier for next epoch's init price
uint256 public immutable minInitPrice;    // floor for init price

// State
uint256 public epochId;      // increments each buy (frontrun protection)
uint256 public initPrice;    // starting price for current epoch
uint256 public startTime;    // epoch start timestamp
```

### Key Behavior

When bought:
1. Price resets to `paymentAmount * priceMultiplier / 1e18`
2. New price bounded by `[minInitPrice, ABS_MAX_INIT_PRICE]`
3. Payment split between `paymentReceiver` and `bribeRouter` based on `Voter.bribeSplit()`

**Buy Function:**
```solidity
function buy(
    address assetsReceiver,
    uint256 _epochId,
    uint256 deadline,
    uint256 maxPaymentAmount
) external returns (uint256 paymentAmount);
```

**View Functions:**
```solidity
function getPrice() public view returns (uint256);
function getRevenueBalance() external view returns (uint256);
function getBribeRouter() external view returns (address);
```

---

## 5. Bribe & BribeRouter

### Bribe

Per-strategy contract distributing rewards to voters proportionally to their voting weight. Uses Synthetix StakingRewards model with virtual balances.

```solidity
// Constants
uint256 public constant DURATION = 7 days;  // reward distribution period

// Immutables
address public immutable voter;  // only voter can modify balances

// State
struct Reward {
    uint256 periodFinish;           // when current reward period ends
    uint256 rewardRate;             // tokens per second
    uint256 lastUpdateTime;         // last time rewards were calculated
    uint256 rewardPerTokenStored;   // accumulated rewards per token
}
mapping(address => Reward) public token_RewardData;
mapping(address => bool) public token_IsReward;
address[] public rewardTokens;

uint256 public totalSupply;                              // total virtual balance
mapping(address => uint256) public account_Balance;      // account => virtual balance
```

**Voter-Only Functions:**
```solidity
function _deposit(uint256 amount, address account) external;
function _withdraw(uint256 amount, address account) external;
function addReward(address _rewardsToken) external;
```

**Public Functions:**
```solidity
function getReward(address account) external;
function notifyRewardAmount(address _rewardsToken, uint256 reward) external;
```

**View Functions:**
```solidity
function left(address _rewardsToken) public view returns (uint256);
function lastTimeRewardApplicable(address _rewardsToken) public view returns (uint256);
function rewardPerToken(address _rewardsToken) public view returns (uint256);
function earned(address account, address _rewardsToken) public view returns (uint256);
function getRewardForDuration(address _rewardsToken) external view returns (uint256);
function getRewardTokens() external view returns (address[] memory);
```

**Invariants:**
* `account_Balance[user]` must equal `account_Strategy_Votes[user][strategy]` in Voter
* `totalSupply` must equal `strategy_Weight[strategy]` in Voter

### BribeRouter

Routes payment tokens from strategy auctions to Bribe contracts.

```solidity
address public immutable voter;        // voter contract to lookup bribe
address public immutable strategy;     // strategy this router serves
address public immutable paymentToken; // token to distribute as bribes

function distribute() external;
function getBribe() external view returns (address);
```

When `balance > Bribe.left(paymentToken)`, pushes funds to Bribe via `notifyRewardAmount`.

---

## 6. RevenueRouter

**Purpose:** Bridge between protocol revenue sources and Voter. Acts as the authorized `revenueSource`.

```solidity
// Immutables
address public immutable voter;        // voter contract to send revenue to
address public immutable revenueToken; // token to distribute

// Functions
function flush() external returns (uint256 amount);         // Reverts if no revenue
function flushIfAvailable() external returns (uint256 amount); // No-op if empty
function pendingRevenue() external view returns (uint256);
```

**Usage:**
1. Set as `treasury` or `feeRecipient` in protocol contracts
2. Revenue accumulates in router
3. Anyone calls `flush()` or `flushIfAvailable()` to push to Voter

---

## 7. Deployment & Integration

### Deployment Order

1. Deploy `BribeFactory()`
2. Deploy `StrategyFactory()`
3. Deploy `GovernanceToken(token, name, symbol)`
4. Deploy `Voter(governanceToken, revenueToken, treasury, bribeFactory, strategyFactory)`
5. Deploy `RevenueRouter(revenueToken, voter)`
6. Configure:
   * `GovernanceToken.setVoter(Voter)`
   * `BribeFactory.setVoter(Voter)`
   * `StrategyFactory.setVoter(Voter)`
   * `Voter.setRevenueSource(RevenueRouter)`
   * `Voter.setBribeSplit(bribeSplitBps)` (e.g., 2000 for 20%)
   * Transfer `Voter` and `GovernanceToken` ownership to Governor contract

### Protocol Integration

```
Protocol Revenue Source
        ↓
   RevenueRouter  ←── flush() called by anyone
        ↓
      Voter  ←── notifyRevenue()
        ↓
   ┌────┴────┐
   ↓         ↓
Strategy1  Strategy2  ... (weighted by votes)
   ↓         ↓
Treasury  BuybackBurn  Builder Fund  etc.
```

---

## 8. Architecture Diagram

```
                    ┌─────────────────────┐
                    │   Protocol Token    │
                    │      (token)        │
                    └─────────┬───────────┘
                              │ stake/unstake
                              ↓
                    ┌─────────────────────┐
                    │  GovernanceToken    │
                    │  (non-transferable) │
                    │   ERC20Votes        │
                    └─────────┬───────────┘
                              │ voting power
                              ↓
┌──────────────┐    ┌─────────────────────┐    ┌──────────────┐
│   Protocol   │    │                     │    │   Governor   │
│   Revenue    │───→│       Voter         │←───│   (Owner)    │
│   Sources    │    │                     │    │              │
└──────────────┘    └─────────┬───────────┘    └──────────────┘
       │                      │
       ↓                      │ distribute()
┌──────────────┐              │
│RevenueRouter │              ↓
│              │    ┌─────────────────────────────────────────┐
│  flush() ────────→│               STRATEGIES                │
└──────────────┘    │  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
                    │  │Strategy1│ │Strategy2│ │Strategy3│   │
                    │  │(Auction)│ │(Auction)│ │(Auction)│   │
                    │  └────┬────┘ └────┬────┘ └────┬────┘   │
                    └───────┼──────────┼──────────┼──────────┘
                            │          │          │
                            ↓          ↓          ↓
                    ┌─────────┐ ┌─────────┐ ┌─────────┐
                    │Treasury │ │  Burn   │ │Dev Fund │
                    │Receiver │ │ Address │ │Multisig │
                    └─────────┘ └─────────┘ └─────────┘
                            │          │
                            ↓          ↓
                    ┌─────────┐ ┌─────────┐
                    │BribeRtr1│ │BribeRtr2│
                    └────┬────┘ └────┬────┘
                         │          │
                         ↓          ↓
                    ┌─────────┐ ┌─────────┐
                    │ Bribe1  │ │ Bribe2  │  ←── Voter rewards
                    └─────────┘ └─────────┘
```

---

## 9. Security Considerations

### Flash Loan Protection
* GovernanceToken is non-transferable
* Users can only vote or reset once per 7-day epoch
* Voting power is tied to staked tokens

### Access Control
* Voter owner should be a Governor contract (not EOA)
* Only `revenueSource` can call `notifyRevenue`
* Only Voter can call Bribe `_deposit`/`_withdraw`/`addReward`
* `bribeSplit` capped at `MAX_BRIBE_SPLIT` (50%)

### Invariants
* `totalWeight` must equal sum of all `strategy_Weight[strategy]`
* Bribe `totalSupply` must equal Voter `strategy_Weight[strategy]`
* Bribe `account_Balance[user]` must equal Voter `account_Strategy_Votes[user][strategy]`

---

## 10. Gas Optimization

* Batch distribution via `distributeRange(start, finish)`
* Batch index updates via `updateForRange(start, end)` and `updateFor(strategies[])`
* View functions for pending revenue calculation without state changes

---

## 11. Events Summary

### Voter
```solidity
event Voter__StrategyAdded(address indexed strategy, address indexed bribe, address indexed bribeRouter, address paymentToken, address paymentReceiver);
event Voter__StrategyKilled(address indexed strategy);
event Voter__Voted(address indexed voter, address indexed strategy, uint256 weight);
event Voter__Abstained(address indexed account, address indexed strategy, uint256 weight);
event Voter__NotifyRevenue(address indexed sender, uint256 amount);
event Voter__DistributeRevenue(address indexed sender, address indexed strategy, uint256 amount);
event Voter__BribeRewardAdded(address indexed bribe, address indexed reward);
event Voter__RevenueSourceSet(address indexed revenueSource);
event Voter__BribeSplitSet(uint256 bribeSplit);
```

### Strategy
```solidity
event Strategy__Buy(address indexed buyer, address indexed assetsReceiver, uint256 revenueAmount, uint256 paymentAmount);
```

### Bribe
```solidity
event Bribe__RewardAdded(address indexed rewardToken);
event Bribe__RewardNotified(address indexed rewardToken, uint256 reward);
event Bribe__Deposited(address indexed user, uint256 amount);
event Bribe__Withdrawn(address indexed user, uint256 amount);
event Bribe__RewardPaid(address indexed user, address indexed rewardsToken, uint256 reward);
```

### BribeRouter
```solidity
event BribeRouter__Distributed(address indexed bribe, address indexed token, uint256 amount);
```

### RevenueRouter
```solidity
event RevenueRouter__Flushed(address indexed caller, uint256 amount);
```

### GovernanceToken
```solidity
event GovernanceToken__Staked(address indexed account, uint256 amount);
event GovernanceToken__Unstaked(address indexed account, uint256 amount);
event GovernanceToken__VoterSet(address indexed voter);
```

---

## 12. DONUT Deployment Configuration

This LSG implementation is deployed for the DONUT token on Base mainnet.

### Token Addresses

| Token | Address | Description |
|-------|---------|-------------|
| DONUT | `0xae4a37d554c6d6f3e398546d8566b25052e0169c` | Underlying governance token |
| WETH | `0x4200000000000000000000000000000000000006` | Revenue token |

### Governance Token (gDONUT)

| Property | Value |
|----------|-------|
| Name | Governance Donut |
| Symbol | gDONUT |
| Underlying | DONUT |
| Exchange Rate | 1:1 |

Users stake DONUT to receive gDONUT, which grants voting power in the LSG system.

### Initial Strategy: DONUT Buyback

The initial strategy implements a DONUT buyback mechanism via Dutch auction:

```
WETH Revenue → Dutch Auction → DONUT Payment → DAO Treasury
                                    ↓
                         bribeSplit % to Bribes
```

**Configuration:**

| Parameter | Value | Description |
|-----------|-------|-------------|
| Payment Token | DONUT | Auction buyers pay in DONUT |
| Payment Receiver | DAO Address | DONUT sent to DAO treasury |
| Initial Price | 1,000,000 DONUT | Starting auction price |
| Min Init Price | 100,000 DONUT | Price floor for init price |
| Epoch Period | 7 days | Auction duration |
| Price Multiplier | 1.1e18 (110%) | Next epoch price increase |
| Bribe Split (Voter) | 2000 bps (20%) | Portion to voter bribes |

### Revenue Flow

```
Protocol Fees (WETH)
        ↓
  RevenueRouter
        ↓ flush()
      Voter
        ↓ distribute()
  Buyback Strategy
        ↓ Dutch Auction
   DONUT Payment
    ↓         ↓
  80%       20%
   ↓         ↓
  DAO    BribeRouter
Treasury      ↓
           Bribe
             ↓
         gDONUT Voters
```

### Ownership

After deployment, ownership of Voter and GovernanceToken contracts is transferred to the DAO address for decentralized governance control.
