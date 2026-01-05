## 0) Identity
- **What this is:** Liquid Signal Governance is a revenue-routing system we built to let the Donut community continuously point protocol earnings toward whatever ideas they prefer. It turns raw income into a public pool, then lets voters decide which outlets receive it.
- **Place in the Donut world:** It sits between Donut Miner (where revenue is generated) and the DAO treasury. Revenue is collected, steered by community signaling, and then pushed into outcome-specific outlets such as buybacks or grants.
- **Our role:** We at GlazeCorp designed and maintain the machinery, but the choices about where value flows are made by DONUT holders through this system.

## 1) The core idea
Think of it as a series of adjustable gutters catching rainwater. Revenue drips in at the top, voters tilt the gutters toward preferred buckets, and each bucket has its own way of handling what it receives.

Key concepts we keep front and center:
1. **Staked voice:** People park DONUT to receive a non-transferable voting balance; it represents steady commitment rather than quick trades.
2. **Epoch rhythm:** Votes lock for 7-day windows so the system can tally fairly and prevent rapid flip-flops.
3. **Strategy buckets:** Each bucket can auction off the revenue it catches, converting it into another asset (for example, selling incoming WETH for DONUT to run buybacks).
4. **Auction gravity:** Prices start high and fall linearly to zero over each auction window, so buyers decide when to step in.
5. **Voter rewards:** A configurable slice of every auction payment is set aside for the people who aimed the gutter at that bucket.
6. **Treasury backstop:** If nobody votes or a bucket is shut down, revenue reverts to the DAO treasury instead of getting stuck.

## 2) Why this exists
- **The problem:** Protocols earn income but often hard-code where it goes or rely on small multisig groups. That makes it slow to adapt and hard to trust.
- **What fell short:** Fixed fee splits and isolated committees cannot keep up with changing needs or signal real community intent.
- **Design principle:** Make revenue steering a recurring, liquid vote so anyone with skin in the game can redirect flows without pausing the protocol.

## 3) The cast of characters
- **Stakers/Voters:** Stake DONUT to gain voting weight. They want influence and a share of rewards. They risk time-locked votes (one action per 7-day epoch) and must clear votes before unstaking.
- **Auction participants (buyers):** Spend another asset (e.g., DONUT) to buy the accumulated revenue asset (e.g., WETH). They want a good price and must watch the falling-price clock.
- **Strategy creators (governed role):** Add or disable buckets, choose which asset they collect, which asset they sell for, and where the payment goes. They must act on behalf of the DAO; poor choices harm trust.
- **Treasury/DAO:** Default receiver when nobody votes or when a bucket is deactivated. Wants defensible, transparent flows back to the collective.
- **GlazeCorp:** Builder and maintainer. We set safeguards (bounds on auctions, caps on reward splits) but do not own the outcomes.

## 4) The system loop
1. Revenue arrives from Donut Miner into a holding area.
2. Voters assign their weight across active buckets for the current 7-day epoch (one vote or reset per epoch).
3. Anyone can trigger distribution, pushing the revenue token into each bucket according to its vote share.
4. Each bucket runs a falling-price sale for its entire balance. A buyer takes all of it in one purchase.
5. The buyer’s payment is split: most goes to a chosen receiver (often the DAO), and up to half can be earmarked for voter rewards tied to that bucket.
6. Reward balances stream out over a 7-day period to voters who supported that bucket, and participants can claim whenever they like.
7. The loop repeats with fresh revenue and fresh signals each epoch.

## 5) Incentives and value flow
- **Who pays:** Buyers pay with a designated payment asset when they take the auction. Stakers pay in opportunity cost: their DONUT is parked and their vote is locked for the epoch.
- **Who earns:** Payment receivers (e.g., treasury) get the bulk of auction proceeds. Voters for that bucket share the reward slice, paid in the same asset the buyer used.
- **Flow direction:** Revenue token (such as WETH) flows into buckets; payment token (such as DONUT) flows out from buyers to the treasury and voters. If no votes exist, revenue bypasses buckets and goes straight to the treasury.
- **Example splits:** The reward slice is adjustable from 0% up to 50% of each auction payment; the rest goes to the designated receiver.

## 6) The rules of the system
- **Allowed:** Stake DONUT, vote once per 7-day epoch, direct weight across multiple buckets, trigger revenue distribution, trigger reward streaming, participate in auctions, and withdraw staked DONUT after clearing votes.
- **Discouraged or impossible:** Transferring the staked voting balance to someone else; voting twice in the same epoch; unstaking while votes are still active; pushing revenue from unauthorized sources.
- **Enforced automatically:** Vote timing (epoch guard), non-transferable voting balances, revenue distribution proportional to vote weights, price decay to zero within each auction window, payment split caps, and reward streaming over 7 days.
- **Intentionally open:** Anyone can call the public actions (distribute revenue, run auctions, forward rewards); the DAO chooses which buckets exist, what assets they handle, and how big the voter reward slice should be.

## 7) A concrete walkthrough (with numbers)
- **Setup:** DONUT is staked for voting weight. Revenue arrives as 100 WETH. There is one active bucket configured to sell WETH for DONUT, with a 20% reward slice and a one-hour price drop.
- **Voting:** Alice stakes 200 DONUT and votes 100% for this bucket. Bob stakes 100 DONUT and does the same. Total weight = 300.
- **Distribution:** Anyone routes the 100 WETH into the bucket. It now holds all 100 WETH for sale.
- **Auction:** The starting price is set high. After some time, Carol buys the full 100 WETH batch for 1,000,000 DONUT.
- **Split:** 20% (200,000 DONUT) is reserved for rewards to Alice and Bob. 80% (800,000 DONUT) goes to the designated receiver (for example, the DAO treasury).
- **Rewards:** Alice had two-thirds of the vote weight, Bob one-third. Over the next 7 days, Alice can claim roughly 133,333 DONUT and Bob roughly 66,667 DONUT as the stream unlocks.
- **Reset:** After the epoch, Alice and Bob can keep the same vote, adjust it, or reset to unstake.

