# Governance Proposal Guide: Strategy Management

This guide helps non-technical DAO members create consistent proposals for adding or removing strategies in the Liquid Signal Governance (LSG) system.

---

## Quick Reference

| Action | What It Does |
|--------|--------------|
| **Add Strategy** | Creates a new revenue allocation option for voters |
| **Kill Strategy** | Deactivates a strategy, stops revenue flow to it |

---

## Proposal Type 1: Add Strategy

### What This Does

Adding a strategy creates a new option where DAO revenue can be directed. Each strategy:
- Sells revenue tokens through a Dutch auction mechanism
- Accepts a specific payment token from buyers
- Sends payments to a designated receiver (usually DAO treasury)
- Rewards voters with bribes for directing revenue there

### Required Parameters

| Parameter | What It Means | How to Decide |
|-----------|---------------|---------------|
| **Payment Token** | The token buyers will pay with | Choose a token you want the DAO to accumulate (e.g., USDC, DONUT, ETH) |
| **Payment Receiver** | Address that receives auction payments | Usually the DAO treasury address |
| **Initial Price** | Starting price for the Dutch auction | Set based on expected demand - higher = more revenue per sale if demand exists |
| **Epoch Period** | How long until price decays to zero | Shorter = faster sales, longer = more time for buyers to decide |
| **Price Multiplier** | How much price increases after a purchase | Higher = more aggressive price recovery, lower = more stable pricing |
| **Minimum Price** | Floor price that auction won't go below | Set to prevent selling too cheaply |

### Parameter Constraints

| Parameter | Minimum | Maximum | Format |
|-----------|---------|---------|--------|
| Epoch Period | 1 hour | 365 days | Seconds |
| Price Multiplier | 110% (1.1x) | 300% (3x) | Scaled by 1e18 |
| Minimum Price | 1e6 (in token decimals) | - | Token decimals |
| Initial Price | Must be ≥ Minimum Price | - | Token decimals |

### Decision Guide: Choosing Parameters

#### Payment Token
- **USDC/Stablecoins**: Good for treasury diversification, predictable value
- **Native Token (e.g., DONUT)**: Good for buybacks, reduces circulating supply
- **ETH/WETH**: Good for accumulating blue-chip assets

#### Initial Price
- **Too High**: Auctions may not sell, revenue sits idle
- **Too Low**: You sell revenue tokens too cheaply
- **Recommendation**: Start with a price you'd be happy to sell at, let the market adjust

#### Epoch Period
- **1 day (86400 seconds)**: Standard choice, gives buyers time to react
- **1 hour (3600 seconds)**: Fast-moving markets, high activity
- **1 week (604800 seconds)**: Low activity strategies, patient selling

#### Price Multiplier
- **1.2x (120%)**: Conservative, gradual price increases after buys
- **1.5x (150%)**: Moderate recovery speed
- **2x (200%)**: Aggressive, prices jump significantly after each buy

#### Minimum Price
- Set this to the absolute lowest price you're willing to sell at
- Should account for token decimals (USDC = 6 decimals, most tokens = 18 decimals)

### Proposal Template: Add Strategy

```
TITLE: Add [Strategy Name] Strategy

SUMMARY:
This proposal adds a new strategy to allocate protocol revenue toward [goal].

SPECIFICATION:

Contract: Voter
Function: addStrategy

Parameters:
- Payment Token: [Token Name] ([Token Address])
- Payment Receiver: [Receiver Name] ([Receiver Address])
- Initial Price: [Amount] [Token Symbol]
- Epoch Period: [Duration in human readable] ([Seconds])
- Price Multiplier: [Percentage]% ([Value]e18)
- Minimum Price: [Amount] [Token Symbol]

RATIONALE:
[Explain why this strategy benefits the DAO]

EXPECTED OUTCOME:
- Revenue can be directed to this strategy via voter allocation
- Buyers can purchase revenue tokens by paying [Token]
- [Percentage]% of payments go to voter bribes
- [Percentage]% of payments go to [Receiver]
```

### Example Proposal: USDC Accumulation Strategy

```
TITLE: Add USDC Accumulation Strategy

SUMMARY:
This proposal adds a strategy to sell protocol revenue for USDC,
diversifying the treasury into stable assets.

SPECIFICATION:

Contract: Voter
Function: addStrategy

Parameters:
- Payment Token: USDC (0x833589fcd6edb6e08f4c7c32d4f71b54bda02913)
- Payment Receiver: DAO Treasury (0x69399790f5ef59d5074b7137C5De795837396444)
- Initial Price: 100 USDC (100000000 - 6 decimals)
- Epoch Period: 1 day (86400 seconds)
- Price Multiplier: 120% (1200000000000000000)
- Minimum Price: 100 USDC (100000000)

RATIONALE:
The DAO currently holds 95% of treasury in volatile assets.
This strategy allows voters to direct revenue toward USDC accumulation,
improving treasury stability and enabling operational expenses to be
paid without selling governance tokens.

EXPECTED OUTCOME:
- Revenue tokens sold for USDC via Dutch auction
- 20% of USDC payments go to voter bribes
- 80% of USDC payments go to DAO treasury
```

### Example Proposal: Token Buyback Strategy

