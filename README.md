# Liquid Signal Governance (LSG)

A decentralized protocol for managing cryptocurrency revenue allocation through liquid democracy. LSG enables communities to collectively decide how protocol revenue is distributed across different strategies without relying on multisigs or hard-coded fee splits.

## Overview

Liquid Signal Governance solves a fundamental problem: protocols earn revenue but lack a credible, flexible, and decentralized way to decide what to do with it. LSG provides:

- **Direct Democracy**: Token holders vote on strategies to determine revenue allocation
- **Liquid Signaling**: Voting power directly influences proportional revenue distribution
- **Flexible Strategies**: Support for various revenue destinations (accumulation, burns, developer funding, etc.)
- **Voter Incentives**: Bribe system rewards voters for participating in governance

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Protocol      │────▶│  RevenueRouter  │
│   Revenue       │     │   (accumulator) │
└─────────────────┘     └────────┬────────┘
                                 │ flush()
                                 ▼
┌─────────────────┐     ┌─────────────────┐
│ GovernanceToken │────▶│     Voter       │
│  (voting power) │     │  (distribution) │
└─────────────────┘     └────────┬────────┘
                                 │ distribute()
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       ┌───────────┐      ┌───────────┐      ┌───────────┐
       │ Strategy  │      │ Strategy  │      │ Strategy  │
       │ (auction) │      │ (auction) │      │ (auction) │
       └─────┬─────┘      └─────┬─────┘      └─────┬─────┘
             │                  │                  │
             ▼                  ▼                  ▼
       ┌───────────┐      ┌───────────┐      ┌───────────┐
       │   Bribe   │      │   Bribe   │      │   Bribe   │
       │ (rewards) │      │ (rewards) │      │ (rewards) │
       └───────────┘      └───────────┘      └───────────┘
```

## Core Contracts

| Contract | Description |
|----------|-------------|
| `GovernanceToken` | Non-transferable staking token that grants voting power (1:1 with underlying) |
| `Voter` | Central governance router that tracks votes and distributes revenue proportionally |
| `Strategy` | Dutch auction mechanism for selling revenue tokens |
| `Bribe` | Per-strategy reward distribution for voters |
| `RevenueRouter` | Bridge that accumulates and forwards protocol revenue to Voter |
| `StrategyFactory` | Factory for deploying new Strategy contracts |
| `BribeFactory` | Factory for deploying new Bribe contracts |
| `BribeRouter` | Routes auction payments to bribe contracts |

## Installation

```bash
# Clone the repository
git clone https://github.com/your-org/liquid-signal-governance.git
cd liquid-signal-governance

# Install dependencies
npm install
```

## Configuration

Copy the environment template and configure your variables:

```bash
cp .env.example .env
```

Required environment variables:

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Deployer wallet private key |
| `SCAN_API_KEY` | BaseScan API key for contract verification |
| `RPC_URL` | Base chain RPC endpoint |

## Usage

### Running Tests

```bash
# Run all tests
npx hardhat test

# Run specific test file
npx hardhat test tests/Voter.test.js

# Run with coverage report
npx hardhat coverage
```

### Deployment

```bash
# Deploy to Base mainnet
npx hardhat run ./scripts/deploy.js --network mainnet

# Deploy to local hardhat network
npx hardhat run ./scripts/deploy.js
```

## How It Works

### 1. Staking for Voting Power

Users stake the underlying ERC20 token to receive non-transferable GovernanceTokens at a 1:1 ratio. This grants voting power while preventing flash loan attacks on governance.

```solidity
// Stake tokens to gain voting power
governanceToken.stake(amount);

// Unstake (requires clearing all votes first)
governanceToken.unstake(amount);
```

### 2. Voting on Strategies

Token holders allocate their voting power across strategies. Votes determine how revenue is proportionally distributed.

```solidity
// Vote for strategies with specified weights
address[] memory strategies = [strategyA, strategyB];
uint256[] memory weights = [60, 40]; // 60% to A, 40% to B
voter.vote(strategies, weights);

// Reset votes (required before unstaking)
voter.reset();
```

### 3. Revenue Distribution

Protocol revenue flows through the RevenueRouter to the Voter, which distributes it to strategies based on their vote weight.

```solidity
// Anyone can trigger revenue flush
revenueRouter.flush();

// Distribute to all strategies
voter.distro();

// Or distribute to specific strategy
voter.distribute(strategyAddress);
```

### 4. Dutch Auctions

Strategies use descending-price auctions to sell revenue tokens. Price starts high and decays linearly toward zero over the epoch period.

```solidity
// Buy revenue tokens from a strategy
strategy.buy(
    assetsReceiver,   // Where to send purchased tokens
    epochId,          // Current epoch identifier
    deadline,         // Transaction deadline
    maxPaymentAmount  // Maximum payment willing to make
);
```

### 5. Claiming Bribes

Voters earn rewards proportional to their vote weight on each strategy.

```solidity
// Claim rewards from multiple bribes
address[] memory bribes = [bribeA, bribeB];
voter.claimBribes(bribes);
```

## Key Parameters

### Strategy Configuration

| Parameter | Range | Description |
|-----------|-------|-------------|
| `initPrice` | - | Starting auction price (token decimals scaled) |
| `epochPeriod` | 1 hour - 365 days | Duration of each auction |
| `priceMultiplier` | 1.1x - 3x | Price multiplier for next epoch |
| `minInitPrice` | - | Minimum allowed initial price |
| `bribeSplit` | 0 - 50% | Percentage of payment routed to bribes |

### System Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DURATION` | 7 days | Voting epoch length |
| `MAX_BRIBE_SPLIT` | 5000 | Maximum bribe split (50% in basis points) |
| `DIVISOR` | 10000 | Basis points divisor |

## Security Considerations

- **Flash Loan Protection**: GovernanceToken is non-transferable, preventing vote manipulation
- **Epoch Delays**: One epoch delay enforced between voting and resetting
- **Access Control**: Voter owner should be a Governor contract, not an EOA
- **Revenue Source**: Only the designated RevenueRouter can notify revenue

## Project Structure

```
liquid-signal/
├── contracts/
│   ├── Voter.sol              # Core governance router
│   ├── GovernanceToken.sol    # Non-transferable staking token
│   ├── Strategy.sol           # Dutch auction implementation
│   ├── Bribe.sol              # Voter reward distribution
│   ├── RevenueRouter.sol      # Revenue accumulator/forwarder
│   ├── StrategyFactory.sol    # Strategy deployment factory
│   ├── BribeFactory.sol       # Bribe deployment factory
│   ├── BribeRouter.sol        # Auction payment router
│   ├── interfaces/            # Contract interfaces
│   └── mocks/                 # Test mock contracts
├── tests/                     # Comprehensive test suite
├── scripts/                   # Deployment scripts
├── hardhat.config.js          # Hardhat configuration
├── SPEC.md                    # Technical specification
└── package.json
```

## Tech Stack

- **Solidity** 0.8.19
- **Hardhat** - Development framework
- **OpenZeppelin** - Standard contract implementations
- **Solmate** - Gas-optimized utilities
- **Ethers.js** - Ethereum interaction
- **Chai** - Testing assertions

## Network

Currently configured for **Base Chain** (Chain ID: 8453)

## License

See LICENSE file for details.