## 8) What this solves (and what it does not)
- **Solves:** Turns protocol revenue into a live market where community sentiment directly shapes where value flows. Reduces reliance on static fee splits. Rewards voters for steering responsibly.
- **Limits:** If nobody buys an auction, revenue stays parked in that bucket until someone does. Vote locks mean stakers cannot react multiple times inside a single epoch. The DAO’s configuration choices still matter; bad parameters can dull incentives.
- **This is NOT:** A promise of profit; a guarantee that auctions will clear quickly; a shield from market risk on DONUT or other assets; a replacement for DAO oversight; or a future feature set beyond what is described here.

## 9) Power, incentives, and trust
- **Who has influence:** Voters control revenue direction; the DAO-appointed maintainer controls which buckets exist, what assets they handle, and how large the voter reward slice can be (up to half).
- **What is trusted:** That the DAO keeps the maintainer role aligned with community interest; that revenue sources are honest; and that buyers pay fairly observed market prices when they step into auctions.
- **What is not trusted:** No central party can quietly redirect live revenue without a vote; vote weights cannot be borrowed or flashed because the voting balance cannot be transferred.
- **Human decisions that remain:** Choosing bucket parameters, reward splits, and when to retire or add outlets. Buyers decide when to strike during a price drop.
- **Incentives that reduce trust needs:** Rewards flow only to those who actually voted for a bucket; buyers get better prices by waiting, but risk being scooped; stakers must keep votes clear to exit, encouraging timely participation.

## 10) What keeps this system honest
- **Rewarded behaviors:** Consistent voting, thoughtful bucket selection, triggering distributions, and participating in auctions at sensible times.
- **Discouraged behaviors:** Vote spamming (blocked by the epoch rule), quick in-and-out staking just to influence a single block (blocked by non-transferable balances and vote locks), and starving buckets (revenue defaults to the treasury if nobody votes).
- **If people act selfishly:** Votes still guide revenue; selfish buyers simply time auctions to their advantage, which still moves value to the designated receiver and voters. If a maintainer sets poor parameters, voters can shift weight elsewhere.
- **If participation slows:** Revenue accumulates until someone distributes it; auctions wait for buyers; rewards accrue once payments happen. Nothing breaks, but value may idle until someone acts.

## 11) FAQ
1. **Why stake DONUT instead of just holding it?** Staking is how you gain steering power and access to voter rewards.
2. **Can I trade my staked position?** No. It is deliberately non-transferable so votes cannot be flashed or rented.
3. **How often can I change my vote?** Once per 7-day epoch; you can also reset once per epoch to clear votes.
4. **Do I need to vote for one bucket or many?** You can split your weight across several; the system normalizes your chosen percentages.
5. **What happens if nobody votes?** All incoming revenue goes straight to the DAO treasury until voting resumes.
6. **Who can add or remove buckets?** The DAO-appointed maintainer role (intended to be governed by DonutDAO).
7. **How do voter rewards work?** A slice of each auction payment is set aside and streamed over 7 days to people who voted for that bucket.
8. **What if an auction never sells?** The revenue stays in that bucket until a buyer takes it; the price keeps falling to zero within each auction window.
9. **Can the reward slice exceed half the payment?** No; it is capped at 50% and can be set lower, even to zero.
10. **What assets are involved today?** On Base mainnet, revenue is WETH, the payment asset and treasury asset is DONUT, and the governance stake represents DONUT.
11. **Can someone else trigger distributions and reward forwarding?** Yes. Any participant can call the public actions; there is no gatekeeping.
12. **How do I unstake?** Clear all votes (one reset per epoch) and then withdraw your staked DONUT one-for-one.

## 12) Glossary
- **Auction window:** The time during which a bucket’s price falls from its starting level to zero.
- **Base:** The blockchain network where this deployment runs.
- **Bucket (strategy):** A destination for revenue that also defines how to sell it and where payments go.
- **Buyback bucket:** A configuration that sells revenue for DONUT and sends proceeds to the DAO, effectively supporting DONUT’s value.
- **Epoch:** A 7-day voting cycle; only one vote or reset per account is allowed during each.
- **Falling-price sale (Dutch auction):** A sale where price starts high and drops linearly until someone buys.
- **Governance stake:** The non-transferable balance you get by staking DONUT; used for voting.
- **Holding area:** The revenue collection point before votes direct it into buckets.
- **Payment asset:** The token buyers spend in auctions (e.g., DONUT).
- **Payment receiver:** The address that receives the buyer’s payment after the voter reward slice is removed.
- **Reward slice:** The fraction of each payment reserved for voters in the winning bucket, capped at half.
- **Reward stream:** The 7-day drip of the reward slice to voters.
- **Revenue asset:** The token the protocol earns (e.g., WETH).
- **Tilt:** The act of assigning your voting weight toward specific buckets.
- **Treasury backstop:** The default route for revenue when no valid votes exist or when a bucket is deactivated.
- **Unlock:** Clearing votes so staked DONUT can be withdrawn.
