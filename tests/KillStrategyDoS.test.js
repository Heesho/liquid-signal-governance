const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Tests for Kill Strategy behavior - ensuring users can reset/vote after strategy is killed.
 */
describe("Kill Strategy - User Vote Handling", function () {
    let owner, user1, user2, treasury;
    let underlying, revenueToken, paymentToken;
    let governanceToken, voter;

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

        // Mint and stake tokens
        await underlying.mint(user1.address, ethers.utils.parseEther("100"));
        await underlying.mint(user2.address, ethers.utils.parseEther("100"));
        await underlying.connect(user1).approve(governanceToken.address, ethers.utils.parseEther("100"));
        await underlying.connect(user2).approve(governanceToken.address, ethers.utils.parseEther("100"));
        await governanceToken.connect(user1).stake(ethers.utils.parseEther("100"));
        await governanceToken.connect(user2).stake(ethers.utils.parseEther("100"));
    });

    async function createStrategy() {
        const initPrice = ethers.utils.parseUnits("100", 6);
        const tx = await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "Voter__StrategyAdded");
        return event.args.strategy;
    }

    it("user can reset after strategy is killed", async function () {
        const strategy = await createStrategy();

        // User1 votes for the strategy
        await voter.connect(user1).vote([strategy], [100]);

        expect(await voter.strategy_Weight(strategy)).to.equal(ethers.utils.parseEther("100"));
        expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));

        // Owner kills the strategy
        await voter.killStrategy(strategy);

        // Strategy weight should still be there (so users can withdraw)
        expect(await voter.strategy_Weight(strategy)).to.equal(ethers.utils.parseEther("100"));
        expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));

        // Advance to next epoch
        await ethers.provider.send("evm_increaseTime", [WEEK]);
        await ethers.provider.send("evm_mine");

        // User can successfully reset
        await expect(voter.connect(user1).reset()).to.not.be.reverted;

        // Now weights are properly removed
        expect(await voter.strategy_Weight(strategy)).to.equal(0);
        expect(await voter.totalWeight()).to.equal(0);
        expect(await voter.account_UsedWeights(user1.address)).to.equal(0);
    });

    it("user can vote for new strategy after old strategy is killed", async function () {
        const strategy1 = await createStrategy();
        const strategy2 = await createStrategy();

        // User1 votes for strategy1
        await voter.connect(user1).vote([strategy1], [100]);

        // Owner kills strategy1
        await voter.killStrategy(strategy1);

        // Advance to next epoch
        await ethers.provider.send("evm_increaseTime", [WEEK]);
        await ethers.provider.send("evm_mine");

        // User can vote for strategy2 (which calls _reset internally)
        await expect(voter.connect(user1).vote([strategy2], [100])).to.not.be.reverted;

        // Old strategy weight removed, new strategy has weight
        expect(await voter.strategy_Weight(strategy1)).to.equal(0);
        expect(await voter.strategy_Weight(strategy2)).to.equal(ethers.utils.parseEther("100"));
        expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));
    });

    it("dead strategy does not accumulate new revenue", async function () {
        const strategy1 = await createStrategy();
        const strategy2 = await createStrategy();

        // Both users vote
        await voter.connect(user1).vote([strategy1], [100]);
        await voter.connect(user2).vote([strategy2], [100]);

        // Set up revenue source
        const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
        const revenueRouter = await RevenueRouter.deploy(revenueToken.address, voter.address);
        await voter.setRevenueSource(revenueRouter.address);
        await revenueToken.mint(owner.address, ethers.utils.parseEther("1000"));

        // Kill strategy1
        await voter.killStrategy(strategy1);

        // Send revenue AFTER kill
        await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("1000"));
        await revenueRouter.flush();

        // Update both strategies
        await voter.updateStrategy(strategy1);
        await voter.updateStrategy(strategy2);

        // Dead strategy should have 0 claimable (even though it still has weight)
        // because _updateFor checks strategy_IsAlive
        expect(await voter.strategy_Claimable(strategy1)).to.equal(0);

        // Strategy2 gets its share based on weight ratio (50%)
        // But wait - totalWeight still includes strategy1's weight!
        // So strategy2 only gets 500 WETH (50% of 1000)
        expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("500"));
    });

    it("revenue sent after kill but before user reset: dead strategy share goes to... nowhere (stuck)", async function () {
        // This test documents the current behavior: revenue based on dead strategy weight
        // gets calculated but discarded (not added to claimable because !isAlive)
        const strategy1 = await createStrategy();
        const strategy2 = await createStrategy();

        await voter.connect(user1).vote([strategy1], [100]);
        await voter.connect(user2).vote([strategy2], [100]);

        const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
        const revenueRouter = await RevenueRouter.deploy(revenueToken.address, voter.address);
        await voter.setRevenueSource(revenueRouter.address);
        await revenueToken.mint(owner.address, ethers.utils.parseEther("1000"));

        // Kill strategy1 (weight remains for user to withdraw)
        await voter.killStrategy(strategy1);

        // Send 1000 WETH revenue
        await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("1000"));
        await revenueRouter.flush();

        // Distribute all
        await voter.distro();

        // Strategy2 gets 500 (its 50% share)
        expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("500"));

        // Strategy1's 500 share is stuck in voter (calculated based on weight but discarded)
        expect(await revenueToken.balanceOf(voter.address)).to.equal(ethers.utils.parseEther("500"));

        console.log("\n=== STUCK FUNDS ISSUE (different from DoS) ===");
        console.log("This is a known tradeoff: dead strategy weight remains until users reset");
        console.log("Revenue calculated for dead strategy is discarded, not redistributed");
        console.log("Stuck in Voter:", ethers.utils.formatEther(await revenueToken.balanceOf(voter.address)), "WETH");
        console.log("================================================\n");
    });

    it("after all users reset from dead strategy, no more stuck funds", async function () {
        const strategy1 = await createStrategy();
        const strategy2 = await createStrategy();

        await voter.connect(user1).vote([strategy1], [100]);
        await voter.connect(user2).vote([strategy2], [100]);

        const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
        const revenueRouter = await RevenueRouter.deploy(revenueToken.address, voter.address);
        await voter.setRevenueSource(revenueRouter.address);
        await revenueToken.mint(owner.address, ethers.utils.parseEther("2000"));

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
        await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("1000"));
        await revenueRouter.flush();
        await voter.distro();

        // Strategy2 gets 100%
        expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("1000"));

        // No stuck funds
        expect(await revenueToken.balanceOf(voter.address)).to.equal(0);
    });
});
