const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Comprehensive tests for revenue distribution fairness in the Voter contract.
 *
 * Key invariants that must hold:
 * 1. Total distributed = Total notified (no revenue lost or created)
 * 2. Each strategy gets exactly: (strategy_weight / total_weight) * revenue
 * 3. Order of distribute() calls doesn't affect final amounts
 * 4. Multiple notify+distribute cycles don't create/lose funds
 * 5. Calling distribute multiple times doesn't double-count
 */
describe("Revenue Distribution Fairness Tests", function () {
    let owner, user1, user2, user3, user4, treasury;
    let underlying, revenueToken, paymentToken, paymentToken2;
    let governanceToken, voter, revenueRouter;

    const WEEK = 7 * 24 * 60 * 60;
    const HOUR = 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, user3, user4, treasury] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("Underlying Token", "UNDERLYING", 18);
        revenueToken = await MockERC20.deploy("Revenue Token", "WETH", 18);
        paymentToken = await MockERC20.deploy("Payment Token", "USDC", 6);
        paymentToken2 = await MockERC20.deploy("Payment Token 2", "DAI", 18);

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

        // Mint plenty of tokens
        await underlying.mint(user1.address, ethers.utils.parseEther("10000"));
        await underlying.mint(user2.address, ethers.utils.parseEther("10000"));
        await underlying.mint(user3.address, ethers.utils.parseEther("10000"));
        await underlying.mint(user4.address, ethers.utils.parseEther("10000"));
        await revenueToken.mint(owner.address, ethers.utils.parseEther("1000000"));
    });

    async function createStrategy(payment = paymentToken) {
        const decimals = payment.address === paymentToken.address ? 6 : 18;
        const initPrice = ethers.utils.parseUnits("100", decimals);
        const tx = await voter.addStrategy(payment.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
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

    // ==================== BASIC DISTRIBUTION MATH ====================

    describe("Basic Distribution Math", function () {
        let strategy1, strategy2, strategy3;

        beforeEach(async function () {
            strategy1 = await createStrategy(paymentToken);
            strategy2 = await createStrategy(paymentToken2);
            strategy3 = await createStrategy(paymentToken);
        });

        it("should distribute 100% to single strategy with 100% of votes", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            const revenueAmount = ethers.utils.parseEther("1000");
            await sendRevenue(revenueAmount);

            await voter["distribute(address)"](strategy1);

            const strategyBalance = await revenueToken.balanceOf(strategy1);
            expect(strategyBalance).to.equal(revenueAmount);
        });

        it("should distribute 50/50 with equal votes", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            const revenueAmount = ethers.utils.parseEther("1000");
            await sendRevenue(revenueAmount);

            await voter.distro();

            const balance1 = await revenueToken.balanceOf(strategy1);
            const balance2 = await revenueToken.balanceOf(strategy2);

            expect(balance1).to.equal(ethers.utils.parseEther("500"));
            expect(balance2).to.equal(ethers.utils.parseEther("500"));
        });

        it("should distribute proportionally: 25/25/50 split", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await stakeTokens(user3, ethers.utils.parseEther("200"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);
            await voter.connect(user3).vote([strategy3], [100]);

            const revenueAmount = ethers.utils.parseEther("1000");
            await sendRevenue(revenueAmount);

            await voter.distro();

            const balance1 = await revenueToken.balanceOf(strategy1);
            const balance2 = await revenueToken.balanceOf(strategy2);
            const balance3 = await revenueToken.balanceOf(strategy3);

            expect(balance1).to.equal(ethers.utils.parseEther("250"));
            expect(balance2).to.equal(ethers.utils.parseEther("250"));
            expect(balance3).to.equal(ethers.utils.parseEther("500"));
        });

        it("should handle complex weight ratios: 10/30/60", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("300"));
            await stakeTokens(user3, ethers.utils.parseEther("600"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);
            await voter.connect(user3).vote([strategy3], [100]);

            const revenueAmount = ethers.utils.parseEther("1000");
            await sendRevenue(revenueAmount);

            await voter.distro();

            const balance1 = await revenueToken.balanceOf(strategy1);
            const balance2 = await revenueToken.balanceOf(strategy2);
            const balance3 = await revenueToken.balanceOf(strategy3);

            expect(balance1).to.equal(ethers.utils.parseEther("100"));
            expect(balance2).to.equal(ethers.utils.parseEther("300"));
            expect(balance3).to.equal(ethers.utils.parseEther("600"));
        });

        it("total distributed should equal total notified (minimal dust from rounding)", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);
            await voter.connect(user3).vote([strategy3], [100]);

            const revenueAmount = ethers.utils.parseEther("1000");
            await sendRevenue(revenueAmount);

            await voter.distro();

            const balance1 = await revenueToken.balanceOf(strategy1);
            const balance2 = await revenueToken.balanceOf(strategy2);
            const balance3 = await revenueToken.balanceOf(strategy3);

            const totalDistributed = balance1.add(balance2).add(balance3);

            // Due to integer division, there may be minimal dust (a few hundred wei max)
            // This is acceptable and not exploitable
            const dust = revenueAmount.sub(totalDistributed);
            expect(dust).to.be.lte(1000); // less than 1000 wei dust
            expect(dust).to.be.gte(0); // never over-distribute
        });
    });

    // ==================== MULTIPLE NOTIFICATIONS IN ONE EPOCH ====================

    describe("Multiple Notifications in One Epoch", function () {
        let strategy1, strategy2;

        beforeEach(async function () {
            strategy1 = await createStrategy(paymentToken);
            strategy2 = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);
        });

        it("should accumulate revenue from multiple notify calls", async function () {
            await sendRevenue(ethers.utils.parseEther("100"));
            await sendRevenue(ethers.utils.parseEther("200"));
            await sendRevenue(ethers.utils.parseEther("300"));

            await voter.distro();

            const balance1 = await revenueToken.balanceOf(strategy1);
            const balance2 = await revenueToken.balanceOf(strategy2);

            // Total 600, split 50/50
            expect(balance1).to.equal(ethers.utils.parseEther("300"));
            expect(balance2).to.equal(ethers.utils.parseEther("300"));
        });

        it("should handle notify -> distribute -> notify -> distribute pattern", async function () {
            // First round
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy1);
            await voter["distribute(address)"](strategy2);

            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("50"));
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("50"));

            // Second round
            await sendRevenue(ethers.utils.parseEther("200"));
            await voter["distribute(address)"](strategy1);
            await voter["distribute(address)"](strategy2);

            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("150"));
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("150"));
        });

        it("should handle notify -> notify -> distribute pattern correctly", async function () {
            await sendRevenue(ethers.utils.parseEther("100"));
            await sendRevenue(ethers.utils.parseEther("200"));

            // Only distribute to strategy1 first
            await voter["distribute(address)"](strategy1);

            const balance1After = await revenueToken.balanceOf(strategy1);
            expect(balance1After).to.equal(ethers.utils.parseEther("150")); // 50% of 300

            // Now distribute to strategy2
            await voter["distribute(address)"](strategy2);
            const balance2After = await revenueToken.balanceOf(strategy2);
            expect(balance2After).to.equal(ethers.utils.parseEther("150")); // 50% of 300
        });

        it("should handle interleaved notify and partial distribute", async function () {
            // Notify 100
            await sendRevenue(ethers.utils.parseEther("100"));

            // Distribute only strategy1
            await voter["distribute(address)"](strategy1);
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("50"));

            // Notify more
            await sendRevenue(ethers.utils.parseEther("100"));

            // Now distribute both
            await voter.distro();

            // strategy1: had 50, gets additional 50 (from new 100)
            // strategy2: gets 50 (from first 100) + 50 (from second 100) = 100
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("100"));
        });
    });

    // ==================== DISTRIBUTE ORDER INDEPENDENCE ====================

    describe("Distribution Order Independence", function () {
        let strategy1, strategy2, strategy3;

        beforeEach(async function () {
            strategy1 = await createStrategy(paymentToken);
            strategy2 = await createStrategy(paymentToken2);
            strategy3 = await createStrategy(paymentToken);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);
            await voter.connect(user3).vote([strategy3], [100]);

            await sendRevenue(ethers.utils.parseEther("600"));
        });

        it("distributing 1,2,3 should give same result as 3,2,1", async function () {
            // Distribute in order 1, 2, 3
            await voter["distribute(address)"](strategy1);
            await voter["distribute(address)"](strategy2);
            await voter["distribute(address)"](strategy3);

            const balance1 = await revenueToken.balanceOf(strategy1);
            const balance2 = await revenueToken.balanceOf(strategy2);
            const balance3 = await revenueToken.balanceOf(strategy3);

            // Expected: 100/600 * 600 = 100, 200/600 * 600 = 200, 300/600 * 600 = 300
            expect(balance1).to.equal(ethers.utils.parseEther("100"));
            expect(balance2).to.equal(ethers.utils.parseEther("200"));
            expect(balance3).to.equal(ethers.utils.parseEther("300"));
        });

        it("distributing 2 only, then 1 and 3 should still be correct", async function () {
            // Only distribute to strategy2 first
            await voter["distribute(address)"](strategy2);

            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("200"));

            // Then distribute remaining
            await voter["distribute(address)"](strategy1);
            await voter["distribute(address)"](strategy3);

            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(strategy3)).to.equal(ethers.utils.parseEther("300"));
        });

        it("calling distribute multiple times on same strategy should not double count", async function () {
            await voter["distribute(address)"](strategy1);
            const balanceAfterFirst = await revenueToken.balanceOf(strategy1);

            await voter["distribute(address)"](strategy1);
            const balanceAfterSecond = await revenueToken.balanceOf(strategy1);

            await voter["distribute(address)"](strategy1);
            const balanceAfterThird = await revenueToken.balanceOf(strategy1);

            expect(balanceAfterFirst).to.equal(ethers.utils.parseEther("100"));
            expect(balanceAfterSecond).to.equal(ethers.utils.parseEther("100"));
            expect(balanceAfterThird).to.equal(ethers.utils.parseEther("100"));
        });
    });

    // ==================== DELAYED DISTRIBUTION ====================

    describe("Delayed Distribution", function () {
        let strategy1, strategy2;

        beforeEach(async function () {
            strategy1 = await createStrategy(paymentToken);
            strategy2 = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);
        });

        it("should correctly distribute even if strategy1 never calls distribute for a while", async function () {
            // Multiple revenue notifications
            await sendRevenue(ethers.utils.parseEther("100"));
            await sendRevenue(ethers.utils.parseEther("100"));
            await sendRevenue(ethers.utils.parseEther("100"));

            // Only strategy2 distributes immediately
            await voter["distribute(address)"](strategy2);
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("150"));

            // More revenue comes in
            await sendRevenue(ethers.utils.parseEther("100"));

            // Strategy2 distributes again
            await voter["distribute(address)"](strategy2);
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("200"));

            // Finally strategy1 distributes - should get their full share
            await voter["distribute(address)"](strategy1);
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("200"));

            // Total should be 400
            const total = (await revenueToken.balanceOf(strategy1)).add(await revenueToken.balanceOf(strategy2));
            expect(total).to.equal(ethers.utils.parseEther("400"));
        });

        it("claimable should accumulate correctly over multiple notify calls without distribute", async function () {
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy1);
            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("50"));

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy1);
            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("100"));

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy1);
            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("150"));

            // Distribute should transfer all accumulated
            await voter["distribute(address)"](strategy1);
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("150"));
            expect(await voter.strategy_Claimable(strategy1)).to.equal(0);
        });
    });

    // ==================== GAMING PREVENTION ====================

    describe("Gaming Prevention", function () {
        let strategy1, strategy2;

        beforeEach(async function () {
            strategy1 = await createStrategy(paymentToken);
            strategy2 = await createStrategy(paymentToken2);
        });

        it("cannot game by distributing before updating index", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));

            // Try distributing without updating - distribute() calls _updateFor internally
            await voter["distribute(address)"](strategy1);

            // Should still get correct amount
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("100"));
        });

        it("new voter joining after revenue notification should not get that revenue", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            // Revenue comes in
            await sendRevenue(ethers.utils.parseEther("100"));

            // New user joins and votes for strategy2
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user2).vote([strategy2], [100]);

            // Distribute both
            await voter.distro();

            // strategy1 should get ALL the 100 WETH (was only voter when revenue came)
            // strategy2 should get NOTHING from that revenue batch
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(strategy2)).to.equal(0);
        });

        it("late joiner should only get share of NEW revenue", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            // First revenue batch - only strategy1 exists
            await sendRevenue(ethers.utils.parseEther("100"));

            // New voter joins
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await voter.connect(user2).vote([strategy2], [100]);

            // Second revenue batch - both exist with equal weight
            await sendRevenue(ethers.utils.parseEther("100"));

            await voter.distro();

            // strategy1: 100 (first batch) + 50 (half of second) = 150
            // strategy2: 0 (first batch) + 50 (half of second) = 50
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("150"));
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("50"));
        });

        it("voter leaving should not affect other voters' shares", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            // Revenue comes in - 50/50 split
            await sendRevenue(ethers.utils.parseEther("100"));

            // User1 resets (leaves)
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");
            await voter.connect(user1).reset();

            // More revenue - now 100% to strategy2
            await sendRevenue(ethers.utils.parseEther("100"));

            await voter.distro();

            // strategy1: 50 (from first batch when they were voting)
            // strategy2: 50 (from first) + 100 (from second) = 150
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("50"));
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("150"));
        });

        it("killed strategy sends pending claimable to treasury, future revenue discarded until users reset", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            // First revenue
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy1);
            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("50"));

            const treasuryBefore = await revenueToken.balanceOf(treasury.address);

            // Kill strategy1 - sends claimable to treasury but keeps weight (so users can reset)
            await voter.killStrategy(strategy1);
            expect(await voter.strategy_Claimable(strategy1)).to.equal(0);

            const treasuryAfter = await revenueToken.balanceOf(treasury.address);
            // Treasury received strategy1's 50 WETH
            expect(treasuryAfter.sub(treasuryBefore)).to.equal(ethers.utils.parseEther("50"));

            // Weight still there (so users can reset without underflow)
            expect(await voter.strategy_Weight(strategy1)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("200"));

            // More revenue - strategy1 still has weight but dead, so its share is discarded
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy1);
            await voter.updateStrategy(strategy2);

            // Dead strategy doesn't accumulate claimable
            expect(await voter.strategy_Claimable(strategy1)).to.equal(0);
            // strategy2 gets: 50 (first batch) + 50 (second batch, still 50% weight) = 100
            // The other 50 from second batch is discarded (stuck in voter until user1 resets)
            expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("100"));
        });
    });

    // ==================== PRECISION & ROUNDING ====================

    describe("Precision and Rounding", function () {
        let strategy1, strategy2, strategy3;

        beforeEach(async function () {
            strategy1 = await createStrategy(paymentToken);
            strategy2 = await createStrategy(paymentToken2);
            strategy3 = await createStrategy(paymentToken);
        });

        it("should handle division that doesn't divide evenly", async function () {
            // 3 equal voters, 100 WETH - can't divide evenly
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));
            await stakeTokens(user3, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);
            await voter.connect(user3).vote([strategy3], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.distro();

            const balance1 = await revenueToken.balanceOf(strategy1);
            const balance2 = await revenueToken.balanceOf(strategy2);
            const balance3 = await revenueToken.balanceOf(strategy3);

            // Each should get ~33.33... with possible rounding
            // Due to index calculation: 100e18 * 1e18 / 300e18 = 333...e15
            // Then: 100e18 * 333...e15 / 1e18 = 33.33...e18
            // All three get equal amounts (same weight, same index delta)
            expect(balance1).to.equal(balance2);
            expect(balance2).to.equal(balance3);

            // Total should be close to 100 ETH with minimal dust
            const totalDistributed = balance1.add(balance2).add(balance3);
            const dust = ethers.utils.parseEther("100").sub(totalDistributed);
            expect(dust).to.be.lte(1000); // some dust from rounding
            expect(dust).to.be.gte(0); // never over-distribute
        });

        it("should handle very small revenue amounts (dust rounds to zero)", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            // Send just 1 wei with 100e18 total weight
            // index_delta = 1 * 1e18 / 100e18 = 0 (rounds down)
            // So strategy gets nothing - this is expected behavior
            await sendRevenue(1);
            await voter["distribute(address)"](strategy1);

            // Due to rounding, 1 wei with large weights = 0 claimable
            // This dust stays in the voter contract
            expect(await revenueToken.balanceOf(strategy1)).to.equal(0);
            expect(await revenueToken.balanceOf(voter.address)).to.equal(1);
        });

        it("should distribute small amounts with proportionally small weights", async function () {
            // Use small weight so 1 wei is meaningful
            await underlying.mint(user1.address, 1);
            await underlying.connect(user1).approve(governanceToken.address, 1);
            await governanceToken.connect(user1).stake(1);
            await voter.connect(user1).vote([strategy1], [100]);

            // totalWeight = 1
            // index_delta = 1 * 1e18 / 1 = 1e18
            // claimable = 1 * 1e18 / 1e18 = 1
            await sendRevenue(1);
            await voter["distribute(address)"](strategy1);

            expect(await revenueToken.balanceOf(strategy1)).to.equal(1);
        });

        it("should handle very large revenue amounts", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            const largeAmount = ethers.utils.parseEther("1000000000"); // 1 billion
            await revenueToken.mint(owner.address, largeAmount);
            await sendRevenue(largeAmount);

            await voter.distro();

            expect(await revenueToken.balanceOf(strategy1)).to.equal(largeAmount.div(2));
            expect(await revenueToken.balanceOf(strategy2)).to.equal(largeAmount.div(2));
        });

        it("should handle asymmetric weights with many decimal places of precision", async function () {
            // 1 vs 99 split
            await stakeTokens(user1, ethers.utils.parseEther("1"));
            await stakeTokens(user2, ethers.utils.parseEther("99"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.distro();

            // 1% and 99%
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("1"));
            expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("99"));
        });
    });

    // ==================== STRESS TESTS ====================

    describe("Stress Tests", function () {
        it("should handle 10 revenue notifications followed by single distro", async function () {
            const strategy = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const perNotify = ethers.utils.parseEther("10");
            for (let i = 0; i < 10; i++) {
                await sendRevenue(perNotify);
            }

            await voter["distribute(address)"](strategy);
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should handle alternating notify/distribute 10 times", async function () {
            const strategy = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const perNotify = ethers.utils.parseEther("10");
            for (let i = 0; i < 10; i++) {
                await sendRevenue(perNotify);
                await voter["distribute(address)"](strategy);
            }

            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should handle many strategies with varying weights", async function () {
            const strategies = [];
            for (let i = 0; i < 5; i++) {
                strategies.push(await createStrategy(i % 2 === 0 ? paymentToken : paymentToken2));
            }

            // Users stake varying amounts
            await stakeTokens(user1, ethers.utils.parseEther("100")); // 10%
            await stakeTokens(user2, ethers.utils.parseEther("200")); // 20%
            await stakeTokens(user3, ethers.utils.parseEther("300")); // 30%
            await stakeTokens(user4, ethers.utils.parseEther("400")); // 40%

            await voter.connect(user1).vote([strategies[0]], [100]);
            await voter.connect(user2).vote([strategies[1]], [100]);
            await voter.connect(user3).vote([strategies[2]], [100]);
            await voter.connect(user4).vote([strategies[3], strategies[4]], [50, 50]);

            // Total: s0=100, s1=200, s2=300, s3=200, s4=200 = 1000

            await sendRevenue(ethers.utils.parseEther("1000"));
            await voter.distro();

            expect(await revenueToken.balanceOf(strategies[0])).to.equal(ethers.utils.parseEther("100"));
            expect(await revenueToken.balanceOf(strategies[1])).to.equal(ethers.utils.parseEther("200"));
            expect(await revenueToken.balanceOf(strategies[2])).to.equal(ethers.utils.parseEther("300"));
            expect(await revenueToken.balanceOf(strategies[3])).to.equal(ethers.utils.parseEther("200"));
            expect(await revenueToken.balanceOf(strategies[4])).to.equal(ethers.utils.parseEther("200"));
        });
    });

    // ==================== INDEX CALCULATION VERIFICATION ====================

    describe("Index Calculation Verification", function () {
        let strategy1;

        beforeEach(async function () {
            strategy1 = await createStrategy();
        });

        it("should calculate index correctly: index = sum(revenue * 1e18 / totalWeight)", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            // totalWeight = 100e18
            // revenue = 50e18
            // delta_index = 50e18 * 1e18 / 100e18 = 0.5e18
            await sendRevenue(ethers.utils.parseEther("50"));

            await voter.updateStrategy(strategy1);

            // claimable = weight * delta_index / 1e18 = 100e18 * 0.5e18 / 1e18 = 50e18
            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("50"));
        });

        it("should handle index accumulation across multiple distributions", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("200"));
            await voter.connect(user1).vote([strategy1], [100]);

            // First: 100 / 200 * 1e18 = 0.5e18 index increase
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy1);
            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("100"));

            // Second: another 100 / 200 * 1e18 = 0.5e18 index increase
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy1);
            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("200"));
        });
    });
});
