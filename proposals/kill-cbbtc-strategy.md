# Kill cbBTC Strategy Proposal

This proposal kills the cbBTC accumulation strategy due to a precision bug that prevents voters from claiming rewards.

---

## The Problem

cbBTC uses 8 decimal places instead of the standard 18. Combined with BTC's high price (~$100k), the reward amounts are so small that they round to zero in the bribe distribution math.

**Real-world result:** Voters have been unable to claim any cbBTC rewards even after 7+ days of voting.

### Why This Happens

1. **cbBTC has only 8 decimals** (vs 18 for most tokens - USDC works at 6 decimals because 1 USDC = $1, but 1 cbBTC = $100k)
2. **Small bribe amounts result in `rewardRate = 1`** (1 unit per second = 0.00000001 cbBTC/sec)
3. **rewardPerToken stays at 0** - the math truncates to zero before any rewards can accrue
4. **Bribes are effectively stuck** - earned() returns 0 for all voters regardless of balance

### What Voters Experience

| Time Since Vote | What Happens |
|-----------------|--------------|
| Day 1-7+ | `earned()` shows 0, nothing to claim |
| After 7+ days | Still 0 - even large voters cannot claim anything |

### The Math Problem

With a typical bribe (~0.008 cbBTC) and current voting supply:
- **rewardRate** = bribe ÷ 604800 seconds = ~1 unit/sec
- **rewardPerToken** = rewardRate × time ÷ totalSupply = rounds to 0
- **earned** = balance × rewardPerToken = 0

The numbers are just too small. USDC works at 6 decimals because $1 = 1 USDC. But cbBTC at 8 decimals with BTC at $100k means the smallest unit is worth $0.001 - and when you divide that across voters and time, you get rounding errors that eat the entire reward.

---

## Solution

Kill this strategy and replace with an 18-decimal BTC alternative:
- **Morpho BTC vault** - yield-generating, 18 decimals
- **Aave aBTC** - yield-generating, 18 decimals
- **Gauntlet BTC vault** - managed strategy, 18 decimals
- **cbBTC-DONUT LP** - earns fees + deepens DONUT liquidity, 18 decimals

These are actually better than raw cbBTC since they generate yield instead of sitting idle.

---

## Proposal Instructions

### Before You Start

**You will need:**
- A web browser (Chrome, Firefox, etc.)
- A crypto wallet (like MetaMask) connected to Base network
- Some ETH on Base for gas fees
- **Minimum 10,000 gDONUT** to create a proposal (this is staked DONUT, not regular DONUT)

**DAO Link:**
https://app.aragon.org/dao/base-mainnet/0x690C2e187c8254a887B35C0B4477ce6787F92855/dashboard

---

## Step 1: Go to the DAO and Start a New Proposal

1. Open this link in your browser:
   ```
   https://app.aragon.org/dao/base-mainnet/0x690C2e187c8254a887B35C0B4477ce6787F92855/dashboard
   ```

2. Connect your wallet by clicking the **"Connect Wallet"** button in the top right corner

3. Make sure your wallet is on **Base network**

4. Look for a button that says **"New Proposal"** or **"Create Proposal"** and click it

---

## Step 2: Fill in the Proposal Details (Step 1 of 3 in Aragon)

You should now see a form with fields for "Proposal title", "Summary", and "Body".

### Proposal Title

Click on the **Proposal title** field and paste this exactly:

```
Kill cbBTC Accumulation Strategy
```

### Summary

Click on the **Summary** field and paste this exactly:

```
Deactivate the cbBTC accumulation strategy due to a fatal precision bug. cbBTC's 8 decimal places combined with BTC's high price cause all reward calculations to round to zero. No voters have been able to claim any rewards even after 7+ days. This proposal kills the strategy so we can replace it with an 18-decimal alternative.
```

### Body

Click on the **Body** field and paste this exactly:

```
## Problem

The cbBTC bribe contract has a fatal precision bug. No voters have been able to claim any rewards, even after 7+ days.

**Why it's broken:**
- cbBTC has 8 decimals (not 18 like most tokens)
- BTC price is ~$100k, so the smallest cbBTC unit (0.00000001) = $0.001
- When you divide tiny reward amounts across voters and time, it rounds to zero
- `earned()` shows 0 for ALL voters, regardless of voting power

**Real-world result:**
- Voters waited 7+ days: earned = 0
- Large voters waited 7+ days: earned = 0
- The math just doesn't work at this decimal precision + price level

USDC works at 6 decimals because $1 = 1 USDC. cbBTC fails at 8 decimals because the BTC price makes the numbers too small to survive the division.

## Proposed Action

Execute `killStrategy()` on the Voter contract to:
1. Mark the cbBTC strategy as inactive (`strategy_IsAlive = false`)
2. Send any pending WETH revenue to the DAO treasury
3. Prevent new votes from being allocated to this strategy

Note: cbBTC bribes currently in the contract are effectively stuck due to the precision bug.

## Future Considerations

BTC exposure could be re-added using 18-decimal alternatives:
- Morpho BTC vaults (yield-generating)
- Aave aBTC (yield-generating)
- Gauntlet BTC vault
- cbBTC-DONUT LP tokens

These are actually better than raw cbBTC since they generate yield instead of sitting idle.

## Technical Details

- Voter Contract: 0x9C5Cf3246d7142cdAeBBD5f653d95ACB73DdabA6
- cbBTC Strategy: 0x4eBa1Ee0A1DAdbd2CdFfc4056fe1e20330A9806A
- Function: killStrategy(address _strategy)
```

