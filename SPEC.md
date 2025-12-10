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
| **Governance Token** | A staked, non-transferable governance representation |
| **LSGVoter** | Routes revenue to strategies based on governance token votes |
| **Strategies** | Contracts that receive revenue and implement some behavior |
| **Bribes** | Per-strategy reward contracts for voters |
| **BribeRouters** | Route auction payments to Bribes |
| **RevenueRouter** | Bridge between protocol revenue sources and LSGVoter |

---

## 2. GovernanceToken

**Purpose:** Represent long-term, non-flashloanable voting power.

### Properties

* `UNDERLYING` (immutable): Address of the staked ERC20
* Non-transferable between accounts (only minting/burning allowed)
* 1:1 exchange rate with underlying token

### Key Functions

```solidity
function stake(uint256 amount) external;
function unstake(uint256 amount) external;  // Requires usedWeights == 0
function setVoter(address _voter) external; // One-time setup
```

### Constraints

* Users must **clear votes** (`usedWeights = 0` in Voter) before unstaking
* Transfers between accounts are disabled
* Only minting (staking) and burning (unstaking) are allowed

**Why:** Prevents "vote, transfer, vote again" and flash-loan based governance attacks.

---

## 3. LSGVoter (Liquid Signal Router)

**Purpose:** Core contract that:

* Tracks governance votes across strategies
* Maintains a global revenue index
* Splits revenue token across strategies based on vote weights
* Manages per-strategy Bribe references and BribeRouters

### Configuration

```solidity
address public immutable VTOKEN;          // GovernanceToken
address public immutable REVENUE_TOKEN;   // e.g., WETH
address public immutable TREASURY;        // Default receiver
address public immutable bribefactory;    // LSGBribeFactory
address public immutable strategyFactory; // StrategyFactory
address public revenueSource;             // RevenueRouter
```

### Strategy Model

From the Voter's perspective, a **Strategy** is identified by an address with:

* A **Bribe** contract (`bribes[strategy]`) for voter incentives
* A **BribeRouter** (`bribeRouterOf[strategy]`) that feeds the Bribe
* A **payment token** (`paymentTokenOf[strategy]`)
* A **weight** (`weights[strategy]`): total governance weight allocated
* A boolean `isAlive[strategy]` (to kill/pause a strategy)

### Voting Data Structures

```solidity
mapping(address => uint256) public weights;              // strategy => total weight
mapping(address => mapping(address => uint256)) public votes; // user => strategy => votes
mapping(address => address[]) public strategyVote;       // user => strategies voted on
mapping(address => uint256) public usedWeights;          // user => total weight used
mapping(address => uint256) public lastVoted;            // user => last vote timestamp
```

### Epoch Rules

* `DURATION = 7 days`
* Users can vote or reset at most once per 7-day epoch
* Enforced via `onlyNewEpoch(user)` modifier

### Revenue Distribution Accounting

```solidity
uint256 internal index;                         // Global revenue index (scaled by 1e18)
mapping(address => uint256) internal supplyIndex; // strategy => last index at update
mapping(address => uint256) public claimable;   // strategy => claimable REVENUE_TOKEN
```

When new revenue arrives:
1. Calculate `ratio = amount * 1e18 / totalWeight`
2. Increase `index += ratio`
3. For each strategy, `_updateFor(strategy)`:
   * `delta = index - supplyIndex[strategy]`
   * `share = weights[strategy] * delta / 1e18`
   * `claimable[strategy] += share` (if alive)

### Core Functions

**Voting:**
```solidity
function vote(address[] calldata strategies, uint256[] calldata weights) external;
function reset() external;
function claimBribes(address[] memory bribes) external;
```

**Revenue Flow:**
```solidity
function notifyRevenue(uint256 amount) external; // Only revenueSource
function distribute(address strategy) public;
function distributeAll() external; // Distribute to all
```

**Admin (Governance Controlled):**
```solidity
function setRevenueSource(address source) external;
function addStrategy(...) external returns (address);
function addExistingStrategy(address strategy, address paymentToken, address bribeRouter) external;
function killStrategy(address strategy) external;
function addBribeReward(address bribe, address rewardToken) external;
```

---

## 4. Strategies (Gauges)

A **strategy** is any contract that receives `REVENUE_TOKEN` from Voter and implements some behavior.

### Common Strategy Types

| Type | Description |
|------|-------------|
| **Accumulation** | Convert REVENUE_TOKEN to target asset via Dutch auction, send to treasury |
| **Buyback & Burn** | Swap REVENUE_TOKEN → protocol token, burn |
| **Builder Funding** | Swap REVENUE_TOKEN → USDC, send to dev multisig |
| **Native Hold** | Hold REVENUE_TOKEN as-is in treasury |

### Strategy Contract (Dutch Auction)

The default strategy is a Dutch auction that:
* Receives REVENUE_TOKEN from LSGVoter
* Sells via descending price auction
* Sends payment to configurable receiver
* Routes bribe portion to BribeRouter

```solidity
address public immutable voter;
address public immutable paymentReceiver;  // Where payments go
uint256 public immutable bribeSplit;       // % to bribes (basis points)
uint256 public immutable epochPeriod;
uint256 public immutable priceMultiplier;
```

**Buy Function:**
```solidity
function buy(
    address assetsReceiver,
    uint256 epochId,
    uint256 deadline,
    uint256 maxPaymentAmount
) external returns (uint256 paymentAmount);
```

