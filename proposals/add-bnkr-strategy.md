# How to Submit the BNKR Strategy Proposal

This guide walks you through creating a governance proposal to add BNKR as an accumulation strategy for Donut DAO. No technical knowledge required - just follow each step exactly.

---

## Before You Start

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
Add BNKR Accumulation Strategy
```

### Summary

Click on the **Summary** field and paste this exactly:

```
Add a strategy to accumulate $BNKR tokens using protocol revenue. Bankr is an AI-powered crypto trading bot on Base and Farcaster with real utility, built-in buy pressure (0.8% of every swap market-buys BNKR), and a growing product ecosystem including staking, SDK, and API integrations. This enables the DAO to build a position in an undervalued AI/DeFi infrastructure asset on Base.
```

### Body

Click on the **Body** field and paste this exactly:

```
## Rationale

**1. Product-Market Fit**
Bankr is an AI-powered crypto assistant that lets users buy, sell, swap, and manage crypto through natural language on Farcaster and X. It has demonstrated real product-market fit with a growing user base and expanding feature set.

**2. Built-In Buy Pressure**
0.8% of every swap through the Bankr bot is recycled to market-buy BNKR, creating constant demand and liquidity depth. This is a structural tailwind for price appreciation.

**3. Revenue & Utility**
$BNKR is used to pay fees, unlock features, and share in platform revenue. Staking BNKR earns rewards and contributes to network utility. The token has real demand drivers beyond speculation.

**4. Growing Ecosystem**
Bankr has shipped SDK for developers, API integrations for third-party apps, Avantis leveraged trading integration, and an automations framework - all on Base. Active development and shipping cadence.

**5. Deep Value**
At ~$0.001, with 100B total supply and real product usage, BNKR represents a deep value play in the AI x DeFi infrastructure category on Base.

## Expected Outcome

- Revenue tokens sold for BNKR via Dutch auction
- At ~5% allocation (~$500/day), DAO accumulates ~100,000 BNKR daily at current prices
- 20% of BNKR payments go to voter bribes
- 80% of BNKR payments go to DAO treasury
- Even at 1% allocation ($100/day), consistent buyback pressure on BNKR

## Technical Details

- Payment Token: BNKR (0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b)
- Payment Receiver: DAO Treasury (0x690C2e187c8254a887B35C0B4477ce6787F92855)
- Initial Price: 100,000 BNKR (~$100 at current prices)
- Epoch Period: 1 day
- Price Multiplier: 120%
- Minimum Price: 100,000 BNKR
```

### Resources

Look for a **Resources** section with a **"+ Add"** button. Click it to add helpful links.

**Add these two resources:**

First resource:
- Label: `Bankr Website`
- URL: `https://bankr.bot/`

Second resource (click "+ Add" again):
- Label: `BNKR on Basescan`
- URL: `https://basescan.org/token/0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b`

### Add Actions Toggle

Look for **"Add actions"** with a toggle switch. Make sure it is switched **ON** (usually shown in blue or with "Yes").

### Continue to Next Step

Click the **"Next: Add actions"** button to continue.

---

## Step 3: Add the Smart Contract Action (Step 2 of 3 in Aragon)

This is where we tell the DAO what to actually do when the proposal passes. You should see a page titled **"Add actions"**.

### 3.1: Click the "+ Action" Button

Look at the bottom left of the page. You'll see a blue button that says **"+ Action"**. Click it.

### 3.2: Enter the Contract Address

A popup window will appear titled **"Add contract address"**.

You'll see an input field. Click on it and paste this address:

```
0x9C5Cf3246d7142cdAeBBD5f653d95ACB73DdabA6
```