### Resources

Look for a **Resources** section with a **"+ Add"** button. Click it to add helpful links.

**Add these resources:**

First resource:
- Label: `cbBTC Strategy`
- URL: `https://basescan.org/address/0x4eBa1Ee0A1DAdbd2CdFfc4056fe1e20330A9806A`

Second resource (click "+ Add" again):
- Label: `Voter Contract`
- URL: `https://basescan.org/address/0x9C5Cf3246d7142cdAeBBD5f653d95ACB73DdabA6`

### Add Actions Toggle

Look for **"Add actions"** with a toggle switch. Make sure it is switched **ON** (usually shown in blue or with "Yes").

### Continue to Next Step

Click the **"Next: Add actions"** button to continue.

---

## Step 3: Add the Smart Contract Action (Step 2 of 3 in Aragon)

This is where we tell the DAO what to actually do when the proposal passes.

### 3.1: Click the "+ Action" Button

Look at the bottom left of the page. You'll see a blue button that says **"+ Action"**. Click it.

### 3.2: Enter the Contract Address

A popup window will appear titled **"Add contract address"**.

Click on the input field and paste this address:

```
0x9C5Cf3246d7142cdAeBBD5f653d95ACB73DdabA6
```

**Wait a few seconds.** The system will automatically:
- Verify the contract
- Retrieve the ABI (the contract's instructions)

You should see **"Voter"** appear as the contract name with green checkmarks.

Click the blue **"Add contract"** button.

### 3.3: Select the Function

After adding the contract, you'll see a list of functions.

Find and click on **`killStrategy`**.

### 3.4: Fill in the Parameter

You will see 1 input field. Fill it by clicking on the field and pasting the value shown below.

**IMPORTANT:** Copy the value exactly as shown. Do not add spaces or change anything.

---

**Field 1: _strategy**

This is the cbBTC strategy address to kill. Click the field and paste:
```
0x4eBa1Ee0A1DAdbd2CdFfc4056fe1e20330A9806A
```

---

### 3.5: Continue to Next Step

After filling in the field, click the **"Next"** button in the bottom right corner.

---

## Step 4: Review and Submit (Step 3 of 3 in Aragon)

You're almost done! This is the final review step.

### Double-Check Everything

Before submitting, verify:

1. **Title** shows: "Kill cbBTC Accumulation Strategy"
2. **Action** shows: `killStrategy` on the Voter contract
3. **Parameter** shows: `0x4eBa1Ee0A1DAdbd2CdFfc4056fe1e20330A9806A`

### Submit the Proposal

1. Click **"Create Proposal"** or **"Submit"**

2. Your wallet (MetaMask) will pop up asking you to sign a transaction

3. Click **"Confirm"** in your wallet to submit the proposal

4. Wait for the transaction to complete (this may take a few seconds)

### Done!

Once the transaction confirms, your proposal is live! Share the link with the community so people can vote on it.

---

## Quick Reference: All Values to Copy

| Field | Value |
|-------|-------|
| Voter Contract | `0x9C5Cf3246d7142cdAeBBD5f653d95ACB73DdabA6` |
| _strategy | `0x4eBa1Ee0A1DAdbd2CdFfc4056fe1e20330A9806A` |

---

## What Does killStrategy Do?

From the Voter contract (line 300-313):

```solidity
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
```

This function:
1. Updates any pending revenue calculations
2. Sends any claimable WETH to the DAO treasury (not lost)
3. Marks the strategy as dead (`strategy_IsAlive = false`)
4. Emits an event for tracking

After killing:
- Users can still reset their votes (required to unstake)
- No new votes can be cast for this strategy
- Future revenue goes to treasury, not this strategy

---

## Helpful Links

- **Donut DAO:** https://app.aragon.org/dao/base-mainnet/0x690C2e187c8254a887B35C0B4477ce6787F92855/dashboard
- **Voter Contract:** https://basescan.org/address/0x9C5Cf3246d7142cdAeBBD5f653d95ACB73DdabA6
- **cbBTC Strategy:** https://basescan.org/address/0x4eBa1Ee0A1DAdbd2CdFfc4056fe1e20330A9806A
- **cbBTC Token:** https://basescan.org/token/0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf

---

## Troubleshooting

**"I can't connect my wallet"**
- Make sure you have MetaMask or another wallet installed
- Make sure you're on Base network (not Ethereum mainnet)

**"The contract isn't being verified"**
- Double-check you pasted the correct address: `0x9C5Cf3246d7142cdAeBBD5f653d95ACB73DdabA6`
- Make sure there are no extra spaces before or after the address

**"I got an error when submitting"**
- Make sure you have enough ETH on Base for gas fees
- Try refreshing the page and starting again

**"I don't see the killStrategy function"**
- Make sure you clicked "+ Action" and added the Voter contract first
- Scroll through the function list - it should be there

---

## What Happens After Killing

- **Existing votes:** Users can still reset their votes (required to unstake)
- **Pending bribes:** cbBTC in the bribe contract is effectively stuck (precision bug means earned = 0)
- **Future revenue:** Will no longer be allocated to this strategy
- **New votes:** Cannot be cast for this strategy

BTC exposure can be re-added later using 18-decimal alternatives like Morpho BTC vaults, Aave aBTC, Gauntlet BTC, or cbBTC-DONUT LP tokens.
