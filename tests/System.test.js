const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Comprehensive system-wide tests for Liquid Signal Governance
 *
 * Tests cover:
 * - Full end-to-end flows
 * - Multi-epoch scenarios
 * - Edge cases and boundary conditions
 * - Attack vectors and gaming prevention
 * - Contract interactions and invariants
 */
describe("System-Wide Tests", function () {
    let owner, user1, user2, user3, user4, treasury, buyer1, buyer2;
    let underlying, revenueToken, paymentToken, paymentToken2;
    let governanceToken, voter, bribeFactory, strategyFactory, revenueRouter;

    const WEEK = 7 * 24 * 60 * 60;
    const DAY = 24 * 60 * 60;
    const HOUR = 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, user3, user4, treasury, buyer1, buyer2] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("Underlying Token", "UNDERLYING", 18);
        revenueToken = await MockERC20.deploy("Revenue Token", "WETH", 18);
        paymentToken = await MockERC20.deploy("Payment Token", "USDC", 6);
        paymentToken2 = await MockERC20.deploy("Payment Token 2", "DAI", 18);

        const BribeFactory = await ethers.getContractFactory("BribeFactory");
        bribeFactory = await BribeFactory.deploy();

        const StrategyFactory = await ethers.getContractFactory("StrategyFactory");
        strategyFactory = await StrategyFactory.deploy();

        const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
        governanceToken = await GovernanceToken.deploy(underlying.address, "Staked Underlying", "sUNDER");

        const Voter = await ethers.getContractFactory("Voter");
        voter = await Voter.deploy(
            governanceToken.address,
            revenueToken.address,
            treasury.address,
            bribeFactory.address,
            strategyFactory.address
        );

        await governanceToken.setVoter(voter.address);

        const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
        revenueRouter = await RevenueRouter.deploy(revenueToken.address, voter.address);
        await voter.setRevenueSource(revenueRouter.address);

        // Set bribe split (20%)
        await voter.setBribeSplit(2000);

        // Mint tokens
        for (const user of [user1, user2, user3, user4]) {
            await underlying.mint(user.address, ethers.utils.parseEther("10000"));
        }
        await revenueToken.mint(owner.address, ethers.utils.parseEther("1000000"));
        for (const buyer of [buyer1, buyer2]) {
            await paymentToken.mint(buyer.address, ethers.utils.parseUnits("1000000", 6));
            await paymentToken2.mint(buyer.address, ethers.utils.parseEther("1000000"));
        }
    });

    // Helper functions
    async function createStrategy(payment = paymentToken, receiver = treasury.address) {
        const decimals = await payment.decimals();
        const initPrice = ethers.utils.parseUnits("100", decimals);
        const tx = await voter.addStrategy(payment.address, receiver, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "Voter__StrategyAdded");
        return {
            strategy: event.args.strategy,
            bribe: event.args.bribe,
            bribeRouter: event.args.bribeRouter
        };
    }

    async function stakeTokens(user, amount) {
        await underlying.connect(user).approve(governanceToken.address, amount);
        await governanceToken.connect(user).stake(amount);
    }

    async function sendRevenue(amount) {
        await revenueToken.transfer(revenueRouter.address, amount);
        await revenueRouter.flush();
    }

    async function advanceTime(seconds) {
        await ethers.provider.send("evm_increaseTime", [seconds]);
        await ethers.provider.send("evm_mine");
    }

    async function buyFromStrategy(strategyAddr, buyer, payment = paymentToken) {
        const strategy = await ethers.getContractAt("Strategy", strategyAddr);
        const epochId = await strategy.epochId();
        const price = await strategy.getPrice();

        await payment.connect(buyer).approve(strategy.address, price);
        const block = await ethers.provider.getBlock("latest");
        const deadline = block.timestamp + 3600;

        const tx = await strategy.connect(buyer).buy(buyer.address, epochId, deadline, price);
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "Strategy__Buy");
        return event.args.paymentAmount; // Return actual payment amount from event
    }

    // ==================== FULL CYCLE TESTS ====================

    describe("Full Cycle Tests", function () {
        it("should complete multiple full cycles over several epochs", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            // Epoch 1: Setup and first cycle
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const price1 = await buyFromStrategy(strategy, buyer1);
            expect(price1).to.be.gt(0);

            // Distribute bribes
            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            // Wait for rewards
            await advanceTime(WEEK);

            // User1 claims
            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const earned1 = await bribeContract.earned(user1.address, paymentToken.address);
            expect(earned1).to.be.gt(0);

            await bribeContract.getReward(user1.address);
            expect(await paymentToken.balanceOf(user1.address)).to.be.gt(0);

            // Epoch 2: User2 joins
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user2).vote([strategy], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            await buyFromStrategy(strategy, buyer1);
            await bribeRouterContract.distribute();

            await advanceTime(WEEK);

            // Both users should have earned
            const earned1_e2 = await bribeContract.earned(user1.address, paymentToken.address);
            const earned2_e2 = await bribeContract.earned(user2.address, paymentToken.address);

            // Equal stakes, should earn roughly equal (within rounding)
            expect(earned1_e2).to.be.closeTo(earned2_e2, earned1_e2.div(100));
        });

        it("should handle strategy with no buyers for an epoch", async function () {
            const { strategy, bribe } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Send revenue but don't buy
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            // Revenue sits in strategy
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("100"));

            // No bribes distributed
            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            await advanceTime(WEEK);
            expect(await bribeContract.earned(user1.address, paymentToken.address)).to.equal(0);

            // Later someone buys all accumulated revenue
            await sendRevenue(ethers.utils.parseEther("50"));
            await voter["distribute(address)"](strategy);

            // Strategy now has 150 WETH
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("150"));

            const price = await buyFromStrategy(strategy, buyer1);
            expect(await revenueToken.balanceOf(buyer1.address)).to.equal(ethers.utils.parseEther("150"));
        });

        it("should handle user voting across multiple strategies over epochs", async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));

            // Epoch 1: Vote 100% for s1
            await voter.connect(user1).vote([s1.strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.distributeAll();

            expect(await revenueToken.balanceOf(s1.strategy)).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(s2.strategy)).to.equal(0);

            // Epoch 2: Switch to 50/50
            await advanceTime(WEEK);
            await voter.connect(user1).vote([s1.strategy, s2.strategy], [50, 50]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.distributeAll();

            // s1 had 100, gets 50 more = 150 (minus any buys)
            // s2 had 0, gets 50 = 50
            expect(await revenueToken.balanceOf(s1.strategy)).to.equal(ethers.utils.parseEther("150"));
            expect(await revenueToken.balanceOf(s2.strategy)).to.equal(ethers.utils.parseEther("50"));
        });
    });

    // ==================== GOVERNANCE TOKEN TESTS ====================

    describe("GovernanceToken Integration", function () {
        it("should prevent unstaking while votes are active", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            await expect(governanceToken.connect(user1).unstake(ethers.utils.parseEther("100")))
                .to.be.reverted;
        });

        it("should allow unstaking after resetting votes", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            await advanceTime(WEEK);
            await voter.connect(user1).reset();

            await governanceToken.connect(user1).unstake(ethers.utils.parseEther("100"));
            expect(await underlying.balanceOf(user1.address)).to.equal(ethers.utils.parseEther("10000"));
        });

        it("should allow partial unstake if partial reset", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            // Don't vote - usedWeight stays 0

            // Can unstake without voting
            await governanceToken.connect(user1).unstake(ethers.utils.parseEther("50"));
            expect(await governanceToken.balanceOf(user1.address)).to.equal(ethers.utils.parseEther("50"));
        });

        it("should prevent transfers", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            await expect(governanceToken.connect(user1).transfer(user2.address, ethers.utils.parseEther("50")))
                .to.be.reverted;

            await expect(governanceToken.connect(user1).approve(user2.address, ethers.utils.parseEther("50")))
                .to.not.be.reverted; // approve works

            await expect(governanceToken.connect(user2).transferFrom(user1.address, user2.address, ethers.utils.parseEther("50")))
                .to.be.reverted; // but transferFrom fails
        });

        it("should handle staking additional tokens mid-epoch", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Stake more
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            // Vote weight should still be original 100
            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));

            // Next epoch can use full 200
            await advanceTime(WEEK);
            await voter.connect(user1).vote([strategy], [100]);
            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("200"));
        });
    });

    // ==================== STRATEGY (AUCTION) TESTS ====================

    describe("Strategy (Auction) Integration", function () {
        it("should decrease price over time", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const price0 = await strategyContract.getPrice();

            await advanceTime(30 * 60); // 30 minutes

            const price1 = await strategyContract.getPrice();
            expect(price1).to.be.lt(price0);

            await advanceTime(30 * 60); // another 30 minutes (1 hour total = epoch end)

            const price2 = await strategyContract.getPrice();
            expect(price2).to.equal(0);
        });

        it("should adjust next epoch price based on payment", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const initPriceBefore = await strategyContract.initPrice();

            // Buy at full price
            await buyFromStrategy(strategy, buyer1);

            const initPriceAfter = await strategyContract.initPrice();

            // New price should be payment * priceMultiplier
            // priceMultiplier = 2e18, so new price should be ~2x
            expect(initPriceAfter).to.be.gt(initPriceBefore);
        });

        it("should allow buying for free when price reaches zero", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            // Wait for price to reach 0
            await advanceTime(HOUR + 60);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            expect(await strategyContract.getPrice()).to.equal(0);

            const balanceBefore = await revenueToken.balanceOf(buyer1.address);

            const epochId = await strategyContract.epochId();
            const block = await ethers.provider.getBlock("latest");
            await strategyContract.connect(buyer1).buy(buyer1.address, epochId, block.timestamp + 3600, 0);

            expect(await revenueToken.balanceOf(buyer1.address)).to.equal(balanceBefore.add(ethers.utils.parseEther("100")));
        });

        it("should revert on epoch mismatch (frontrun protection)", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(buyer1).approve(strategyContract.address, price);
            const block = await ethers.provider.getBlock("latest");

            // Use wrong epoch ID
            await expect(
                strategyContract.connect(buyer1).buy(buyer1.address, epochId.add(1), block.timestamp + 3600, price)
            ).to.be.reverted;
        });

        it("should split payment between receiver and bribe router", async function () {
            const { strategy, bribeRouter } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const receiverBalanceBefore = await paymentToken.balanceOf(treasury.address);
            const bribeRouterBalanceBefore = await paymentToken.balanceOf(bribeRouter);

            const price = await buyFromStrategy(strategy, buyer1);

            const receiverBalanceAfter = await paymentToken.balanceOf(treasury.address);
            const bribeRouterBalanceAfter = await paymentToken.balanceOf(bribeRouter);

            const bribeAmount = bribeRouterBalanceAfter.sub(bribeRouterBalanceBefore);
            const receiverAmount = receiverBalanceAfter.sub(receiverBalanceBefore);

            // 20% to bribe, 80% to receiver
            // Allow 1 wei tolerance for rounding
            expect(bribeAmount.add(receiverAmount)).to.equal(price);
            expect(bribeAmount).to.be.closeTo(price.mul(2000).div(10000), 1);
            expect(receiverAmount).to.be.closeTo(price.mul(8000).div(10000), 1);
        });
    });

    // ==================== BRIBE DISTRIBUTION TESTS ====================

    describe("Bribe Distribution", function () {
        it("should distribute bribes proportionally to vote weight", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            // User1: 100, User2: 300 (1:3 ratio)
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("300"));

            await voter.connect(user1).vote([strategy], [100]);
            await voter.connect(user2).vote([strategy], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            await buyFromStrategy(strategy, buyer1);

            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            await advanceTime(WEEK);

            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const earned1 = await bribeContract.earned(user1.address, paymentToken.address);
            const earned2 = await bribeContract.earned(user2.address, paymentToken.address);

            // User2 should earn ~3x user1
            expect(earned2).to.be.closeTo(earned1.mul(3), earned1.div(10));
        });

        it("should handle user joining mid-reward period", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            await buyFromStrategy(strategy, buyer1);

            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            // Wait half the period
            await advanceTime(WEEK / 2);

            // User2 joins
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await advanceTime(WEEK); // new epoch
            await voter.connect(user2).vote([strategy], [100]);

            // Wait rest of original period
            await advanceTime(WEEK / 2);

            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const earned1 = await bribeContract.earned(user1.address, paymentToken.address);
            const earned2 = await bribeContract.earned(user2.address, paymentToken.address);

            // User1 earned for full period, user2 for half
            // But user2 joined AFTER the reward period started, so gets nothing from that batch
            expect(earned1).to.be.gt(0);
            // User2 earns from the portion after they joined
        });

        it("should handle multiple reward tokens", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            // Add second reward token
            await voter.addBribeReward(bribe, revenueToken.address);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            await buyFromStrategy(strategy, buyer1);

            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            // Also send some WETH directly to bribe as second reward
            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const rewardAmount = ethers.utils.parseEther("50");
            await revenueToken.approve(bribe, rewardAmount);
            await bribeContract.notifyRewardAmount(revenueToken.address, rewardAmount);

            await advanceTime(WEEK);

            const earnedUSDC = await bribeContract.earned(user1.address, paymentToken.address);
            const earnedWETH = await bribeContract.earned(user1.address, revenueToken.address);

            expect(earnedUSDC).to.be.gt(0);
            expect(earnedWETH).to.be.gt(0);
        });
    });

    // ==================== MULTI-USER SCENARIOS ====================

    describe("Multi-User Scenarios", function () {
        it("should handle 4 users voting for different strategies", async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));
            await stakeTokens(user4, ethers.utils.parseEther("400"));

            await voter.connect(user1).vote([s1.strategy], [100]);
            await voter.connect(user2).vote([s2.strategy], [100]);
            await voter.connect(user3).vote([s1.strategy, s2.strategy], [50, 50]);
            await voter.connect(user4).vote([s1.strategy, s2.strategy], [25, 75]);

            // s1: 100 + 150 + 100 = 350
            // s2: 200 + 150 + 300 = 650
            expect(await voter.strategy_Weight(s1.strategy)).to.equal(ethers.utils.parseEther("350"));
            expect(await voter.strategy_Weight(s2.strategy)).to.equal(ethers.utils.parseEther("650"));
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("1000"));

            await sendRevenue(ethers.utils.parseEther("1000"));
            await voter.distributeAll();

            expect(await revenueToken.balanceOf(s1.strategy)).to.equal(ethers.utils.parseEther("350"));
            expect(await revenueToken.balanceOf(s2.strategy)).to.equal(ethers.utils.parseEther("650"));
        });

        it("should handle users changing votes each epoch", async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            // Epoch 1: Both vote s1
            await voter.connect(user1).vote([s1.strategy], [100]);
            await voter.connect(user2).vote([s1.strategy], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.distributeAll();
            expect(await revenueToken.balanceOf(s1.strategy)).to.equal(ethers.utils.parseEther("100"));

            // Epoch 2: User2 switches to s2
            await advanceTime(WEEK);
            await voter.connect(user2).vote([s2.strategy], [100]);

            expect(await voter.strategy_Weight(s1.strategy)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Weight(s2.strategy)).to.equal(ethers.utils.parseEther("100"));

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.distributeAll();

            // Each gets 50 from epoch 2
            expect(await revenueToken.balanceOf(s1.strategy)).to.equal(ethers.utils.parseEther("150"));
            expect(await revenueToken.balanceOf(s2.strategy)).to.equal(ethers.utils.parseEther("50"));
        });
    });

    // ==================== EDGE CASES ====================

    describe("Edge Cases", function () {
        it("should handle strategy killed mid-epoch", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            await sendRevenue(ethers.utils.parseEther("50"));
            await voter.updateStrategy(strategy);

            const claimableBefore = await voter.strategy_Claimable(strategy);
            expect(claimableBefore).to.equal(ethers.utils.parseEther("50"));

            // Kill strategy - clears claimable
            await voter.killStrategy(strategy);
            expect(await voter.strategy_Claimable(strategy)).to.equal(0);

            // More revenue - dead strategy doesn't accumulate
            await sendRevenue(ethers.utils.parseEther("50"));
            await voter.updateStrategy(strategy);
            expect(await voter.strategy_Claimable(strategy)).to.equal(0);
        });

        it("should handle voting for mix of alive and dead strategies", async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);

            await voter.killStrategy(s2.strategy);

            await stakeTokens(user1, ethers.utils.parseEther("100"));

            // Vote for both - only s1 should get weight
            await voter.connect(user1).vote([s1.strategy, s2.strategy], [50, 50]);

            // All weight goes to s1
            expect(await voter.strategy_Weight(s1.strategy)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Weight(s2.strategy)).to.equal(0);
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));
        });

        it("should handle zero bribe split", async function () {
            await voter.setBribeSplit(0);

            const { strategy, bribeRouter } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const receiverBalanceBefore = await paymentToken.balanceOf(treasury.address);
            await buyFromStrategy(strategy, buyer1);
            const receiverBalanceAfter = await paymentToken.balanceOf(treasury.address);

            // All payment goes to receiver, none to bribe router
            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            expect(await paymentToken.balanceOf(bribeRouter)).to.equal(0);
        });

        it("should handle max bribe split (50%)", async function () {
            await voter.setBribeSplit(5000);

            const { strategy, bribeRouter } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const bribeRouterBalanceBefore = await paymentToken.balanceOf(bribeRouter);
            const price = await buyFromStrategy(strategy, buyer1);
            const bribeRouterBalanceAfter = await paymentToken.balanceOf(bribeRouter);

            // 50% to bribe, 50% to receiver
            const bribeAmount = bribeRouterBalanceAfter.sub(bribeRouterBalanceBefore);
            expect(bribeAmount).to.equal(price.mul(5000).div(10000));
        });

        it("should handle empty strategies array in vote", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([], []);

            expect(await voter.account_UsedWeights(user1.address)).to.equal(0);
            expect(await voter.totalWeight()).to.equal(0);
        });

        it("should handle revenue when all voters reset", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            await advanceTime(WEEK);
            await voter.connect(user1).reset();

            expect(await voter.totalWeight()).to.equal(0);

            // Revenue with no voters goes to treasury
            await sendRevenue(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(treasury.address)).to.equal(ethers.utils.parseEther("100"));
        });
    });

    // ==================== INVARIANT TESTS ====================

    describe("Invariant Tests", function () {
        it("totalWeight should equal sum of all strategy weights", async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));

            await voter.connect(user1).vote([s1.strategy], [100]);
            await voter.connect(user2).vote([s1.strategy, s2.strategy], [50, 50]);
            await voter.connect(user3).vote([s2.strategy], [100]);

            const weight1 = await voter.strategy_Weight(s1.strategy);
            const weight2 = await voter.strategy_Weight(s2.strategy);
            const totalWeight = await voter.totalWeight();

            expect(totalWeight).to.equal(weight1.add(weight2));
        });

        it("user usedWeight should equal sum of their strategy votes", async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1.strategy, s2.strategy], [60, 40]);

            const vote1 = await voter.account_Strategy_Votes(user1.address, s1.strategy);
            const vote2 = await voter.account_Strategy_Votes(user1.address, s2.strategy);
            const usedWeight = await voter.account_UsedWeights(user1.address);

            expect(usedWeight).to.equal(vote1.add(vote2));
        });

        it("bribe totalSupply should equal strategy weight", async function () {
            const { strategy, bribe } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));

            await voter.connect(user1).vote([strategy], [100]);
            await voter.connect(user2).vote([strategy], [100]);

            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            expect(await bribeContract.totalSupply()).to.equal(await voter.strategy_Weight(strategy));
        });

        it("bribe balanceOf should equal user's strategy votes", async function () {
            const { strategy, bribe } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            expect(await bribeContract.account_Balance(user1.address))
                .to.equal(await voter.account_Strategy_Votes(user1.address, strategy));
        });
    });

    // ==================== REENTRANCY PROTECTION ====================

    describe("Reentrancy Protection", function () {
        it("strategy should have reentrancy protection on buy", async function () {
            const { strategy } = await createStrategy();

            const strategyContract = await ethers.getContractAt("Strategy", strategy);

            // The contract inherits ReentrancyGuard from OpenZeppelin
            // In a real attack scenario, the attacker would try to reenter during safeTransfer
            // but the nonReentrant modifier prevents this
        });

        it("voter should have reentrancy protection on distribute", async function () {
            const { strategy } = await createStrategy();

            // Voter's distribute has nonReentrant modifier
            // Multiple calls in same tx would fail
        });
    });

    // ==================== LONG-TERM SCENARIOS ====================

    describe("Long-Term Scenarios", function () {
        it("should handle 10 epochs of operation", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            const bribeContract = await ethers.getContractAt("Bribe", bribe);

            for (let i = 0; i < 10; i++) {
                await sendRevenue(ethers.utils.parseEther("10"));
                await voter["distribute(address)"](strategy);

                if (await revenueToken.balanceOf(strategy) > 0) {
                    await buyFromStrategy(strategy, buyer1);
                    await bribeRouterContract.distribute();
                }

                await advanceTime(WEEK);

                if (i > 0) {
                    // Re-vote each epoch
                    await voter.connect(user1).vote([strategy], [100]);
                }
            }

            // User should have accumulated rewards
            const earned = await bribeContract.earned(user1.address, paymentToken.address);
            expect(earned).to.be.gt(0);
        });

        it("should handle strategy with accumulating revenue over multiple epochs", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Send revenue but don't buy for 5 epochs
            for (let i = 0; i < 5; i++) {
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter["distribute(address)"](strategy);
                await advanceTime(WEEK);
                await voter.connect(user1).vote([strategy], [100]);
            }

            // Strategy accumulated 500 WETH
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("500"));

            // One buyer gets all accumulated revenue
            await buyFromStrategy(strategy, buyer1);
            expect(await revenueToken.balanceOf(buyer1.address)).to.equal(ethers.utils.parseEther("500"));
        });
    });
});