```
TITLE: Add DONUT Buyback Strategy

SUMMARY:
This proposal adds a strategy to buy back DONUT tokens using
protocol revenue, reducing circulating supply.

SPECIFICATION:

Contract: Voter
Function: addStrategy

Parameters:
- Payment Token: DONUT (0xae4a37d554c6d6f3e398546d8566b25052e0169c)
- Payment Receiver: DAO Treasury (0x69399790f5ef59d5074b7137C5De795837396444)
- Initial Price: 5000 DONUT (5000000000000000000000 - 18 decimals)
- Epoch Period: 1 day (86400 seconds)
- Price Multiplier: 120% (1200000000000000000)
- Minimum Price: 5000 DONUT (5000000000000000000000)

RATIONALE:
Token buybacks reduce circulating supply and demonstrate confidence
in the protocol. This strategy allows the community to signal demand
for buybacks through voting weight allocation.

EXPECTED OUTCOME:
- Revenue tokens sold for DONUT via Dutch auction
- Acquired DONUT sent to treasury (can be burned via separate proposal)
- 20% of DONUT payments go to voter bribes
```

---

## Proposal Type 2: Kill Strategy

### What This Does

Killing a strategy:
- Stops all new revenue from being allocated to that strategy
- Sends any pending/accumulated revenue to the treasury
- Keeps the strategy address active (existing balances can still be bought)
- Does NOT automatically reset voter allocations

### Required Parameters

| Parameter | What It Means |
|-----------|---------------|
| **Strategy Address** | The address of the strategy to deactivate |

### Important Considerations

1. **Voter Impact**: Voters who allocated weight to this strategy will need to manually reset their votes in the next epoch to reclaim their voting power.

2. **Pending Revenue**: Any revenue waiting to be distributed to this strategy will be sent to the treasury instead.

3. **Existing Balances**: Buyers can still purchase any remaining tokens in the killed strategy - it just won't receive new revenue.

4. **Cannot Be Undone**: Once killed, a strategy cannot be revived. A new strategy would need to be created.

### When to Kill a Strategy

- Strategy is no longer aligned with DAO goals
- Payment token is deprecated or has issues
- Payment receiver address is compromised
- Strategy has very low utilization
- Consolidating to fewer strategies

### Proposal Template: Kill Strategy

```
TITLE: Kill [Strategy Name] Strategy

SUMMARY:
This proposal deactivates the [Strategy Name] strategy, stopping
all future revenue allocations to it.

SPECIFICATION:

Contract: Voter
Function: killStrategy

Parameters:
- Strategy: [Strategy Address]

RATIONALE:
[Explain why this strategy should be deactivated]

IMPACT:
- Pending revenue will be sent to treasury
- Voters must reset their allocations to reclaim voting power
- Existing strategy balance can still be purchased until depleted

VOTER ACTION REQUIRED:
Voters who allocated weight to this strategy should call reset()
in the next epoch to reallocate their voting power.
```

### Example Proposal: Kill Strategy

```
TITLE: Kill Deprecated Token Buyback Strategy

SUMMARY:
This proposal deactivates the XYZ Token Buyback strategy due to
the deprecation of XYZ token.

SPECIFICATION:

Contract: Voter
Function: killStrategy

Parameters:
- Strategy: 0x1234567890abcdef1234567890abcdef12345678

RATIONALE:
The XYZ token has been deprecated following the protocol merger.
Continuing to accumulate XYZ provides no value to the DAO.
This strategy currently has 15% of vote weight allocated, which
represents wasted revenue allocation.

IMPACT:
- Approximately 50,000 revenue tokens pending will go to treasury
- 42 voters need to reset their allocations
- Remaining 1,200 XYZ in strategy can still be sold

VOTER ACTION REQUIRED:
Voters who allocated weight to this strategy should call reset()
starting next Monday to reallocate their voting power.
```

---

## Executing Proposals via Aragon

### For Add Strategy

1. **Create New Vote** in Aragon
2. **Add Action**: External Contract Call
3. **Contract Address**: Voter contract address
4. **Function**: `addStrategy`
5. **Parameters**: Enter each value as specified in your proposal
6. **Review**: Double-check all addresses and decimal formatting

### For Kill Strategy

1. **Create New Vote** in Aragon
2. **Add Action**: External Contract Call
3. **Contract Address**: Voter contract address
4. **Function**: `killStrategy`
5. **Parameters**: Enter the strategy address
6. **Review**: Confirm correct strategy address

### Parameter Formatting Tips

| Type | Example Input | Notes |
|------|---------------|-------|
| Address | 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 | Full address with 0x prefix |
| USDC Amount | 100000000 | 100 USDC = 100 * 10^6 |
| Token Amount (18 decimals) | 5000000000000000000000 | 5000 tokens = 5000 * 10^18 |
| Epoch (1 day) | 86400 | Seconds |
| Multiplier (120%) | 1200000000000000000 | 1.2 * 10^18 |

---

## Checklist Before Submitting

### Add Strategy Checklist

- [ ] Payment token address verified on block explorer
- [ ] Payment receiver address verified (usually DAO treasury)
- [ ] Initial price calculated with correct decimals
- [ ] Epoch period makes sense for expected activity level
- [ ] Price multiplier within 110%-300% range
- [ ] Minimum price set as true floor you'd accept
- [ ] Initial price ≥ minimum price
- [ ] Proposal includes clear rationale
- [ ] All parameter values double-checked

### Kill Strategy Checklist

- [ ] Strategy address verified on block explorer
- [ ] Confirmed this is the correct strategy to kill
- [ ] Documented impact on voters
- [ ] Proposal includes communication plan for affected voters
- [ ] Treasury will receive pending revenue (acceptable?)

---

## Reference: Current System Parameters

| Parameter | Value |
|-----------|-------|
| Voting Epoch | 7 days |
| Bribe Split | 20% (configurable by governance) |
| Revenue Token | Set at deployment |
| Voter Contract | [Check deployment docs] |

---

## Getting Help

If you need assistance:
1. Check the technical specification in `SPEC.md`
2. Review past successful proposals for examples
3. Ask in the governance forum before submitting
4. Have a technical contributor review parameter formatting