**Wait a few seconds.** The system will automatically:
- ✓ Verify the contract
- ✓ Retrieve the ABI (the contract's instructions)

You should see **"Voter"** appear as the contract name with green checkmarks.

Click the blue **"Add contract"** button.

### 3.3: Select the Function

After adding the contract, you'll see a list of functions (things the contract can do).

Find and click on **`addStrategy`**.

### 3.4: Fill in the 6 Parameter Fields

You will now see 6 empty input fields. Fill each one by clicking on the field and pasting the value shown below.

**IMPORTANT:** Copy each value exactly as shown. Do not add spaces or change anything.

---

**Field 1: _paymentToken**

This is the BNKR token address. Click the field and paste:
```
0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b
```

---

**Field 2: _paymentReceiver**

This is where the BNKR tokens will go (the DAO treasury). Click the field and paste:
```
0x690C2e187c8254a887B35C0B4477ce6787F92855
```

---

**Field 3: _initPrice**

This is the starting price (100,000 BNKR tokens). Click the field and paste:
```
100000000000000000000000
```

---

**Field 4: _epochPeriod**

This is how long each auction cycle lasts (1 day = 86400 seconds). Click the field and paste:
```
86400
```

---

**Field 5: _priceMultiplier**

This is how much the price increases after someone buys (120%). Click the field and paste:
```
1200000000000000000
```

---

**Field 6: _minInitPrice**

This is the minimum price floor (100,000 BNKR tokens). Click the field and paste:
```
100000000000000000000000
```

---

### 3.5: Continue to Next Step

After filling in all 6 fields, click the **"Next"** button in the bottom right corner.

---

## Step 4: Review and Submit (Step 3 of 3 in Aragon)

You're almost done! This is the final review step.

### Double-Check Everything

Before submitting, verify:

1. **Title** shows: "Add BNKR Accumulation Strategy"
2. **Action** shows: `addStrategy` on the Voter contract
3. **All 6 parameters** are filled in correctly

### Submit the Proposal

1. Click **"Create Proposal"** or **"Submit"**

2. Your wallet (MetaMask) will pop up asking you to sign a transaction

3. Click **"Confirm"** in your wallet to submit the proposal

4. Wait for the transaction to complete (this may take a few seconds)

### Done!

Once the transaction confirms, your proposal is live! Share the link with the community so people can vote on it.

---

## Quick Reference: All Values to Copy

If you need to quickly copy all the values, here they are:

| Field | Value |
|-------|-------|
| Voter Contract | `0x9C5Cf3246d7142cdAeBBD5f653d95ACB73DdabA6` |
| _paymentToken | `0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b` |
| _paymentReceiver | `0x690C2e187c8254a887B35C0B4477ce6787F92855` |
| _initPrice | `100000000000000000000000` |
| _epochPeriod | `86400` |
| _priceMultiplier | `1200000000000000000` |
| _minInitPrice | `100000000000000000000000` |

---

## What Do These Parameters Mean?

| Parameter | What It Means |
|-----------|---------------|
| **_paymentToken** | The BNKR token that buyers will use to purchase revenue |
| **_paymentReceiver** | The DAO treasury that receives the BNKR payments |
| **_initPrice** | Starting auction price: 100,000 BNKR (~$100 worth) |
| **_epochPeriod** | Auction resets every 1 day (86,400 seconds) |
| **_priceMultiplier** | Price goes up 20% after each purchase |
| **_minInitPrice** | Price won't go below 100,000 BNKR |

---

## Helpful Links

- **Donut DAO:** https://app.aragon.org/dao/base-mainnet/0x690C2e187c8254a887B35C0B4477ce6787F92855/dashboard
- **Bankr Website:** https://bankr.bot/
- **BNKR Token on Basescan:** https://basescan.org/token/0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b
- **Voter Contract on Basescan:** https://basescan.org/address/0x9C5Cf3246d7142cdAeBBD5f653d95ACB73DdabA6
- **DAO Treasury on Basescan:** https://basescan.org/address/0x690C2e187c8254a887B35C0B4477ce6787F92855

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

**"I don't see the addStrategy function"**
- Make sure you clicked "+ Action" and added the Voter contract first
- The contract should show "Voter" as its name

---

## Why This Proposal?

> Bankr is one of the most used AI-powered trading bots on Base with real product-market fit.
>
> The Bankr bot lets anyone trade crypto through simple messages on Farcaster and X - it's the simplest onramp to DeFi on Base.
>
> BNKR has a built-in buy mechanism: 0.8% of every swap through the bot market-buys BNKR, creating constant structural demand.
>
> The token has real utility - it's used to pay fees, unlock features, and earn staking rewards.
>
> The team has been consistently shipping: SDK, API integrations, Avantis leveraged trading, automations framework, and Solana expansion.
>
> At current prices (~$0.001), BNKR is a deep value play in the AI x DeFi infrastructure category on Base.
>
> Accumulating BNKR positions the DONUT treasury in a growing ecosystem with aligned values - both are building on Base with a focus on real utility.
>
> Even at 1% allocation, this creates consistent daily buyback pressure on BNKR while diversifying the treasury into a productive asset.
