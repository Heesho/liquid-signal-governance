const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Interactive Testing", function () {
    let owner, user1, user2, user3, user4, treasury;
    let underlying, revenueToken, paymentToken, paymentToken2;
    let governanceToken, voter, bribeFactory, strategyFactory, revenueRouter;
    let multicall;

    const WEEK = 7 * 24 * 60 * 60;
    const HOUR = 60 * 60;
    const DAY = 24 * 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, user3, user4, treasury] = await ethers.getSigners();

        // Deploy mock tokens
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("Underlying Token", "UNDERLYING", 18);
        revenueToken = await MockERC20.deploy("Revenue Token", "WETH", 18);
        paymentToken = await MockERC20.deploy("Payment Token", "USDC", 6);
        paymentToken2 = await MockERC20.deploy("Payment Token 2", "DAI", 18);

        // Deploy factories
        const BribeFactory = await ethers.getContractFactory("BribeFactory");
        bribeFactory = await BribeFactory.deploy();

        const StrategyFactory = await ethers.getContractFactory("StrategyFactory");
        strategyFactory = await StrategyFactory.deploy();

        // Deploy GovernanceToken
        const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
        governanceToken = await GovernanceToken.deploy(underlying.address, "Staked Underlying", "sUNDER");

        // Deploy Voter
        const Voter = await ethers.getContractFactory("Voter");
        voter = await Voter.deploy(
            governanceToken.address,
            revenueToken.address,
            treasury.address,
            bribeFactory.address,
            strategyFactory.address
        );

        // Set voter on governance token
        await governanceToken.setVoter(voter.address);

        // Deploy RevenueRouter and set as revenue source
        const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
        revenueRouter = await RevenueRouter.deploy(revenueToken.address, voter.address);
        await voter.setRevenueSource(revenueRouter.address);

        // Deploy Multicall
        const Multicall = await ethers.getContractFactory("Multicall");
        multicall = await Multicall.deploy(voter.address);

        // Mint tokens to users
        await underlying.mint(user1.address, ethers.utils.parseEther("10000"));
        await underlying.mint(user2.address, ethers.utils.parseEther("10000"));
        await underlying.mint(user3.address, ethers.utils.parseEther("10000"));
        await underlying.mint(user4.address, ethers.utils.parseEther("10000"));
        await revenueToken.mint(owner.address, ethers.utils.parseEther("1000000"));
        await paymentToken.mint(user1.address, ethers.utils.parseUnits("1000000", 6));
        await paymentToken.mint(user2.address, ethers.utils.parseUnits("1000000", 6));
        await paymentToken.mint(user3.address, ethers.utils.parseUnits("1000000", 6));
        await paymentToken.mint(user4.address, ethers.utils.parseUnits("1000000", 6));
        await paymentToken2.mint(user1.address, ethers.utils.parseEther("1000000"));
        await paymentToken2.mint(user2.address, ethers.utils.parseEther("1000000"));
    });

    // ==================== HELPER FUNCTIONS ====================

    // Format helpers
    function fmt(val, decimals = 18) {
        return ethers.utils.formatUnits(val, decimals);
    }

    function fmtEth(val) {
        return ethers.utils.formatEther(val);
    }

    function fmtUsdc(val) {
        return ethers.utils.formatUnits(val, 6);
    }

    function parseEth(val) {
        return ethers.utils.parseEther(val.toString());
    }

    function parseUsdc(val) {
        return ethers.utils.parseUnits(val.toString(), 6);
    }

    // Get user name for logging
    function userName(address) {
        if (address === owner.address) return "owner";
        if (address === user1.address) return "user1";
        if (address === user2.address) return "user2";
        if (address === user3.address) return "user3";
        if (address === user4.address) return "user4";
        if (address === treasury.address) return "treasury";
        return address.slice(0, 8) + "...";
    }

    // ==================== ACTION FUNCTIONS ====================

    // Create a new strategy
    async function createStrategy(payment = paymentToken) {
        const decimals = payment.address === paymentToken.address ? 6 : 18;
        const initPrice = ethers.utils.parseUnits("100", decimals);
        const tx = await voter.addStrategy(
            payment.address,
            treasury.address,
            initPrice,
            HOUR,
            ethers.utils.parseEther("2"),
            initPrice
        );
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "Voter__StrategyAdded");
        console.log(`\n Created Strategy: ${event.args.strategy}`);
        console.log(`   Bribe: ${event.args.bribe}`);
        console.log(`   BribeRouter: ${event.args.bribeRouter}`);
        console.log(`   Payment Token: ${payment.address === paymentToken.address ? "USDC" : "DAI"}`);
        return {
            strategy: event.args.strategy,
            bribe: event.args.bribe,
            bribeRouter: event.args.bribeRouter
        };
    }

    // Stake tokens for a user
    async function stake(user, amount) {
        const amountWei = parseEth(amount);
        await underlying.connect(user).approve(governanceToken.address, amountWei);
        await governanceToken.connect(user).stake(amountWei);
        console.log(`\n ${userName(user.address)} staked ${amount} UNDERLYING`);
    }

    // Unstake tokens for a user
    async function unstake(user, amount) {
        const amountWei = parseEth(amount);
        await governanceToken.connect(user).unstake(amountWei);
        console.log(`\n ${userName(user.address)} unstaked ${amount} UNDERLYING`);
    }

    // Vote for strategies
    async function vote(user, strategies, weights) {
        await voter.connect(user).vote(strategies, weights);
        console.log(`\n ${userName(user.address)} voted:`);
        for (let i = 0; i < strategies.length; i++) {
            console.log(`   Strategy ${strategies[i].slice(0, 10)}... : weight ${weights[i]}`);
        }
    }

    // Reset votes
    async function reset(user) {
        await voter.connect(user).reset();
        console.log(`\n ${userName(user.address)} reset their votes`);
    }

    // Send revenue to router and flush
    async function sendRevenue(amount) {
        const amountWei = parseEth(amount);
        await revenueToken.transfer(revenueRouter.address, amountWei);
        await revenueRouter.flush();
        console.log(`\n Sent ${amount} WETH revenue to voter`);
    }

    // Send revenue to router WITHOUT flushing (stays in router)
    async function sendRevenueToRouter(amount) {
        const amountWei = parseEth(amount);
        await revenueToken.transfer(revenueRouter.address, amountWei);
        console.log(`\n Sent ${amount} WETH to router (not flushed)`);
    }

    // Flush router to voter
    async function flush() {
        await revenueRouter.flush();
        console.log(`\n Flushed router to voter`);
    }

    // Distribute to a single strategy
    async function distribute(strategy) {
        await multicall.distribute(strategy);
        console.log(`\n Distributed revenue to strategy ${strategy.slice(0, 10)}...`);
    }

    // Distribute to all strategies
    async function distributeAll() {
        await multicall.distributeAll();
        console.log(`\n Distributed revenue to all strategies`);
    }

    // Update claimable for a strategy (without distributing)
    async function updateStrategy(strategy) {
        await voter.updateStrategy(strategy);
        const claimable = await voter.strategy_Claimable(strategy);
        console.log(`\n Updated strategy ${strategy.slice(0, 10)}... | Claimable: ${fmtEth(claimable)} WETH`);
    }

    // Update claimable for all strategies (without distributing)
    async function updateAll() {
        await voter.updateAll();
        console.log(`\n Updated all strategies`);
    }

    // Buy from auction using distributeAndBuy
    async function buy(user, strategy, maxPaymentUsdc) {
        const maxPayment = parseUsdc(maxPaymentUsdc);
        await paymentToken.connect(user).approve(multicall.address, maxPayment);

        const strategyContract = await ethers.getContractAt("Strategy", strategy);
        const epochId = await strategyContract.epochId();
        const block = await ethers.provider.getBlock("latest");
        const deadline = block.timestamp + 3600;

        const balanceBefore = await revenueToken.balanceOf(user.address);
        await multicall.connect(user).distributeAndBuy(strategy, epochId, deadline, maxPayment);
        const balanceAfter = await revenueToken.balanceOf(user.address);

        const received = balanceAfter.sub(balanceBefore);
        console.log(`\n ${userName(user.address)} bought from auction`);
        console.log(`   Received: ${fmtEth(received)} WETH`);
    }

    // Claim bribe rewards
    async function claimBribes(user, bribes) {
        await voter.connect(user).claimBribes(bribes);
        console.log(`\n ${userName(user.address)} claimed bribes from ${bribes.length} bribe(s)`);
    }

    // Distribute bribe router
    async function distributeBribeRouter(strategy) {
        const bribeRouterAddr = await voter.strategy_BribeRouter(strategy);
        const bribeRouter = await ethers.getContractAt("BribeRouter", bribeRouterAddr);
        await bribeRouter.distribute();
        console.log(`\n Distributed bribe router for strategy ${strategy.slice(0, 10)}...`);
    }

    // Set bribe split
    async function setBribeSplit(bps) {
        await voter.setBribeSplit(bps);
        console.log(`\n Set bribe split to ${bps / 100}%`);
    }

    // Kill a strategy
    async function killStrategy(strategy) {
        await voter.killStrategy(strategy);
        console.log(`\n Killed strategy ${strategy.slice(0, 10)}...`);
    }

    // ==================== TIME FUNCTIONS ====================

    async function advanceTime(seconds) {
        await ethers.provider.send("evm_increaseTime", [seconds]);
        await ethers.provider.send("evm_mine");
        console.log(`\n� Advanced time by ${seconds} seconds`);
    }

    async function advanceHours(hours) {
        await advanceTime(hours * HOUR);
    }

    async function advanceDays(days) {
        await advanceTime(days * DAY);
    }

    async function advanceToNextEpoch() {
        await advanceTime(WEEK);
        console.log(`\n� Advanced to next epoch (1 week)`);
    }

    // ==================== LOGGING FUNCTIONS ====================

    async function logVoterState(account = null) {
        const state = await multicall.getVoterData(account || ethers.constants.AddressZero);
        console.log("\n========== VOTER STATE ==========");
        console.log(`Total Weight: ${fmtEth(state.totalWeight)}`);
        console.log(`Strategy Count: ${state.strategyCount}`);
        console.log(`Governance Token Supply: ${fmtEth(state.governanceTokenTotalSupply)}`);
        if (account) {
            console.log(`\n--- Account: ${userName(account)} ---`);
            console.log(`Governance Token Balance: ${fmtEth(state.accountGovernanceTokenBalance)}`);
            console.log(`Underlying Balance: ${fmtEth(state.accountUnderlyingTokenBalance)}`);
            console.log(`Used Weights: ${fmtEth(state.accountUsedWeights)}`);
        }
        console.log("==================================\n");
    }

    async function logStrategy(strategy, account = null) {
        const card = await multicall.getStrategyData(strategy, account || ethers.constants.AddressZero);
        const decimals = card.paymentTokenDecimals;
        console.log("\n========== STRATEGY DATA ==========");
        console.log(`Strategy: ${card.strategy}`);
        console.log(`Bribe: ${card.bribe}`);
        console.log(`Payment Token: ${card.paymentToken} (${decimals} decimals)`);
        console.log(`Is Alive: ${card.isAlive}`);
        console.log(`\n--- Voting ---`);
        console.log(`Weight: ${fmtEth(card.strategyWeight)}`);
        console.log(`Vote %: ${fmtEth(card.votePercent)}%`);
        console.log(`Claimable: ${fmtEth(card.claimable)} WETH`);
        console.log(`\n--- Auction ---`);
        console.log(`Epoch ID: ${card.epochId}`);
        console.log(`Epoch Period: ${card.epochPeriod / 3600} hours`);
        console.log(`Init Price: ${fmt(card.initPrice, decimals)}`);
        console.log(`Current Price: ${fmt(card.currentPrice, decimals)}`);
        console.log(`Revenue Balance: ${fmtEth(card.revenueBalance)} WETH`);
        if (account) {
            console.log(`\n--- Account: ${userName(account)} ---`);
            console.log(`Account Votes: ${fmtEth(card.accountVotes)}`);
            console.log(`Payment Token Balance: ${fmt(card.accountPaymentTokenBalance, decimals)}`);
        }
        console.log("====================================\n");
    }

    async function logBribe(strategy, account = null) {
        const card = await multicall.getBribeData(strategy, account || ethers.constants.AddressZero);
        console.log("\n========== BRIBE DATA ==========");
        console.log(`Strategy: ${card.strategy}`);
        console.log(`Bribe: ${card.bribe}`);
        console.log(`Is Alive: ${card.isAlive}`);
        console.log(`Total Supply: ${fmtEth(card.totalSupply)}`);
        console.log(`Vote Weight: ${fmtEth(card.voteWeight)}`);
        console.log(`Vote %: ${fmtEth(card.votePercent)}%`);
        console.log(`\n--- Reward Tokens ---`);
        for (let i = 0; i < card.rewardTokens.length; i++) {
            console.log(`Token ${i}: ${card.rewardTokens[i]}`);
            console.log(`  Decimals: ${card.rewardTokenDecimals[i]}`);
            console.log(`  Rewards Per Token: ${fmt(card.rewardsPerToken[i], card.rewardTokenDecimals[i])}`);
            console.log(`  Rewards Left: ${fmt(card.rewardsLeft[i], card.rewardTokenDecimals[i])}`);
            if (account) {
                console.log(`  Account Earned: ${fmt(card.accountRewardsEarned[i], card.rewardTokenDecimals[i])}`);
            }
        }
        if (account) {
            console.log(`\n--- Account: ${userName(account)} ---`);
            console.log(`Account Vote (Virtual Balance): ${fmtEth(card.accountVote)}`);
        }
        console.log("=================================\n");
    }

    async function logAllStrategies(account = null) {
        const cards = await multicall.getAllStrategiesData(account || ethers.constants.AddressZero);
        console.log("\n========== ALL STRATEGIES ==========");
        console.log(`Total Strategies: ${cards.length}`);
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const decimals = card.paymentTokenDecimals;
            console.log(`\n--- Strategy ${i + 1} ---`);
            console.log(`Address: ${card.strategy}`);
            console.log(`Alive: ${card.isAlive} | Weight: ${fmtEth(card.strategyWeight)} | Vote%: ${fmtEth(card.votePercent)}%`);
            console.log(`Revenue: ${fmtEth(card.revenueBalance)} | Claimable: ${fmtEth(card.claimable)} | Pending: ${fmtEth(card.pendingRevenue)} | Router: ${fmtEth(card.routerRevenue)}`);
            console.log(`💰 Total Potential: ${fmtEth(card.totalPotentialRevenue)} WETH`);
            console.log(`Price: ${fmt(card.currentPrice, decimals)} | Epoch: ${card.epochId}`);
            if (account) {
                console.log(`Account Votes: ${fmtEth(card.accountVotes)}`);
            }
        }
        console.log("=====================================\n");
    }

    async function logUserBalances(user) {
        const underlyingBal = await underlying.balanceOf(user.address);
        const govTokenBal = await governanceToken.balanceOf(user.address);
        const revenueBal = await revenueToken.balanceOf(user.address);
        const usdcBal = await paymentToken.balanceOf(user.address);

        console.log(`\n========== ${userName(user.address).toUpperCase()} BALANCES ==========`);
        console.log(`UNDERLYING: ${fmtEth(underlyingBal)}`);
        console.log(`Governance Token: ${fmtEth(govTokenBal)}`);
        console.log(`WETH: ${fmtEth(revenueBal)}`);
        console.log(`USDC: ${fmtUsdc(usdcBal)}`);
        console.log("==========================================\n");
    }

    async function logAllUserBalances() {
        await logUserBalances(user1);
        await logUserBalances(user2);
        await logUserBalances(user3);
        await logUserBalances(user4);
    }

    async function logVoteDistribution() {
        const data = await multicall.getVoterData(ethers.constants.AddressZero);
        const strategies = await multicall.getAllStrategiesData(ethers.constants.AddressZero);

        console.log("\n========== VOTE DISTRIBUTION ==========");
        console.log(`Total Weight: ${fmtEth(data.totalWeight)}`);
        console.log("");

        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            const weight = parseFloat(fmtEth(s.strategyWeight));
            const percent = parseFloat(fmtEth(s.votePercent));
            const barLength = Math.round(percent / 2); // 50% = 25 chars
            const bar = "█".repeat(barLength) + "░".repeat(50 - barLength);

            console.log(`Strategy ${i + 1}: ${s.strategy.slice(0, 10)}...`);
            console.log(`  [${bar}] ${percent.toFixed(1)}%`);
            console.log(`  Weight: ${weight} | Alive: ${s.isAlive}`);
        }
        console.log("========================================\n");
    }

    async function logUserVotes(user) {
        const strategies = await multicall.getAllStrategiesData(user.address);
        const voterData = await multicall.getVoterData(user.address);

        console.log(`\n========== ${userName(user.address).toUpperCase()} VOTES ==========`);
        console.log(`Voting Power: ${fmtEth(voterData.accountGovernanceTokenBalance)}`);
        console.log(`Used Weight: ${fmtEth(voterData.accountUsedWeights)}`);
        console.log("");

        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            if (s.accountVotes.gt(0)) {
                console.log(`  Strategy ${i + 1}: ${fmtEth(s.accountVotes)} votes`);
            }
        }
        console.log("==========================================\n");
    }

    async function logAuctionPrice(strategy) {
        const strategyContract = await ethers.getContractAt("Strategy", strategy);
        const price = await strategyContract.getPrice();
        const decimals = await paymentToken.decimals();
        const balance = await strategyContract.getRevenueBalance();
        console.log(`\n=� Auction Price: ${fmt(price, decimals)} | Revenue: ${fmtEth(balance)} WETH`);
    }

    // ==================== YOUR TEST HERE ====================

    it("Interactive Test", async function () {
        console.log("\n🚀 Starting Interactive Test\n");

        // Mint 100 underlying tokens to user1, user2, user3
        await underlying.mint(user1.address, parseEth(100));
        await underlying.mint(user2.address, parseEth(100));
        await underlying.mint(user3.address, parseEth(100));

        console.log("✅ Minted 100 UNDERLYING to user1, user2, user3");

        await logUserBalances(user1);
        await logUserBalances(user2);
        await logUserBalances(user3);

        // Stake 100 tokens for user1
        await stake(user1, 100);
        await logUserBalances(user1);

        // Create 3 strategies (strategy1, strategy2, strategy3)
        const strategy1 = await createStrategy(paymentToken);   // USDC
        const strategy2 = await createStrategy(paymentToken);   // USDC
        const strategy3 = await createStrategy(paymentToken2);  // DAI

        // Show all strategies
        await logAllStrategies();

        // User1 votes 100% on strategy1
        await vote(user1, [strategy1.strategy], [100]);
        await logAllStrategies();

        // Send 10 WETH revenue and distribute
        await sendRevenue(10);
        await distributeAll();
        await logAllStrategies();

        // User2 stakes 100 and votes all on strategy2
        await stake(user2, 100);
        await vote(user2, [strategy2.strategy], [100]);
        await logAllStrategies();

        // Send another 10 WETH and distribute
        await sendRevenue(10);
        await distributeAll();
        await logAllStrategies();

        // ===== CLAIMABLE WITHOUT DISTRIBUTING =====
        console.log("\n\n🔍 Testing claimable without distributing...\n");

        // Send 100 WETH revenue - this updates the global index
        await sendRevenue(100);

        // Check strategies - claimable should still be 0 (not updated yet)
        console.log("\n📊 After sendRevenue (before updateStrategy):");
        await logAllStrategies();

        // Now update strategies - this calculates claimable from index
        await updateStrategy(strategy1.strategy);
        await updateStrategy(strategy2.strategy);

        // Check again - now claimable should show the pending amounts
        console.log("\n📊 After updateStrategy (claimable calculated):");
        await logAllStrategies();

        // Distribute only to strategy1
        console.log("\n\n💸 Distributing only to strategy1...\n");
        await distribute(strategy1.strategy);
        await logAllStrategies();

        // ===== TEST TOTAL POTENTIAL REVENUE =====
        console.log("\n\n📊 Testing Total Potential Revenue breakdown...\n");

        // Send 50 WETH to router (don't flush)
        await sendRevenueToRouter(50);
        console.log("\n📊 After sending to router (not flushed):");
        await logAllStrategies();

        // ===== SET BRIBE SPLIT =====
        await setBribeSplit(4000); // 40%

        // ===== AUCTION BUYS =====
        console.log("\n\n🛒 Testing Auction Buys...\n");

        // First flush the router so all revenue is available
        await flush();
        await logAllStrategies();

        // User3 buys from strategy1 auction
        console.log("\n--- User3 buying from Strategy1 ---");
        await logUserBalances(user3);
        await buy(user3, strategy1.strategy, 10000); // max 10k USDC
        await logUserBalances(user3);
        await logAllStrategies();

        // User4 buys from strategy2 auction
        console.log("\n--- User4 buying from Strategy2 ---");
        await logUserBalances(user4);
        await buy(user4, strategy2.strategy, 10000); // max 10k USDC
        await logUserBalances(user4);
        await logAllStrategies();

        // ===== CHECK BRIBE REWARDS =====
        console.log("\n\n💰 Checking Bribe Rewards...\n");

        // Bribe rewards are in BribeRouter, need to distribute to Bribe
        console.log("Before distributing BribeRouters:");
        await logBribe(strategy1.strategy, user1.address);
        await logBribe(strategy2.strategy, user2.address);

        // Distribute bribe routers
        await distributeBribeRouter(strategy1.strategy);
        await distributeBribeRouter(strategy2.strategy);

        console.log("\nAfter distributing BribeRouters:");
        await logBribe(strategy1.strategy, user1.address);
        await logBribe(strategy2.strategy, user2.address);

        // ===== VOTE DISTRIBUTION =====
        console.log("\n\n📊 Vote Distribution...\n");
        await logVoteDistribution();
        await logUserVotes(user1);
        await logUserVotes(user2);

        // ===== ADVANCE TO NEW EPOCH =====
        console.log("\n\n⏰ Advancing to new epoch...\n");
        await advanceToNextEpoch();

        // Check bribe rewards after time passed
        console.log("Bribe rewards after 1 week:");
        await logBribe(strategy1.strategy, user1.address);
        await logBribe(strategy2.strategy, user2.address);

        // ===== USER3 JOINS =====
        console.log("\n\n👤 User3 stakes and votes...\n");

        await logVoteDistribution();

        await stake(user3, 100);
        await vote(user3, [strategy1.strategy, strategy2.strategy, strategy3.strategy], [33, 33, 34]);

        await logVoteDistribution();
        await logUserVotes(user3);
        await logAllStrategies();

        // ===== SEND MORE REVENUE =====
        console.log("\n\n💸 Sending 300 WETH revenue...\n");
        await sendRevenue(300);
        await updateAll();
        await logAllStrategies();

        // ===== SEND EVEN MORE REVENUE =====
        console.log("\n\n💸 Sending another 300 WETH revenue...\n");
        await sendRevenue(300);
        await updateAll();
        await logAllStrategies();

        // ===== DISTRIBUTE STRATEGY3 ONLY, THEN MORE REVENUE =====
        console.log("\n\n💸 Distributing Strategy3 only, then sending 300 more WETH...\n");
        await distribute(strategy3.strategy);
        await logAllStrategies();

        await sendRevenue(300);
        await logAllStrategies();

        // ===== DISTRIBUTE STRATEGY2 =====
        console.log("\n\n💸 Distributing Strategy2...\n");
        await distribute(strategy2.strategy);
        await logAllStrategies();

        // ===== NOTIFY MORE REVENUE =====
        console.log("\n\n💸 Sending 300 more WETH...\n");
        await sendRevenue(300);
        await logAllStrategies();

        // ===== SEND TO ROUTER WITHOUT FLUSHING =====
        console.log("\n\n💸 Sending 300 WETH to router (no flush)...\n");
        await sendRevenueToRouter(300);
        await logAllStrategies();

        // ===== DISTRIBUTE ALL =====
        console.log("\n\n💸 Distributing all strategies...\n");
        await distributeAll();
        await logAllStrategies();

        // ===== CLAIM BRIBE REWARDS =====
        console.log("\n\n💰 Claiming Bribe Rewards...\n");

        // Check user1 and user2 bribe earnings before claiming
        console.log("Before claiming:");
        await logBribe(strategy1.strategy, user1.address);
        await logBribe(strategy2.strategy, user2.address);

        // Check USDC balances before
        console.log("USDC balances before claiming:");
        await logUserBalances(user1);
        await logUserBalances(user2);

        // User1 claims from strategy1's bribe
        await claimBribes(user1, [strategy1.bribe]);

        // User2 claims from strategy2's bribe
        await claimBribes(user2, [strategy2.bribe]);

        // Check USDC balances after
        console.log("\nUSDC balances after claiming:");
        await logUserBalances(user1);
        await logUserBalances(user2);

        // Check bribe earnings after claiming
        console.log("After claiming:");
        await logBribe(strategy1.strategy, user1.address);
        await logBribe(strategy2.strategy, user2.address);

        // ===== USER1 UNSTAKES =====
        console.log("\n\n🔓 User1 unstaking...\n");

        // Show vote distribution before
        console.log("Before unstaking:");
        await logVoteDistribution();
        await logUserVotes(user1);
        await logUserBalances(user1);

        // User1 must reset votes before unstaking
        await reset(user1);

        // User1 unstakes all 100 tokens
        await unstake(user1, 100);

        // Show after
        console.log("\nAfter unstaking:");
        await logVoteDistribution();
        await logUserVotes(user1);
        await logUserBalances(user1);

        // ===== STRESS TESTING =====
        console.log("\n\n🔥🔥🔥 STRESS TESTING - TRYING TO BREAK THINGS 🔥🔥🔥\n");

        // ----- TEST 1: Distribute with zero weight strategy -----
        console.log("\n--- TEST 1: Distribute to strategy with 0 votes ---");
        // Kill strategy3 so it has no weight
        await killStrategy(strategy3.strategy);
        await logAllStrategies();

        // Try distributing to killed strategy
        try {
            await distribute(strategy3.strategy);
            console.log("✅ Distribute to killed strategy succeeded");
        } catch (e) {
            console.log("❌ Distribute to killed strategy failed:", e.message.slice(0, 100));
        }

        // ----- TEST 2: Buy from killed strategy -----
        console.log("\n--- TEST 2: Buy from killed strategy ---");
        try {
            await buy(user4, strategy3.strategy, 1000);
            console.log("✅ Buy from killed strategy succeeded");
        } catch (e) {
            console.log("❌ Buy from killed strategy failed:", e.message.slice(0, 100));
        }

        // ----- TEST 3: Double distribute in same block -----
        console.log("\n--- TEST 3: Double distributeAll ---");
        await sendRevenue(100);
        await distributeAll();
        await logAllStrategies();
        // Distribute again with no new revenue
        await distributeAll();
        await logAllStrategies();
        console.log("✅ Double distribute didn't break anything");

        // ----- TEST 4: Buy with 0 maxPayment -----
        console.log("\n--- TEST 4: Buy with 0 maxPayment ---");
        try {
            const strategyContract = await ethers.getContractAt("Strategy", strategy1.strategy);
            const epochId = await strategyContract.epochId();
            const block = await ethers.provider.getBlock("latest");
            await paymentToken.connect(user4).approve(multicall.address, 0);
            await multicall.connect(user4).distributeAndBuy(strategy1.strategy, epochId, block.timestamp + 3600, 0);
            console.log("✅ Buy with 0 maxPayment succeeded (price must be 0)");
        } catch (e) {
            console.log("❌ Buy with 0 maxPayment failed:", e.message.slice(0, 100));
        }

        // ----- TEST 5: Buy with expired deadline -----
        console.log("\n--- TEST 5: Buy with expired deadline ---");
        try {
            const strategyContract = await ethers.getContractAt("Strategy", strategy1.strategy);
            const epochId = await strategyContract.epochId();
            await paymentToken.connect(user4).approve(multicall.address, parseUsdc(1000));
            await multicall.connect(user4).distributeAndBuy(strategy1.strategy, epochId, 1, parseUsdc(1000)); // deadline = 1 (expired)
            console.log("✅ Buy with expired deadline succeeded");
        } catch (e) {
            console.log("❌ Buy with expired deadline failed:", e.message.slice(0, 100));
        }

        // ----- TEST 6: Buy with wrong epochId -----
        console.log("\n--- TEST 6: Buy with wrong epochId ---");
        try {
            const block = await ethers.provider.getBlock("latest");
            await paymentToken.connect(user4).approve(multicall.address, parseUsdc(1000));
            await multicall.connect(user4).distributeAndBuy(strategy1.strategy, 999, block.timestamp + 3600, parseUsdc(1000));
            console.log("✅ Buy with wrong epochId succeeded");
        } catch (e) {
            console.log("❌ Buy with wrong epochId failed:", e.message.slice(0, 100));
        }

        // ----- TEST 7: Massive revenue flood -----
        console.log("\n--- TEST 7: Massive revenue flood (1M WETH) ---");
        await revenueToken.mint(owner.address, parseEth(1000000));
        await sendRevenue(1000000);
        await distributeAll();
        await logAllStrategies();
        console.log("✅ Massive revenue handled");

        // ----- TEST 8: Rapid epoch advancement + buys -----
        console.log("\n--- TEST 8: Rapid epoch cycling ---");
        for (let i = 0; i < 5; i++) {
            await advanceHours(2); // Advance past epoch period
            try {
                await buy(user4, strategy1.strategy, 100000);
                console.log(`  Epoch ${i + 1}: ✅ Buy succeeded`);
            } catch (e) {
                console.log(`  Epoch ${i + 1}: ❌ Buy failed - ${e.message.slice(0, 50)}`);
            }
        }
        await logAllStrategies();

        // ----- TEST 9: Vote/Reset spam -----
        console.log("\n--- TEST 9: Vote changes in same epoch ---");
        // User2 tries to change votes in same epoch
        try {
            await vote(user2, [strategy1.strategy], [100]);
            console.log("✅ User2 changed vote succeeded");
        } catch (e) {
            console.log("❌ User2 change vote failed:", e.message.slice(0, 100));
        }

        // ----- TEST 10: Claim from empty bribe -----
        console.log("\n--- TEST 10: Claim from bribe with no rewards ---");
        try {
            await claimBribes(user3, [strategy1.bribe, strategy2.bribe, strategy3.bribe]);
            console.log("✅ Claim from empty bribes succeeded");
        } catch (e) {
            console.log("❌ Claim from empty bribes failed:", e.message.slice(0, 100));
        }

        // ----- TEST 11: distributeAllAndBuy -----
        console.log("\n--- TEST 11: distributeAllAndBuy ---");
        await sendRevenueToRouter(500);
        await logAllStrategies();

        const strategyContract = await ethers.getContractAt("Strategy", strategy2.strategy);
        const epochId = await strategyContract.epochId();
        const block = await ethers.provider.getBlock("latest");
        await paymentToken.connect(user3).approve(multicall.address, parseUsdc(100000));

        const balBefore = await revenueToken.balanceOf(user3.address);
        await multicall.connect(user3).distributeAllAndBuy(strategy2.strategy, epochId, block.timestamp + 3600, parseUsdc(100000));
        const balAfter = await revenueToken.balanceOf(user3.address);

        console.log(`User3 received: ${fmtEth(balAfter.sub(balBefore))} WETH from distributeAllAndBuy`);
        await logAllStrategies();

        // ----- TEST 12: Zero weight distribution math -----
        console.log("\n--- TEST 12: All users unstake (zero total weight) ---");
        // Advance to new epoch so users can reset
        await advanceToNextEpoch();

        // Reset all votes
        await reset(user2);
        await reset(user3);

        await logVoteDistribution();

        // Send revenue with 0 total weight
        await sendRevenue(100);
        await logAllStrategies();
        console.log("✅ Zero weight revenue handled");

        // ----- TEST 13: Re-add votes after zero weight -----
        console.log("\n--- TEST 13: Re-vote after zero weight period ---");
        // Need new epoch since user2 voted in Test 9
        await advanceToNextEpoch();
        await vote(user2, [strategy1.strategy, strategy2.strategy], [50, 50]);
        await logVoteDistribution();
        await sendRevenue(100);
        await distributeAll();
        await logAllStrategies();

        // ----- FINAL STATE -----
        console.log("\n\n📊 FINAL STATE 📊");
        await logAllStrategies();
        await logVoteDistribution();
        await logAllUserBalances();

        console.log("\n\n✅✅✅ STRESS TESTING COMPLETE ✅✅✅\n");

        // ===== ADD MORE BELOW =====


    });
});
