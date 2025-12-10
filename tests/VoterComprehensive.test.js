const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Comprehensive Voter Contract Tests
 *
 * Deep testing of the Voter contract - the core governance contract that:
 * 1. Manages strategies (add, kill, track)
 * 2. Handles voting (vote, reset, epoch enforcement)
 * 3. Distributes revenue proportionally based on weights
 * 4. Integrates with Bribe contracts for voter rewards
 * 5. Maintains critical invariants
 */
describe("Voter Contract - Comprehensive Tests", function () {
    let owner, user1, user2, user3, user4, user5, treasury, attacker;
    let underlying, revenueToken, paymentToken, paymentToken2, paymentToken3;
    let governanceToken, voter, bribeFactory, strategyFactory, revenueRouter;

    const WEEK = 7 * 24 * 60 * 60;
    const DAY = 24 * 60 * 60;
    const HOUR = 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, user3, user4, user5, treasury, attacker] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("Underlying Token", "UNDERLYING", 18);
        revenueToken = await MockERC20.deploy("Revenue Token", "WETH", 18);
        paymentToken = await MockERC20.deploy("Payment Token", "USDC", 6);
        paymentToken2 = await MockERC20.deploy("Payment Token 2", "DAI", 18);
        paymentToken3 = await MockERC20.deploy("Payment Token 3", "USDT", 6);

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

        // Mint tokens to users
        for (const user of [user1, user2, user3, user4, user5, attacker]) {
            await underlying.mint(user.address, ethers.utils.parseEther("100000"));
        }
        await revenueToken.mint(owner.address, ethers.utils.parseEther("10000000"));
    });

    // Helper functions
    async function createStrategy(payment = paymentToken, receiver = treasury.address) {
        const decimals = await payment.decimals();
        const initPrice = ethers.utils.parseUnits("100", decimals);
        const tx = await voter.addStrategy(
            payment.address,
            receiver,
            initPrice,
            HOUR,
            ethers.utils.parseEther("2"),
            initPrice
        );
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

    async function advanceToNextEpoch() {
        await advanceTime(WEEK);
    }

    // ==================== CONSTRUCTOR & INITIALIZATION ====================

    describe("Constructor and Initialization", function () {
        it("should set all immutable variables correctly", async function () {
            expect(await voter.governanceToken()).to.equal(governanceToken.address);
            expect(await voter.revenueToken()).to.equal(revenueToken.address);
            expect(await voter.treasury()).to.equal(treasury.address);
            expect(await voter.bribeFactory()).to.equal(bribeFactory.address);
            expect(await voter.strategyFactory()).to.equal(strategyFactory.address);
        });

        it("should initialize with zero state", async function () {
            expect(await voter.totalWeight()).to.equal(0);
            expect(await voter.bribeSplit()).to.equal(0);
            expect(await voter.length()).to.equal(0);
            expect(await voter.revenueSource()).to.equal(revenueRouter.address);
        });

        it("should have correct constants", async function () {
            expect(await voter.MAX_BRIBE_SPLIT()).to.equal(5000);
            expect(await voter.DIVISOR()).to.equal(10000);
        });
    });

    // ==================== VOTE WEIGHT NORMALIZATION ====================

    describe("Vote Weight Normalization", function () {
        let s1, s2, s3;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
            s2 = (await createStrategy(paymentToken2)).strategy;
            s3 = (await createStrategy(paymentToken3)).strategy;
            await stakeTokens(user1, ethers.utils.parseEther("1000"));
        });

        it("should normalize weights to user's governance balance", async function () {
            // Vote with arbitrary weights [100, 200, 300] - should normalize to 1000 total
            await voter.connect(user1).vote([s1, s2, s3], [100, 200, 300]);

            const vote1 = await voter.account_Strategy_Votes(user1.address, s1);
            const vote2 = await voter.account_Strategy_Votes(user1.address, s2);
            const vote3 = await voter.account_Strategy_Votes(user1.address, s3);

            // Total should equal governance balance (within rounding tolerance)
            const total = vote1.add(vote2).add(vote3);
            expect(total).to.be.closeTo(ethers.utils.parseEther("1000"), ethers.utils.parseEther("0.001"));

            // Ratios should be preserved: 1:2:3
            expect(vote2).to.be.closeTo(vote1.mul(2), vote1.div(100));
            expect(vote3).to.be.closeTo(vote1.mul(3), vote1.div(100));
        });

        it("should handle equal weights", async function () {
            await voter.connect(user1).vote([s1, s2, s3], [1, 1, 1]);

            const vote1 = await voter.account_Strategy_Votes(user1.address, s1);
            const vote2 = await voter.account_Strategy_Votes(user1.address, s2);
            const vote3 = await voter.account_Strategy_Votes(user1.address, s3);

            // All should be ~333.33 ETH
            expect(vote1).to.be.closeTo(ethers.utils.parseEther("333.333333333333333333"), ethers.utils.parseEther("1"));
            expect(vote2).to.be.closeTo(vote1, 1);
            expect(vote3).to.be.closeTo(vote1, 1);
        });

        it("should handle extreme weight ratios (1:1000)", async function () {
            await voter.connect(user1).vote([s1, s2], [1, 1000]);

            const vote1 = await voter.account_Strategy_Votes(user1.address, s1);
            const vote2 = await voter.account_Strategy_Votes(user1.address, s2);

            // s1 gets ~0.999 ETH, s2 gets ~999 ETH
            expect(vote1).to.be.closeTo(ethers.utils.parseEther("0.999"), ethers.utils.parseEther("0.01"));
            expect(vote2).to.be.closeTo(ethers.utils.parseEther("999"), ethers.utils.parseEther("1"));
        });

        it("should handle single strategy vote (all weight goes there)", async function () {
            await voter.connect(user1).vote([s1], [1]);

            expect(await voter.account_Strategy_Votes(user1.address, s1)).to.equal(ethers.utils.parseEther("1000"));
            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("1000"));
        });

        it("should handle very large weight numbers", async function () {
            const bigWeight = ethers.utils.parseEther("1000000");
            await voter.connect(user1).vote([s1, s2], [bigWeight, bigWeight.mul(2)]);

            const vote1 = await voter.account_Strategy_Votes(user1.address, s1);
            const vote2 = await voter.account_Strategy_Votes(user1.address, s2);

            // Should still normalize correctly - 1:2 ratio
            expect(vote2).to.be.closeTo(vote1.mul(2), vote1.div(100));
        });

        it("should revert if normalization results in zero weight for a strategy", async function () {
            // Very small weight compared to others - will round to 0
            await stakeTokens(user2, ethers.utils.parseEther("1")); // Only 1 token

            // This should fail because 1 wei / 1e18 total weight = 0
            await expect(
                voter.connect(user2).vote([s1, s2], [1, ethers.utils.parseEther("1000000")])
            ).to.be.reverted;
        });
    });

    // ==================== VOTING STATE MANAGEMENT ====================

    describe("Voting State Management", function () {
        let s1, s2;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
            s2 = (await createStrategy(paymentToken2)).strategy;
        });

        it("should correctly track account_StrategyVote array", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1, s2], [1, 1]);

            const votes = await voter.getStrategyVote(user1.address);
            expect(votes.length).to.equal(2);
            expect(votes[0]).to.equal(s1);
            expect(votes[1]).to.equal(s2);
        });

        it("should clear account_StrategyVote on reset", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1, s2], [1, 1]);

            await advanceToNextEpoch();
            await voter.connect(user1).reset();

            const votes = await voter.getStrategyVote(user1.address);
            expect(votes.length).to.equal(0);
        });

        it("should update account_LastVoted on vote", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            const beforeVote = await voter.account_LastVoted(user1.address);
            expect(beforeVote).to.equal(0);

            await voter.connect(user1).vote([s1], [1]);

            const afterVote = await voter.account_LastVoted(user1.address);
            expect(afterVote).to.be.gt(0);
        });

        it("should update account_LastVoted on reset", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            const afterVote = await voter.account_LastVoted(user1.address);

            await advanceToNextEpoch();
            await voter.connect(user1).reset();

            const afterReset = await voter.account_LastVoted(user1.address);
            expect(afterReset).to.be.gt(afterVote);
        });

        it("should correctly track account_UsedWeights", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1, s2], [3, 7]);

            const usedWeight = await voter.account_UsedWeights(user1.address);
            expect(usedWeight).to.equal(ethers.utils.parseEther("100"));
        });

        it("should zero account_UsedWeights on reset", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));

            await advanceToNextEpoch();
            await voter.connect(user1).reset();

            expect(await voter.account_UsedWeights(user1.address)).to.equal(0);
        });
    });

    // ==================== EPOCH ENFORCEMENT ====================

    describe("Epoch Enforcement", function () {
        let s1;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
            await stakeTokens(user1, ethers.utils.parseEther("100"));
        });

        it("should allow first vote in any epoch", async function () {
            await voter.connect(user1).vote([s1], [1]);
            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should prevent second vote in same epoch", async function () {
            await voter.connect(user1).vote([s1], [1]);
            await expect(voter.connect(user1).vote([s1], [1])).to.be.reverted;
        });

        it("should prevent reset in same epoch after vote", async function () {
            await voter.connect(user1).vote([s1], [1]);
            await expect(voter.connect(user1).reset()).to.be.reverted;
        });

        it("should prevent second reset in same epoch", async function () {
            await voter.connect(user1).vote([s1], [1]);
            await advanceToNextEpoch();
            await voter.connect(user1).reset();
            await expect(voter.connect(user1).reset()).to.be.reverted;
        });

        it("should allow vote after reset in new epoch", async function () {
            await voter.connect(user1).vote([s1], [1]);
            await advanceToNextEpoch();
            await voter.connect(user1).reset();
            await advanceToNextEpoch();
            await voter.connect(user1).vote([s1], [1]);

            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should allow voting in consecutive epochs", async function () {
            for (let i = 0; i < 5; i++) {
                await voter.connect(user1).vote([s1], [1]);
                await advanceToNextEpoch();
            }
            // Final vote
            await voter.connect(user1).vote([s1], [1]);
        });

        it("should allow different users to vote in same epoch", async function () {
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([s1], [1]);
            await voter.connect(user2).vote([s1], [1]);

            expect(await voter.strategy_Weight(s1)).to.equal(ethers.utils.parseEther("200"));
        });
    });

    // ==================== INDEX AND CLAIMABLE CALCULATIONS ====================

    describe("Index and Claimable Calculations", function () {
        let s1, s2;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
            s2 = (await createStrategy(paymentToken2)).strategy;
        });

        it("should calculate index correctly: index += amount * 1e18 / totalWeight", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            // totalWeight = 100e18
            // amount = 50e18
            // delta_index = 50e18 * 1e18 / 100e18 = 0.5e18
            await sendRevenue(ethers.utils.parseEther("50"));

            await voter.updateStrategy(s1);

            // claimable = weight * delta_index / 1e18 = 100e18 * 0.5e18 / 1e18 = 50e18
            expect(await voter.strategy_Claimable(s1)).to.equal(ethers.utils.parseEther("50"));
        });

        it("should accumulate index over multiple revenue notifications", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await sendRevenue(ethers.utils.parseEther("100"));
            await sendRevenue(ethers.utils.parseEther("100"));

            await voter.updateStrategy(s1);
            expect(await voter.strategy_Claimable(s1)).to.equal(ethers.utils.parseEther("300"));
        });

        it("should track strategy_SupplyIndex per strategy", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([s1], [1]);

            // First revenue - only s1 exists
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(s1);
            expect(await voter.strategy_Claimable(s1)).to.equal(ethers.utils.parseEther("100"));

            // s2 joins now
            await voter.connect(user2).vote([s2], [1]);

            // Second revenue - both exist
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(s1);
            await voter.updateStrategy(s2);

            // s1: 100 (first) + 50 (second) = 150
            // s2: 0 (first) + 50 (second) = 50
            expect(await voter.strategy_Claimable(s1)).to.equal(ethers.utils.parseEther("150"));
            expect(await voter.strategy_Claimable(s2)).to.equal(ethers.utils.parseEther("50"));
        });

        it("should set strategy_SupplyIndex to current index when weight is 0", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            // Generate some index
            await sendRevenue(ethers.utils.parseEther("100"));

            // Update s2 (which has 0 weight) - should set its index to current
            await voter.updateStrategy(s2);

            // Now vote for s2
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user2).vote([s2], [1]);

            // New revenue
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(s2);

            // s2 should only get share of new revenue
            expect(await voter.strategy_Claimable(s2)).to.equal(ethers.utils.parseEther("50"));
        });

        it("should not accumulate claimable for dead strategies", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            await voter.killStrategy(s1);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(s1);

            // Dead strategy doesn't accumulate
            expect(await voter.strategy_Claimable(s1)).to.equal(0);
        });

        it("should handle very small revenue amounts (potential dust)", async function () {
            // Mint more underlying for large stake
            await underlying.mint(user1.address, ethers.utils.parseEther("1000000"));
            await stakeTokens(user1, ethers.utils.parseEther("1000000")); // Large weight
            await voter.connect(user1).vote([s1], [1]);

            // Small revenue
            await sendRevenue(ethers.utils.parseEther("0.000001"));
            await voter.updateStrategy(s1);

            // Should still work
            const claimable = await voter.strategy_Claimable(s1);
            expect(claimable).to.be.closeTo(ethers.utils.parseEther("0.000001"), 1000);
        });
    });

    // ==================== DISTRIBUTE FUNCTION ====================

    describe("Distribute Functions", function () {
        let s1, s2, s3;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
            s2 = (await createStrategy(paymentToken2)).strategy;
            s3 = (await createStrategy(paymentToken3)).strategy;

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));

            await voter.connect(user1).vote([s1], [1]);
            await voter.connect(user2).vote([s2], [1]);
            await voter.connect(user3).vote([s3], [1]);
        });

        it("distribute(address) should transfer claimable to strategy", async function () {
            await sendRevenue(ethers.utils.parseEther("600"));

            await voter["distribute(address)"](s1);

            expect(await revenueToken.balanceOf(s1)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Claimable(s1)).to.equal(0);
        });

        it("distribute(address) should not transfer if claimable is 0", async function () {
            // No revenue sent
            await voter["distribute(address)"](s1);
            expect(await revenueToken.balanceOf(s1)).to.equal(0);
        });

        it("distributeRange(start, finish) should distribute to range", async function () {
            await sendRevenue(ethers.utils.parseEther("600"));

            await voter.distributeRange(0, 2);

            expect(await revenueToken.balanceOf(s1)).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(s2)).to.equal(ethers.utils.parseEther("200"));
            expect(await revenueToken.balanceOf(s3)).to.equal(0); // Not in range
        });

        it("distributeAll() should distribute to all strategies", async function () {
            await sendRevenue(ethers.utils.parseEther("600"));

            await voter.distributeAll();

            expect(await revenueToken.balanceOf(s1)).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(s2)).to.equal(ethers.utils.parseEther("200"));
            expect(await revenueToken.balanceOf(s3)).to.equal(ethers.utils.parseEther("300"));
        });

        it("distribute should be callable by anyone", async function () {
            await sendRevenue(ethers.utils.parseEther("600"));

            await voter.connect(attacker)["distribute(address)"](s1);
            expect(await revenueToken.balanceOf(s1)).to.equal(ethers.utils.parseEther("100"));
        });

        it("multiple distributes on same strategy should not double count", async function () {
            await sendRevenue(ethers.utils.parseEther("600"));

            await voter["distribute(address)"](s1);
            const balance1 = await revenueToken.balanceOf(s1);

            await voter["distribute(address)"](s1);
            const balance2 = await revenueToken.balanceOf(s1);

            await voter["distribute(address)"](s1);
            const balance3 = await revenueToken.balanceOf(s1);

            expect(balance1).to.equal(balance2);
            expect(balance2).to.equal(balance3);
        });
    });

    // ==================== UPDATE FUNCTIONS ====================

    describe("Update Functions", function () {
        let s1, s2, s3;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
            s2 = (await createStrategy(paymentToken2)).strategy;
            s3 = (await createStrategy(paymentToken3)).strategy;

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1, s2, s3], [1, 1, 1]);
            await sendRevenue(ethers.utils.parseEther("99")); // 33 each
        });

        it("updateStrategy should update single strategy", async function () {
            await voter.updateStrategy(s1);

            // 99/3 = 33 but due to integer division may be slightly less
            expect(await voter.strategy_Claimable(s1)).to.be.closeTo(ethers.utils.parseEther("33"), ethers.utils.parseEther("0.001"));
            expect(await voter.strategy_Claimable(s2)).to.equal(0); // Not updated yet
        });

        it("updateFor should update array of strategies", async function () {
            await voter.updateFor([s1, s2]);

            expect(await voter.strategy_Claimable(s1)).to.be.closeTo(ethers.utils.parseEther("33"), ethers.utils.parseEther("0.001"));
            expect(await voter.strategy_Claimable(s2)).to.be.closeTo(ethers.utils.parseEther("33"), ethers.utils.parseEther("0.001"));
            expect(await voter.strategy_Claimable(s3)).to.equal(0); // Not in array
        });

        it("updateForRange should update range of strategies", async function () {
            await voter.updateForRange(1, 3); // s2 and s3

            expect(await voter.strategy_Claimable(s1)).to.equal(0); // Not in range
            expect(await voter.strategy_Claimable(s2)).to.be.closeTo(ethers.utils.parseEther("33"), ethers.utils.parseEther("0.001"));
            expect(await voter.strategy_Claimable(s3)).to.be.closeTo(ethers.utils.parseEther("33"), ethers.utils.parseEther("0.001"));
        });

        it("updateAll should update all strategies", async function () {
            await voter.updateAll();

            expect(await voter.strategy_Claimable(s1)).to.be.closeTo(ethers.utils.parseEther("33"), ethers.utils.parseEther("0.001"));
            expect(await voter.strategy_Claimable(s2)).to.be.closeTo(ethers.utils.parseEther("33"), ethers.utils.parseEther("0.001"));
            expect(await voter.strategy_Claimable(s3)).to.be.closeTo(ethers.utils.parseEther("33"), ethers.utils.parseEther("0.001"));
        });
    });

    // ==================== NOTIFY REVENUE ====================

    describe("notifyRevenue", function () {
        let s1;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
        });

        it("should only accept calls from revenueSource", async function () {
            await expect(voter.notifyRevenue(ethers.utils.parseEther("100"))).to.be.reverted;
            await expect(voter.connect(attacker).notifyRevenue(ethers.utils.parseEther("100"))).to.be.reverted;
        });

        it("should send to treasury when totalWeight is 0", async function () {
            const treasuryBefore = await revenueToken.balanceOf(treasury.address);
            await sendRevenue(ethers.utils.parseEther("100"));
            const treasuryAfter = await revenueToken.balanceOf(treasury.address);

            expect(treasuryAfter.sub(treasuryBefore)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should update index when totalWeight > 0", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            const treasuryBefore = await revenueToken.balanceOf(treasury.address);
            await sendRevenue(ethers.utils.parseEther("100"));
            const treasuryAfter = await revenueToken.balanceOf(treasury.address);

            // Treasury should NOT receive (totalWeight > 0)
            expect(treasuryAfter.sub(treasuryBefore)).to.equal(0);

            // Voter should hold the revenue
            expect(await revenueToken.balanceOf(voter.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should emit NotifyRevenue event", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("100"));
            await expect(revenueRouter.flush())
                .to.emit(voter, "Voter__NotifyRevenue")
                .withArgs(revenueRouter.address, ethers.utils.parseEther("100"));
        });
    });

    // ==================== STRATEGY MANAGEMENT ====================

    describe("Strategy Management", function () {
        it("addStrategy should create all related contracts", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            expect(await voter.strategy_IsValid(strategy)).to.be.true;
            expect(await voter.strategy_IsAlive(strategy)).to.be.true;
            expect(await voter.strategy_Bribe(strategy)).to.equal(bribe);
            expect(await voter.strategy_BribeRouter(strategy)).to.equal(bribeRouter);
            expect(await voter.strategy_PaymentToken(strategy)).to.equal(paymentToken.address);
        });

        it("addStrategy should add to strategies array", async function () {
            expect(await voter.length()).to.equal(0);

            await createStrategy(paymentToken);
            expect(await voter.length()).to.equal(1);

            await createStrategy(paymentToken2);
            expect(await voter.length()).to.equal(2);
        });

        it("addStrategy should emit StrategyAdded event", async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await expect(voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice))
                .to.emit(voter, "Voter__StrategyAdded");
        });

        it("killStrategy should mark as not alive", async function () {
            const { strategy } = await createStrategy();

            expect(await voter.strategy_IsAlive(strategy)).to.be.true;
            await voter.killStrategy(strategy);
            expect(await voter.strategy_IsAlive(strategy)).to.be.false;
        });

        it("killStrategy should preserve isValid", async function () {
            const { strategy } = await createStrategy();
            await voter.killStrategy(strategy);

            expect(await voter.strategy_IsValid(strategy)).to.be.true;
        });

        it("killStrategy should send claimable to treasury", async function () {
            const { strategy } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [1]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy);

            const treasuryBefore = await revenueToken.balanceOf(treasury.address);
            await voter.killStrategy(strategy);
            const treasuryAfter = await revenueToken.balanceOf(treasury.address);

            expect(treasuryAfter.sub(treasuryBefore)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Claimable(strategy)).to.equal(0);
        });

        it("killStrategy should preserve weights (for user reset)", async function () {
            const { strategy } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [1]);

            const weightBefore = await voter.strategy_Weight(strategy);
            const totalBefore = await voter.totalWeight();

            await voter.killStrategy(strategy);

            expect(await voter.strategy_Weight(strategy)).to.equal(weightBefore);
            expect(await voter.totalWeight()).to.equal(totalBefore);
        });

        it("killStrategy should emit StrategyKilled event", async function () {
            const { strategy } = await createStrategy();
            await expect(voter.killStrategy(strategy))
                .to.emit(voter, "Voter__StrategyKilled")
                .withArgs(strategy);
        });
    });

    // ==================== BRIBE INTEGRATION ====================

    describe("Bribe Integration", function () {
        let s1, b1;

        beforeEach(async function () {
            const result = await createStrategy();
            s1 = result.strategy;
            b1 = result.bribe;
        });

        it("vote should deposit to bribe contract", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            const bribe = await ethers.getContractAt("Bribe", b1);
            expect(await bribe.account_Balance(user1.address)).to.equal(ethers.utils.parseEther("100"));
            expect(await bribe.totalSupply()).to.equal(ethers.utils.parseEther("100"));
        });

        it("reset should withdraw from bribe contract", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            await advanceToNextEpoch();
            await voter.connect(user1).reset();

            const bribe = await ethers.getContractAt("Bribe", b1);
            expect(await bribe.account_Balance(user1.address)).to.equal(0);
            expect(await bribe.totalSupply()).to.equal(0);
        });

        it("vote should auto-reset previous bribe balances", async function () {
            const { strategy: s2, bribe: b2 } = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            await advanceToNextEpoch();
            await voter.connect(user1).vote([s2], [1]);

            const bribe1 = await ethers.getContractAt("Bribe", b1);
            const bribe2 = await ethers.getContractAt("Bribe", b2);

            expect(await bribe1.account_Balance(user1.address)).to.equal(0);
            expect(await bribe2.account_Balance(user1.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("addBribeReward should add reward token to bribe", async function () {
            await voter.addBribeReward(b1, revenueToken.address);

            const bribe = await ethers.getContractAt("Bribe", b1);
            const tokens = await bribe.getRewardTokens();

            expect(tokens.length).to.equal(2);
            expect(tokens[1]).to.equal(revenueToken.address);
        });

        it("claimBribes should claim from multiple bribes", async function () {
            const { strategy: s2, bribe: b2, bribeRouter: br2 } = await createStrategy(paymentToken2);

            await voter.setBribeSplit(5000); // 50%
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1, s2], [1, 1]);

            // Fund both bribes
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.distributeAll();

            // Simulate strategy buys and bribe distributions
            // (This would require full integration - simplified check)
            await voter.claimBribes([b1, b2]);
            // Should not revert
        });
    });

    // ==================== MULTI-USER SCENARIOS ====================

    describe("Multi-User Scenarios", function () {
        let s1, s2, s3;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
            s2 = (await createStrategy(paymentToken2)).strategy;
            s3 = (await createStrategy(paymentToken3)).strategy;
        });

        it("should handle 5 users voting for same strategy", async function () {
            const amount = ethers.utils.parseEther("100");
            for (const user of [user1, user2, user3, user4, user5]) {
                await stakeTokens(user, amount);
                await voter.connect(user).vote([s1], [1]);
            }

            expect(await voter.strategy_Weight(s1)).to.equal(ethers.utils.parseEther("500"));
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("500"));
        });

        it("should handle 5 users voting for different strategies", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));
            await stakeTokens(user4, ethers.utils.parseEther("200"));
            await stakeTokens(user5, ethers.utils.parseEther("200"));

            await voter.connect(user1).vote([s1], [1]);
            await voter.connect(user2).vote([s2], [1]);
            await voter.connect(user3).vote([s3], [1]);
            await voter.connect(user4).vote([s1, s2], [1, 1]);
            await voter.connect(user5).vote([s2, s3], [1, 1]);

            // s1: 100 + 100 = 200
            // s2: 200 + 100 + 100 = 400
            // s3: 300 + 100 = 400
            expect(await voter.strategy_Weight(s1)).to.equal(ethers.utils.parseEther("200"));
            expect(await voter.strategy_Weight(s2)).to.equal(ethers.utils.parseEther("400"));
            expect(await voter.strategy_Weight(s3)).to.equal(ethers.utils.parseEther("400"));
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("1000"));
        });

        it("should handle users changing votes across epochs", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            // Epoch 1: Both vote s1
            await voter.connect(user1).vote([s1], [1]);
            await voter.connect(user2).vote([s1], [1]);
            expect(await voter.strategy_Weight(s1)).to.equal(ethers.utils.parseEther("200"));

            await advanceToNextEpoch();

            // Epoch 2: User1 switches to s2, user2 keeps s1
            await voter.connect(user1).vote([s2], [1]);
            await voter.connect(user2).vote([s1], [1]);

            expect(await voter.strategy_Weight(s1)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Weight(s2)).to.equal(ethers.utils.parseEther("100"));

            await advanceToNextEpoch();

            // Epoch 3: Both switch to s3
            await voter.connect(user1).vote([s3], [1]);
            await voter.connect(user2).vote([s3], [1]);

            expect(await voter.strategy_Weight(s1)).to.equal(0);
            expect(await voter.strategy_Weight(s2)).to.equal(0);
            expect(await voter.strategy_Weight(s3)).to.equal(ethers.utils.parseEther("200"));
        });

        it("should distribute revenue correctly to multiple users across strategies", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));

            await voter.connect(user1).vote([s1], [1]);
            await voter.connect(user2).vote([s2], [1]);
            await voter.connect(user3).vote([s3], [1]);

            await sendRevenue(ethers.utils.parseEther("600"));
            await voter.distributeAll();

            // s1: 100/600 * 600 = 100
            // s2: 200/600 * 600 = 200
            // s3: 300/600 * 600 = 300
            expect(await revenueToken.balanceOf(s1)).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(s2)).to.equal(ethers.utils.parseEther("200"));
            expect(await revenueToken.balanceOf(s3)).to.equal(ethers.utils.parseEther("300"));
        });
    });

    // ==================== EVENT EMISSIONS ====================

    describe("Event Emissions", function () {
        let s1;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
        });

        it("should emit Voted event with correct parameters", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            await expect(voter.connect(user1).vote([s1], [1]))
                .to.emit(voter, "Voter__Voted")
                .withArgs(user1.address, s1, ethers.utils.parseEther("100"));
        });

        it("should emit Abstained event on reset", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            await advanceToNextEpoch();

            await expect(voter.connect(user1).reset())
                .to.emit(voter, "Voter__Abstained")
                .withArgs(user1.address, s1, ethers.utils.parseEther("100"));
        });

        it("should emit DistributeRevenue event", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);
            await sendRevenue(ethers.utils.parseEther("100"));

            await expect(voter["distribute(address)"](s1))
                .to.emit(voter, "Voter__DistributeRevenue")
                .withArgs(owner.address, s1, ethers.utils.parseEther("100"));
        });

        it("should emit RevenueSourceSet event", async function () {
            await expect(voter.setRevenueSource(user1.address))
                .to.emit(voter, "Voter__RevenueSourceSet")
                .withArgs(user1.address);
        });

        it("should emit BribeSplitSet event", async function () {
            await expect(voter.setBribeSplit(2500))
                .to.emit(voter, "Voter__BribeSplitSet")
                .withArgs(2500);
        });

        it("should emit BribeRewardAdded event", async function () {
            const { bribe } = await createStrategy();

            await expect(voter.addBribeReward(bribe, revenueToken.address))
                .to.emit(voter, "Voter__BribeRewardAdded")
                .withArgs(bribe, revenueToken.address);
        });
    });

    // ==================== INVARIANT TESTS ====================

    describe("Invariant Tests", function () {
        let s1, s2, s3;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
            s2 = (await createStrategy(paymentToken2)).strategy;
            s3 = (await createStrategy(paymentToken3)).strategy;
        });

        it("INVARIANT: totalWeight == sum(strategy_Weight) for all strategies", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));

            await voter.connect(user1).vote([s1, s2], [1, 1]);
            await voter.connect(user2).vote([s2, s3], [3, 1]);
            await voter.connect(user3).vote([s1, s2, s3], [1, 2, 1]);

            const w1 = await voter.strategy_Weight(s1);
            const w2 = await voter.strategy_Weight(s2);
            const w3 = await voter.strategy_Weight(s3);
            const total = await voter.totalWeight();

            expect(total).to.equal(w1.add(w2).add(w3));

            // After reset
            await advanceToNextEpoch();
            await voter.connect(user1).reset();

            const w1After = await voter.strategy_Weight(s1);
            const w2After = await voter.strategy_Weight(s2);
            const w3After = await voter.strategy_Weight(s3);
            const totalAfter = await voter.totalWeight();

            expect(totalAfter).to.equal(w1After.add(w2After).add(w3After));
        });

        it("INVARIANT: account_UsedWeights == sum(account_Strategy_Votes) for user", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1, s2, s3], [1, 2, 3]);

            const v1 = await voter.account_Strategy_Votes(user1.address, s1);
            const v2 = await voter.account_Strategy_Votes(user1.address, s2);
            const v3 = await voter.account_Strategy_Votes(user1.address, s3);
            const used = await voter.account_UsedWeights(user1.address);

            expect(used).to.equal(v1.add(v2).add(v3));
        });

        it("INVARIANT: sum(distributed) <= sum(notified)", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));

            await voter.connect(user1).vote([s1], [1]);
            await voter.connect(user2).vote([s2], [1]);
            await voter.connect(user3).vote([s3], [1]);

            const notified = ethers.utils.parseEther("1000");
            await sendRevenue(notified);
            await voter.distributeAll();

            const d1 = await revenueToken.balanceOf(s1);
            const d2 = await revenueToken.balanceOf(s2);
            const d3 = await revenueToken.balanceOf(s3);
            const totalDistributed = d1.add(d2).add(d3);

            expect(totalDistributed).to.be.lte(notified);
            // And very close to it (minimal dust)
            expect(notified.sub(totalDistributed)).to.be.lt(1000);
        });

        it("INVARIANT: strategy weight cannot go negative", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            expect(await voter.strategy_Weight(s1)).to.equal(ethers.utils.parseEther("100"));

            await advanceToNextEpoch();
            await voter.connect(user1).reset();

            expect(await voter.strategy_Weight(s1)).to.equal(0);

            // Multiple resets shouldn't cause underflow
            await advanceToNextEpoch();
            await voter.connect(user1).reset(); // Reset with no votes

            expect(await voter.strategy_Weight(s1)).to.equal(0);
        });
    });

    // ==================== COMPLEX SCENARIOS ====================

    describe("Complex Scenarios", function () {
        let s1, s2, s3;

        beforeEach(async function () {
            s1 = (await createStrategy(paymentToken)).strategy;
            s2 = (await createStrategy(paymentToken2)).strategy;
            s3 = (await createStrategy(paymentToken3)).strategy;
        });

        it("should handle rapid epoch transitions with votes", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            for (let i = 0; i < 10; i++) {
                const strategy = [s1, s2, s3][i % 3];
                await voter.connect(user1).vote([strategy], [1]);
                await advanceToNextEpoch();
            }

            // Final state should be correct
            const votes = await voter.getStrategyVote(user1.address);
            expect(votes.length).to.equal(1);
        });

        it("should handle user staking more mid-epoch (doesn't affect current votes)", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1], [1]);

            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));

            // Stake more
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            // Used weight doesn't change until next vote
            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));

            // Next epoch, vote uses new balance
            await advanceToNextEpoch();
            await voter.connect(user1).vote([s1], [1]);

            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("200"));
        });

        it("should handle killing strategy with multiple voters", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));

            await voter.connect(user1).vote([s1], [1]);
            await voter.connect(user2).vote([s1], [1]);
            await voter.connect(user3).vote([s1, s2], [1, 1]);

            await sendRevenue(ethers.utils.parseEther("450"));
            await voter.killStrategy(s1);

            // Weight still there
            expect(await voter.strategy_Weight(s1)).to.equal(ethers.utils.parseEther("450"));

            // Users can reset
            await advanceToNextEpoch();
            await voter.connect(user1).reset();
            await voter.connect(user2).reset();
            await voter.connect(user3).reset();

            expect(await voter.strategy_Weight(s1)).to.equal(0);
            expect(await voter.totalWeight()).to.equal(0);
        });

        it("should handle revenue distribution with killed strategy mid-stream", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([s1], [1]);
            await voter.connect(user2).vote([s2], [1]);

            // First revenue - both alive
            await sendRevenue(ethers.utils.parseEther("200"));
            await voter.updateStrategy(s1);
            await voter.updateStrategy(s2);

            expect(await voter.strategy_Claimable(s1)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Claimable(s2)).to.equal(ethers.utils.parseEther("100"));

            // Kill s1 (sends its claimable to treasury)
            const treasuryBefore = await revenueToken.balanceOf(treasury.address);
            await voter.killStrategy(s1);
            const treasuryAfter = await revenueToken.balanceOf(treasury.address);
            expect(treasuryAfter.sub(treasuryBefore)).to.equal(ethers.utils.parseEther("100"));

            // Second revenue - s1 dead but weight still counts
            await sendRevenue(ethers.utils.parseEther("200"));
            await voter.updateStrategy(s1);
            await voter.updateStrategy(s2);

            // s1 doesn't accumulate (dead)
            expect(await voter.strategy_Claimable(s1)).to.equal(0);
            // s2 gets its 50% share
            expect(await voter.strategy_Claimable(s2)).to.equal(ethers.utils.parseEther("200"));

            // Distribute s2
            await voter["distribute(address)"](s2);
            expect(await revenueToken.balanceOf(s2)).to.equal(ethers.utils.parseEther("200"));

            // s1's 100 from second round is stuck in voter
            expect(await revenueToken.balanceOf(voter.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should handle user voting for mix of alive and dead strategies", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            await voter.killStrategy(s1);

            // Vote for mix - only alive strategies get weight
            await voter.connect(user1).vote([s1, s2, s3], [1, 1, 1]);

            // s1 is dead, skipped
            expect(await voter.account_Strategy_Votes(user1.address, s1)).to.equal(0);
            // s2 and s3 split the 100
            expect(await voter.account_Strategy_Votes(user1.address, s2)).to.equal(ethers.utils.parseEther("50"));
            expect(await voter.account_Strategy_Votes(user1.address, s3)).to.equal(ethers.utils.parseEther("50"));

            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));
        });
    });
});
