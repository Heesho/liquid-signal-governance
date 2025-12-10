const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Tests for killStrategy behavior and stuck funds handling.
 *
 * Key Design Decision:
 * killStrategy does NOT remove weight from totalWeight/strategy_Weight because:
 * - Users still have account_Strategy_Votes pointing to the strategy
 * - _reset() needs to subtract those votes from strategy_Weight
 * - If killStrategy zeroed weights, _reset() would underflow and users would be stuck forever
 *
 * Instead:
 * - killStrategy sends pending claimable to treasury
 * - Dead strategies don't accumulate new claimable (_updateFor checks isAlive)
 * - Weights are removed when users call reset() in the next epoch
 * - Until users reset, revenue for dead strategy's weight proportion is discarded (stuck)
 * - Once all users reset from dead strategy, weights are properly removed and no more stuck funds
 */
describe("Stuck Funds Analysis", function () {
    let owner, user1, user2, treasury;
    let underlying, revenueToken, paymentToken;
    let governanceToken, voter, revenueRouter;

    const WEEK = 7 * 24 * 60 * 60;
    const HOUR = 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, treasury] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("Underlying Token", "UNDERLYING", 18);
        revenueToken = await MockERC20.deploy("Revenue Token", "WETH", 18);
        paymentToken = await MockERC20.deploy("Payment Token", "USDC", 6);

        const BribeFactory = await ethers.getContractFactory("BribeFactory");
        const bribeFactory = await BribeFactory.deploy();

        const StrategyFactory = await ethers.getContractFactory("StrategyFactory");
        const strategyFactory = await StrategyFactory.deploy();

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

        await underlying.mint(user1.address, ethers.utils.parseEther("1000"));
        await underlying.mint(user2.address, ethers.utils.parseEther("1000"));
        await revenueToken.mint(owner.address, ethers.utils.parseEther("100000"));
    });

    async function createStrategy() {
        const initPrice = ethers.utils.parseUnits("100", 6);
        const tx = await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "Voter__StrategyAdded");
        return event.args.strategy;
    }

    async function stakeTokens(user, amount) {
        await underlying.connect(user).approve(governanceToken.address, amount);
        await governanceToken.connect(user).stake(amount);
    }

    async function sendRevenue(amount) {
        await revenueToken.transfer(revenueRouter.address, amount);
        await revenueRouter.flush();
    }

    describe("killStrategy Behavior", function () {

        it("killing strategy sends pending claimable to treasury", async function () {
            const strategy1 = await createStrategy();
            const strategy2 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            // Revenue comes in - 1000 WETH, 500 each based on weight
            await sendRevenue(ethers.utils.parseEther("1000"));

            const treasuryBefore = await revenueToken.balanceOf(treasury.address);

            // Kill strategy1 - sends its pending 500 WETH to treasury
            await voter.killStrategy(strategy1);

            const treasuryAfter = await revenueToken.balanceOf(treasury.address);

            // Treasury got strategy1's 500 WETH
            expect(treasuryAfter.sub(treasuryBefore)).to.equal(ethers.utils.parseEther("500"));

            // Strategy1 got nothing (sent to treasury instead)
            expect(await revenueToken.balanceOf(strategy1)).to.equal(0);

            // Distribute strategy2 - it gets its 500 WETH
            await voter["distribute(address)"](strategy2);
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("500"));

            // No funds stuck in Voter
            expect(await revenueToken.balanceOf(voter.address)).to.equal(0);
        });

        it("killing strategy preserves weights so users can reset", async function () {
            const strategy = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Weights before kill
            expect(await voter.strategy_Weight(strategy)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));

            // Kill strategy
            await voter.killStrategy(strategy);

            // Weights still there - users need to be able to reset!
            expect(await voter.strategy_Weight(strategy)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));

            // User can reset in next epoch
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");
            await voter.connect(user1).reset();

            // NOW weights are removed
            expect(await voter.strategy_Weight(strategy)).to.equal(0);
            expect(await voter.totalWeight()).to.equal(0);
        });

        it("dead strategy does not accumulate new claimable", async function () {
            const strategy1 = await createStrategy();
            const strategy2 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            // Kill strategy1
            await voter.killStrategy(strategy1);

            // Send revenue AFTER kill
            await sendRevenue(ethers.utils.parseEther("1000"));

            // Update both strategies
            await voter.updateStrategy(strategy1);
            await voter.updateStrategy(strategy2);

            // Dead strategy has 0 claimable (even though it still has weight)
            // because _updateFor checks strategy_IsAlive before adding to claimable
            expect(await voter.strategy_Claimable(strategy1)).to.equal(0);

            // Strategy2 gets its share based on weight ratio (50% since totalWeight still includes dead strategy)
            expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("500"));
        });

        it("handles kill with no pending claimable", async function () {
            const strategy1 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            // Kill immediately without any revenue
            const treasuryBefore = await revenueToken.balanceOf(treasury.address);
            await voter.killStrategy(strategy1);
            const treasuryAfter = await revenueToken.balanceOf(treasury.address);

            // No change to treasury (no claimable to send)
            expect(treasuryAfter).to.equal(treasuryBefore);

            // Weight still there (user needs to reset)
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Weight(strategy1)).to.equal(ethers.utils.parseEther("100"));
        });

        it("handles kill after distribute (no double counting)", async function () {
            const strategy1 = await createStrategy();
            const strategy2 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            // Revenue and distribute to strategy1
            await sendRevenue(ethers.utils.parseEther("1000"));
            await voter["distribute(address)"](strategy1);

            // Strategy1 already got its 500
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("500"));

            // Now kill - should have 0 claimable since already distributed
            const treasuryBefore = await revenueToken.balanceOf(treasury.address);
            await voter.killStrategy(strategy1);
            const treasuryAfter = await revenueToken.balanceOf(treasury.address);

            // Nothing extra sent to treasury (already distributed)
            expect(treasuryAfter).to.equal(treasuryBefore);

            // Distribute strategy2
            await voter["distribute(address)"](strategy2);
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("500"));

            // No stuck funds
            expect(await revenueToken.balanceOf(voter.address)).to.equal(0);
        });
    });

    describe("Temporary Stuck Funds (Expected Tradeoff)", function () {

        it("revenue after kill but before user reset: dead strategy share is stuck temporarily", async function () {
            // This is the expected tradeoff: dead strategy weight remains until users reset
            // Revenue calculated for dead strategy is discarded (not added to claimable)
            // so it stays stuck in voter until users reset and remove the weight
            const strategy1 = await createStrategy();
            const strategy2 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            // Kill strategy1 (weight remains for user to withdraw)
            await voter.killStrategy(strategy1);

            // Send 1000 WETH revenue
            await sendRevenue(ethers.utils.parseEther("1000"));

            // Distribute all
            await voter.distributeAll();

            // Strategy2 gets 500 (its 50% share based on weight)
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("500"));

            // Strategy1's 500 share is stuck in voter (calculated based on weight but discarded)
            expect(await revenueToken.balanceOf(voter.address)).to.equal(ethers.utils.parseEther("500"));
        });

        it("after all users reset from dead strategy, no more stuck funds", async function () {
            const strategy1 = await createStrategy();
            const strategy2 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            // Kill strategy1
            await voter.killStrategy(strategy1);

            // Advance epoch and have user1 reset (removes their weight from dead strategy)
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");
            await voter.connect(user1).reset();

            // Now totalWeight is only strategy2's 100
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Weight(strategy1)).to.equal(0);

            // Send revenue - now 100% goes to strategy2
            await sendRevenue(ethers.utils.parseEther("1000"));
            await voter.distributeAll();

            // Strategy2 gets 100%
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("1000"));

            // No stuck funds
            expect(await revenueToken.balanceOf(voter.address)).to.equal(0);
        });

        it("multiple epochs of stuck funds accumulate until users reset", async function () {
            const strategy1 = await createStrategy();
            const strategy2 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            // Kill strategy1
            await voter.killStrategy(strategy1);

            // Multiple revenue distributions - 50% gets stuck each time
            for (let i = 0; i < 5; i++) {
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter.distributeAll();
            }

            // Strategy2 gets 250 WETH (50% of 500 total)
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("250"));

            // 250 WETH stuck in Voter (strategy1's share discarded)
            expect(await revenueToken.balanceOf(voter.address)).to.equal(ethers.utils.parseEther("250"));
        });
    });

    describe("User Reset Clears Stuck Funds Issue", function () {

        it("user can reset and vote for different strategy after kill", async function () {
            const strategy1 = await createStrategy();
            const strategy2 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            // Kill strategy1
            await voter.killStrategy(strategy1);

            // Advance epoch
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            // User can vote for strategy2 (which calls _reset internally)
            await voter.connect(user1).vote([strategy2], [100]);

            // Weight moved from dead strategy to alive one
            expect(await voter.strategy_Weight(strategy1)).to.equal(0);
            expect(await voter.strategy_Weight(strategy2)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));

            // Now revenue goes 100% to strategy2
            await sendRevenue(ethers.utils.parseEther("1000"));
            await voter.distributeAll();

            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("1000"));
            expect(await revenueToken.balanceOf(voter.address)).to.equal(0);
        });

        it("partial reset: some users reset, others don't", async function () {
            const strategy1 = await createStrategy();
            const strategy2 = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy1], [100]); // Both vote for strategy1

            // Kill strategy1
            await voter.killStrategy(strategy1);

            // Advance epoch
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            // Only user1 resets - removes 100 from weight
            await voter.connect(user1).reset();

            // User2 still has 100 weight on dead strategy
            expect(await voter.strategy_Weight(strategy1)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));

            // Send revenue - 100% goes to dead strategy (stuck)
            await sendRevenue(ethers.utils.parseEther("1000"));
            await voter.distributeAll();

            // All stuck because only dead strategy has weight
            expect(await revenueToken.balanceOf(voter.address)).to.equal(ethers.utils.parseEther("1000"));

            // Advance another epoch, user2 resets
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");
            await voter.connect(user2).reset();

            // Now totalWeight is 0
            expect(await voter.totalWeight()).to.equal(0);
        });
    });
});