---

## 5. Bribes & BribeRouters

### LSGBribe

Per-strategy contract distributing rewards to voters proportionally to their voting weight.

```solidity
function _deposit(uint256 amount, address account) external; // Voter only
function _withdraw(uint256 amount, address account) external; // Voter only
function addReward(address rewardToken) external;             // Voter only
function getReward(address account) external;                 // Anyone
function notifyRewardAmount(address token, uint256 amount) external;
```

Invariants:
* `balanceOf(user)` must equal `votes[user][strategy]` in Voter
* `totalSupply()` must equal `weights[strategy]` in Voter

### BribeRouter

Routes payment tokens from strategy auctions to Bribe contracts.

```solidity
function distribute() external; // Anyone can call
```

When balance > `Bribe.left(paymentToken)`, pushes funds to Bribe.

---

## 6. RevenueRouter

**Purpose:** Bridge between protocol revenue sources and LSGVoter.

```solidity
function flush() external returns (uint256 amount);
function flushIfAvailable() external returns (uint256 amount);
function pendingRevenue() external view returns (uint256);
```

Usage:
1. Set as `treasury` or `feeRecipient` in protocol contracts
2. Revenue accumulates in router
3. Anyone calls `flush()` to push to Voter

---

## 7. Deployment & Integration

### Deployment Order

1. Deploy `GovernanceToken(UNDERLYING, name, symbol)`
2. Deploy `LSGBribeFactory()`
3. Deploy `StrategyFactory(REVENUE_TOKEN, PAYMENT_TOKEN)`
4. Deploy `LSGVoter(GovernanceToken, REVENUE_TOKEN, TREASURY, BribeFactory, StrategyFactory)`
5. Deploy `RevenueRouter(REVENUE_TOKEN, Voter)`
6. Configure:
   * `GovernanceToken.setVoter(Voter)`
   * `LSGBribeFactory.setVoter(Voter)`
   * `StrategyFactory.setVoter(Voter)`
   * `Voter.setRevenueSource(RevenueRouter)`
   * Transfer `Voter` ownership to Governor contract

### Protocol Integration

```
Protocol Revenue Source
        ↓
   RevenueRouter  ←── flush() called by anyone
        ↓
     LSGVoter  ←── notifyRevenue()
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
                    │    (UNDERLYING)     │
                    └─────────┬───────────┘
                              │ stake/unstake
                              ↓
                    ┌─────────────────────┐
                    │  GovernanceToken    │
                    │  (non-transferable) │
                    └─────────┬───────────┘
                              │ voting power
                              ↓
┌──────────────┐    ┌─────────────────────┐    ┌──────────────┐
│   Protocol   │    │                     │    │   Governor   │
│   Revenue    │───→│     LSGVoter        │←───│   (Owner)    │
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
                    │  │(Auction)│ │(Auction)│ │(Custom) │   │
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
* Users must wait one epoch between voting and resetting
* Voting power is tied to time-locked stake

### Access Control
* LSGVoter owner should be a Governor contract (not EOA)
* Only RevenueRouter can call `notifyRevenue`
* Only Voter can call Bribe `_deposit`/`_withdraw`

### Invariants
* `totalWeight` must equal sum of all `weights[strategy]`
* Bribe `totalSupply` must equal Voter `weights[strategy]`
* User Bribe `balanceOf` must equal Voter `votes[user][strategy]`

---

## 10. Gas Optimization

* Slot packing in Strategy (Slot0 struct)
* Single storage write for auction state updates
* Batch distribution via `distributeRange(start, finish)`
* View functions use memory caching

---

## 11. Events Summary

### LSGVoter
```solidity
event LSGVoter__StrategyAdded(address creator, address strategy, address bribe, address bribeRouter, address paymentToken, address paymentReceiver);
event LSGVoter__StrategyKilled(address strategy);
event LSGVoter__Voted(address voter, address strategy, uint256 weight);
event LSGVoter__Abstained(address account, address strategy, uint256 weight);
event LSGVoter__NotifyRevenue(address sender, uint256 amount);
event LSGVoter__DistributeRevenue(address sender, address strategy, uint256 amount);
```

### Strategy
```solidity
event Strategy__Buy(address buyer, address assetsReceiver, uint256 revenueAmount, uint256 paymentAmount);
```

### LSGBribe
```solidity
event LSGBribe__RewardAdded(address rewardToken);
event LSGBribe__RewardNotified(address rewardToken, uint256 reward);
event LSGBribe__Deposited(address user, uint256 amount);
event LSGBribe__Withdrawn(address user, uint256 amount);
event LSGBribe__RewardPaid(address user, address rewardsToken, uint256 reward);
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
                              20% to Bribes
```

**Configuration:**

| Parameter | Value | Description |
|-----------|-------|-------------|
| Payment Token | DONUT | Auction buyers pay in DONUT |
| Payment Receiver | DAO Address | DONUT sent to DAO treasury |
| Initial Price | 1,000,000 DONUT | Starting auction price |
| Minimum Price | 100,000 DONUT | Price floor |
| Epoch Period | 7 days | Auction duration |
| Price Multiplier | 110% (11000 bps) | Next epoch price increase |
| Bribe Split | 20% (2000 bps) | Portion to voter bribes |

### Revenue Flow

```
Protocol Fees (WETH)
        ↓
  RevenueRouter
        ↓ flush()
     LSGVoter
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
