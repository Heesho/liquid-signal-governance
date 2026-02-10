# How to Submit the REI Strategy Proposal

This guide walks you through creating a governance proposal to add REI as an accumulation strategy for Donut DAO. No technical knowledge required - just follow each step exactly.

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
Add REI Accumulation Strategy
```

### Summary

Click on the **Summary** field and paste this exactly:

```
Add a strategy to accumulate $REI tokens using protocol revenue. Unit 00 - Rei is an AI agent on Base offering crypto market analysis and philosophical insights, powered by a unique semantic memory system. With a $14M+ market cap, 1B fixed supply, and growing AI x crypto narrative, this enables the DAO to build a position in a promising AI agent asset on Base.
```

### Body

Click on the **Body** field and paste this exactly:

```
## Rationale

**1. AI Agent with Real Utility**
Rei (Unit 00) is an AI agent on Base that provides crypto market analysis and philosophical insights, featuring a unique semantic memory system that sets it apart from generic AI tokens.

**2. Strong AI x Crypto Narrative**
AI agents are one of the strongest emerging narratives in crypto. Rei sits at the intersection of AI and blockchain on Base, positioning the DAO to benefit from this megatrend.

**3. Fixed Supply**
REI has a fixed total supply of 1,000,000,000 tokens with 100% already in circulation. No inflation, no future dilution - what you see is what you get.

**4. Base Ecosystem Alignment**
Both DONUT and REI are native to Base. Accumulating REI strengthens the DAO's footprint in the Base AI ecosystem and creates cross-community alignment.

**5. Deep Value**
At ~$0.014 with a ~$14M market cap, REI is an early-stage AI agent play on Base with significant upside potential as the AI agent narrative matures.

## Expected Outcome

- Revenue tokens sold for REI via Dutch auction
- At ~5% allocation (~$500/day), DAO accumulates ~35,000 REI daily at current prices
- 20% of REI payments go to voter bribes
- 80% of REI payments go to DAO treasury
- Even at 1% allocation ($100/day), consistent buyback pressure on REI

## Technical Details

- Payment Token: REI (0x6B2504A03ca4D43d0D73776F6aD46dAb2F2a4cFD)
- Payment Receiver: DAO Treasury (0x690C2e187c8254a887B35C0B4477ce6787F92855)
- Initial Price: 3,500 REI (~$100 at current prices)
- Epoch Period: 1 day
- Price Multiplier: 120%
- Minimum Price: 3,500 REI
```

### Resources

Look for a **Resources** section with a **"+ Add"** button. Click it to add helpful links.

**Add these two resources:**

First resource:
- Label: `REI on CoinGecko`
- URL: `https://www.coingecko.com/en/coins/unit-00-rei`

Second resource (click "+ Add" again):
- Label: `REI on Basescan`
- URL: `https://basescan.org/token/0x6B2504A03ca4D43d0D73776F6aD46dAb2F2a4cFD`

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

This is the REI token address. Click the field and paste:
```
0x6B2504A03ca4D43d0D73776F6aD46dAb2F2a4cFD
```

---

**Field 2: _paymentReceiver**

This is where the REI tokens will go (the DAO treasury). Click the field and paste:
```
0x690C2e187c8254a887B35C0B4477ce6787F92855
```

---

**Field 3: _initPrice**

This is the starting price (3,500 REI tokens). Click the field and paste:
```
3500000000000000000000
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

This is the minimum price floor (3,500 REI tokens). Click the field and paste:
```
3500000000000000000000
```

---

### 3.5: Continue to Next Step

After filling in all 6 fields, click the **"Next"** button in the bottom right corner.

---

## Step 4: Review and Submit (Step 3 of 3 in Aragon)

You're almost done! This is the final review step.

### Double-Check Everything

Before submitting, verify:

1. **Title** shows: "Add REI Accumulation Strategy"
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
| _paymentToken | `0x6B2504A03ca4D43d0D73776F6aD46dAb2F2a4cFD` |
| _paymentReceiver | `0x690C2e187c8254a887B35C0B4477ce6787F92855` |
| _initPrice | `3500000000000000000000` |
| _epochPeriod | `86400` |
| _priceMultiplier | `1200000000000000000` |
| _minInitPrice | `3500000000000000000000` |

---

## What Do These Parameters Mean?

| Parameter | What It Means |
|-----------|---------------|
| **_paymentToken** | The REI token that buyers will use to purchase revenue |
| **_paymentReceiver** | The DAO treasury that receives the REI payments |
| **_initPrice** | Starting auction price: 3,500 REI (~$100 worth) |
| **_epochPeriod** | Auction resets every 1 day (86,400 seconds) |
| **_priceMultiplier** | Price goes up 20% after each purchase |
| **_minInitPrice** | Price won't go below 3,500 REI |

---

## Helpful Links

- **Donut DAO:** https://app.aragon.org/dao/base-mainnet/0x690C2e187c8254a887B35C0B4477ce6787F92855/dashboard
- **REI on CoinGecko:** https://www.coingecko.com/en/coins/unit-00-rei
- **REI Token on Basescan:** https://basescan.org/token/0x6B2504A03ca4D43d0D73776F6aD46dAb2F2a4cFD
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

> Unit 00 - Rei is one of the most interesting AI agent projects building on Base.
>
> Rei is an AI agent that provides crypto market analysis and philosophical insights, powered by a semantic memory system that makes it genuinely useful - not just another meme token with "AI" slapped on.
>
> With a fixed supply of 1B tokens and 100% already in circulation, there's no inflation risk or future dilution to worry about.
>
> AI agents are one of the strongest narratives in crypto right now, and Rei is well-positioned on Base to capture that growth.
>
> At ~$0.014 and a ~$14M market cap, REI is still early relative to where the AI agent category is heading.
>
> Accumulating REI diversifies the DONUT treasury into the AI agent vertical on Base - both ecosystems benefit from the cross-pollination.
>
> Even at 1% allocation, this creates consistent daily buyback pressure on REI while positioning the treasury in a growing narrative.
