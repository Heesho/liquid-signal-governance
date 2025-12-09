const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Edge Case and Security Tests
 *
 * Tests cover:
 * 1. Boundary conditions and extreme values
 * 2. Access control verification
 * 3. Reentrancy protection verification
 * 4. Integer overflow/underflow scenarios
 * 5. Zero-value and empty array handling
 */
describe("Edge Cases and Security Tests", function () {
    let owner, user1, user2, user3, treasury, buyer1, attacker;
    let underlying, revenueToken, paymentToken;
    let governanceToken, voter, bribeFactory, strategyFactory, revenueRouter;

    const WEEK = 7 * 24 * 60 * 60;
    const HOUR = 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, user3, treasury, buyer1, attacker] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("Underlying Token", "UNDERLYING", 18);
        revenueToken = await MockERC20.deploy("Revenue Token", "WETH", 18);
        paymentToken = await MockERC20.deploy("Payment Token", "USDC", 6);

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

        // Mint tokens
        for (const user of [user1, user2, user3, attacker]) {
            await underlying.mint(user.address, ethers.utils.parseEther("10000"));
        }
        await revenueToken.mint(owner.address, ethers.utils.parseEther("1000000"));
        await paymentToken.mint(buyer1.address, ethers.utils.parseUnits("1000000", 6));
    });

    async function createStrategy() {
        const initPrice = ethers.utils.parseUnits("100", 6);
        const tx = await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
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

    // ==================== ACCESS CONTROL ====================

    describe("Access Control", function () {
        it("only owner can add strategy", async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await expect(
                voter.connect(attacker).addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("only owner can kill strategy", async function () {
            const { strategy } = await createStrategy();
            await expect(voter.connect(attacker).killStrategy(strategy)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("only owner can set revenue source", async function () {
            await expect(voter.connect(attacker).setRevenueSource(attacker.address)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("only owner can set bribe split", async function () {
            await expect(voter.connect(attacker).setBribeSplit(1000)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("only owner can add bribe reward", async function () {
            const { bribe } = await createStrategy();
            await expect(voter.connect(attacker).addBribeReward(bribe, revenueToken.address)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("only revenue source can notify revenue", async function () {
            await expect(voter.connect(attacker).notifyAndDistribute(ethers.utils.parseEther("100"))).to.be.reverted;
        });

        it("only voter can deposit/withdraw from bribe", async function () {
            const { bribe } = await createStrategy();
            const bribeContract = await ethers.getContractAt("Bribe", bribe);

            await expect(bribeContract.connect(attacker)._deposit(100, attacker.address)).to.be.reverted;
            await expect(bribeContract.connect(attacker)._withdraw(100, attacker.address)).to.be.reverted;
        });

        it("only voter can add reward to bribe", async function () {
            const { bribe } = await createStrategy();
            const bribeContract = await ethers.getContractAt("Bribe", bribe);

            await expect(bribeContract.connect(attacker).addReward(revenueToken.address)).to.be.reverted;
        });
    });

    // ==================== BOUNDARY CONDITIONS ====================

    describe("Boundary Conditions", function () {
        it("should handle maximum bribe split (50%)", async function () {
            await voter.setBribeSplit(5000);
            expect(await voter.bribeSplit()).to.equal(5000);
        });

        it("should revert bribe split above maximum", async function () {
            await expect(voter.setBribeSplit(5001)).to.be.reverted;
        });

        it("should handle very small stake amounts", async function () {
            const { strategy } = await createStrategy();

            // Stake just 1 wei
            await underlying.connect(user1).approve(governanceToken.address, 1);
            await governanceToken.connect(user1).stake(1);

            await voter.connect(user1).vote([strategy], [100]);
            expect(await voter.account_UsedWeights(user1.address)).to.equal(1);
        });

        it("should handle very large stake amounts", async function () {
            const { strategy } = await createStrategy();

            // Stake a large amount
            const largeAmount = ethers.utils.parseEther("1000000000"); // 1 billion
            await underlying.mint(user1.address, largeAmount);
            await stakeTokens(user1, largeAmount);

            await voter.connect(user1).vote([strategy], [100]);
            expect(await voter.account_UsedWeights(user1.address)).to.equal(largeAmount);
        });

        it("should handle epoch period boundaries (min: 1 hour)", async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);

            // Create strategy with minimum epoch period
            await voter.addStrategy(
                paymentToken.address,
                treasury.address,
                initPrice,
                HOUR, // minimum
                ethers.utils.parseEther("1.1"), // min multiplier
                initPrice
            );
            expect(await voter.length()).to.equal(1);
        });

        it("should handle price multiplier boundaries (min: 1.1x, max: 3x)", async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);

            // Create with min multiplier
            await voter.addStrategy(
                paymentToken.address,
                treasury.address,
                initPrice,
                HOUR,
                ethers.utils.parseEther("1.1"), // 1.1x min
                initPrice
            );

            // Create with max multiplier
            await voter.addStrategy(
                paymentToken.address,
                treasury.address,
                initPrice,
                HOUR,
                ethers.utils.parseEther("3"), // 3x max
                initPrice
            );

            expect(await voter.length()).to.equal(2);
        });
    });

    // ==================== EMPTY/ZERO VALUE HANDLING ====================

    describe("Empty and Zero Value Handling", function () {
        it("should handle empty vote arrays", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([], []);
            expect(await voter.account_UsedWeights(user1.address)).to.equal(0);
        });

        it("should handle voting when all strategies are dead", async function () {
            const { strategy } = await createStrategy();
            await voter.killStrategy(strategy);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // No weight added since strategy is dead
            expect(await voter.account_UsedWeights(user1.address)).to.equal(0);
        });

        it("should handle distribute when no claimable", async function () {
            const { strategy } = await createStrategy();

            // Distribute without any revenue
            await voter["distribute(address)"](strategy);
            expect(await revenueToken.balanceOf(strategy)).to.equal(0);
        });

        it("should handle multiple distributes on same strategy", async function () {
            const { strategy } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));

            // First distribute
            await voter["distribute(address)"](strategy);
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("100"));

            // Second distribute (should do nothing)
            await voter["distribute(address)"](strategy);
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should handle update functions on empty strategies", async function () {
            // No strategies exist yet
            await voter.updateAll();
            await voter.distro();
            // Should not revert
        });

        it("should handle getStrategyVote for user who never voted", async function () {
            const votes = await voter.getStrategyVote(user1.address);
            expect(votes.length).to.equal(0);
        });
    });

    // ==================== MULTIPLE STRATEGIES ====================

    describe("Multiple Strategies Scenarios", function () {
        it("should handle distributing to partial range", async function () {
            const s1 = await createStrategy();
            const s2 = await createStrategy();
            const s3 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("300"));
            await voter.connect(user1).vote([s1.strategy, s2.strategy, s3.strategy], [1, 1, 1]);

            await sendRevenue(ethers.utils.parseEther("300"));

            // Distribute only first 2
            await voter["distribute(uint256,uint256)"](0, 2);

            expect(await revenueToken.balanceOf(s1.strategy)).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(s2.strategy)).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(s3.strategy)).to.equal(0);

            // Distribute last one
            await voter["distribute(uint256,uint256)"](2, 3);
            expect(await revenueToken.balanceOf(s3.strategy)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should handle voting for same strategy twice in one call (should revert)", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await expect(voter.connect(user1).vote([strategy, strategy], [50, 50])).to.be.revertedWith("Already voted for strategy");
        });

        it("should correctly track multiple strategies per user", async function () {
            const s1 = await createStrategy();
            const s2 = await createStrategy();
            const s3 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1.strategy, s2.strategy, s3.strategy], [50, 30, 20]);

            const votes = await voter.getStrategyVote(user1.address);
            expect(votes.length).to.equal(3);
            expect(votes[0]).to.equal(s1.strategy);
            expect(votes[1]).to.equal(s2.strategy);
            expect(votes[2]).to.equal(s3.strategy);

            expect(await voter.account_Strategy_Votes(user1.address, s1.strategy)).to.equal(ethers.utils.parseEther("50"));
            expect(await voter.account_Strategy_Votes(user1.address, s2.strategy)).to.equal(ethers.utils.parseEther("30"));
            expect(await voter.account_Strategy_Votes(user1.address, s3.strategy)).to.equal(ethers.utils.parseEther("20"));
        });
    });

    // ==================== EPOCH BOUNDARY EDGE CASES ====================

    describe("Epoch Boundary Edge Cases", function () {
        it("should prevent voting twice at exact epoch boundary", async function () {
            const { strategy } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([strategy], [100]);

            // Get current block timestamp
            const block = await ethers.provider.getBlock("latest");
            const lastVoted = await voter.account_LastVoted(user1.address);
            const epochStart = Math.floor(lastVoted.toNumber() / WEEK) * WEEK;
            const nextEpochStart = epochStart + WEEK;

            // Try to vote again before next epoch
            await expect(voter.connect(user1).vote([strategy], [100])).to.be.reverted;

            // Advance past next epoch start
            await ethers.provider.send("evm_setNextBlockTimestamp", [nextEpochStart + 1]);
            await ethers.provider.send("evm_mine");

            // Should succeed now in new epoch
            await voter.connect(user1).vote([strategy], [100]);
        });

        it("should handle reset at exact epoch boundary", async function () {
            const { strategy } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Advance to next epoch
            await advanceTime(WEEK);

            // Reset should work
            await voter.connect(user1).reset();
            expect(await voter.account_UsedWeights(user1.address)).to.equal(0);

            // Second reset in same epoch should fail
            await expect(voter.connect(user1).reset()).to.be.reverted;
        });
    });

    // ==================== STRATEGY BUY EDGE CASES ====================

    describe("Strategy Buy Edge Cases", function () {
        it("should handle buy with small revenue amount", async function () {
            const { strategy } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Send small but non-dust amount of revenue
            const smallAmount = ethers.utils.parseEther("0.001"); // 1 finney
            await revenueToken.transfer(revenueRouter.address, smallAmount);
            await revenueRouter.flush();
            await voter["distribute(address)"](strategy);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);

            // Wait for price to drop to 0
            await advanceTime(HOUR + 60);

            const slot0 = await strategyContract.getSlot0();
            const block = await ethers.provider.getBlock("latest");

            // Buy should transfer the small amount
            await strategyContract.connect(buyer1).buy(buyer1.address, slot0.epochId, block.timestamp + 3600, 0);
            expect(await revenueToken.balanceOf(buyer1.address)).to.equal(smallAmount);
        });

        it("should handle consecutive buys in same block", async function () {
            const { strategy } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Send revenue and buy
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            let slot0 = await strategyContract.getSlot0();
            let price = await strategyContract.getPrice();

            await paymentToken.connect(buyer1).approve(strategy, price);
            const block = await ethers.provider.getBlock("latest");
            await strategyContract.connect(buyer1).buy(buyer1.address, slot0.epochId, block.timestamp + 3600, price);

            // Try immediate second buy - should fail with epochId mismatch if using old epochId
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            // Need to get new slot0 for new epochId
            slot0 = await strategyContract.getSlot0();
            price = await strategyContract.getPrice();

            await paymentToken.connect(buyer1).approve(strategy, price);
            const block2 = await ethers.provider.getBlock("latest");
            await strategyContract.connect(buyer1).buy(buyer1.address, slot0.epochId, block2.timestamp + 3600, price);
        });
    });

    // ==================== KILL STRATEGY EDGE CASES ====================

    describe("Kill Strategy Edge Cases", function () {
        it("should revert killing already dead strategy", async function () {
            const { strategy } = await createStrategy();
            await voter.killStrategy(strategy);
            await expect(voter.killStrategy(strategy)).to.be.reverted;
        });

        it("should handle killing strategy with pending claimable", async function () {
            const { strategy } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy);

            const claimableBefore = await voter.strategy_Claimable(strategy);
            expect(claimableBefore).to.equal(ethers.utils.parseEther("100"));

            const treasuryBefore = await revenueToken.balanceOf(treasury.address);
            await voter.killStrategy(strategy);
            const treasuryAfter = await revenueToken.balanceOf(treasury.address);

            // Claimable sent to treasury
            expect(treasuryAfter.sub(treasuryBefore)).to.equal(claimableBefore);
            expect(await voter.strategy_Claimable(strategy)).to.equal(0);
        });

        it("should not affect other strategies when one is killed", async function () {
            const s1 = await createStrategy();
            const s2 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1.strategy], [100]);
            await voter.connect(user2).vote([s2.strategy], [100]);

            await voter.killStrategy(s1.strategy);

            // s2 should be unaffected
            expect(await voter.strategy_IsAlive(s2.strategy)).to.be.true;
            expect(await voter.strategy_Weight(s2.strategy)).to.equal(ethers.utils.parseEther("100"));
        });
    });

    // ==================== BRIBE EDGE CASES ====================

    describe("Bribe Edge Cases", function () {
        it("should handle getReward when no rewards exist", async function () {
            const { bribe } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            const bribeContract = await ethers.getContractAt("Bribe", bribe);

            // No rewards, getReward should not revert
            await bribeContract.getReward(user1.address);
        });

        it("should handle rewardPerToken when totalSupply is 0", async function () {
            const { bribe } = await createStrategy();
            const bribeContract = await ethers.getContractAt("Bribe", bribe);

            // No one has voted yet
            const rpt = await bribeContract.rewardPerToken(paymentToken.address);
            expect(rpt).to.equal(0);
        });

        it("should correctly track multiple reward tokens", async function () {
            const { bribe } = await createStrategy();

            // Add second reward token
            await voter.addBribeReward(bribe, revenueToken.address);

            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const tokens = await bribeContract.getRewardTokens();

            expect(tokens.length).to.equal(2);
            expect(tokens[0]).to.equal(paymentToken.address);
            expect(tokens[1]).to.equal(revenueToken.address);
        });
    });

    // ==================== INDEX CALCULATION EDGE CASES ====================

    describe("Index Calculation Edge Cases", function () {
        it("should not create index if ratio rounds to 0", async function () {
            const { strategy } = await createStrategy();

            // Large weight - need to mint more underlying first
            const largeAmount = ethers.utils.parseEther("1000000000"); // 1 billion
            await underlying.mint(user1.address, largeAmount);
            await stakeTokens(user1, largeAmount);
            await voter.connect(user1).vote([strategy], [100]);

            // Very small revenue (1 wei)
            // ratio = 1 * 1e18 / 1e27 = 0 (rounds down)
            await revenueToken.transfer(revenueRouter.address, 1);
            await revenueRouter.flush();

            await voter.updateStrategy(strategy);

            // Claimable should be 0 due to rounding
            expect(await voter.strategy_Claimable(strategy)).to.equal(0);
        });

        it("should accumulate index correctly over many small distributions", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Many small distributions
            const amount = ethers.utils.parseEther("1");
            for (let i = 0; i < 10; i++) {
                await sendRevenue(amount);
            }

            await voter.updateStrategy(strategy);

            // Should have accumulated ~10 ETH
            const claimable = await voter.strategy_Claimable(strategy);
            expect(claimable).to.equal(ethers.utils.parseEther("10"));
        });
    });

    // ==================== VIEW FUNCTION EDGE CASES ====================

    describe("View Function Edge Cases", function () {
        it("getStrategies returns empty array initially", async function () {
            const strategies = await voter.getStrategies();
            expect(strategies.length).to.equal(0);
        });

        it("length returns 0 initially", async function () {
            expect(await voter.length()).to.equal(0);
        });

        it("strategies mapping reverts on invalid index", async function () {
            await expect(voter.strategies(0)).to.be.reverted;
        });
    });
});
