const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Comprehensive Business Logic Tests
 *
 * Tests cover critical business logic scenarios not fully covered in other test files:
 * 1. Strategy auction mechanics (price decay, epoch transitions, price clamping)
 * 2. BribeRouter edge cases (distribution thresholds, timing)
 * 3. Bribe reward calculation edge cases
 * 4. GovernanceToken security and edge cases
 * 5. Multi-epoch complex scenarios
 * 6. Integration correctness invariants
 */
describe("Business Logic Tests", function () {
    let owner, user1, user2, user3, treasury, buyer1, buyer2;
    let underlying, revenueToken, paymentToken, paymentToken2;
    let governanceToken, voter, bribeFactory, strategyFactory, revenueRouter;

    const WEEK = 7 * 24 * 60 * 60;
    const DAY = 24 * 60 * 60;
    const HOUR = 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, user3, treasury, buyer1, buyer2] = await ethers.getSigners();

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

        // Mint tokens
        for (const user of [user1, user2, user3]) {
            await underlying.mint(user.address, ethers.utils.parseEther("10000"));
        }
        await revenueToken.mint(owner.address, ethers.utils.parseEther("1000000"));
        for (const buyer of [buyer1, buyer2]) {
            await paymentToken.mint(buyer.address, ethers.utils.parseUnits("1000000", 6));
            await paymentToken2.mint(buyer.address, ethers.utils.parseEther("1000000"));
        }
    });

    // Helper functions
    async function createStrategy(payment = paymentToken, params = {}) {
        const decimals = await payment.decimals();
        const initPrice = params.initPrice || ethers.utils.parseUnits("100", decimals);
        const epochPeriod = params.epochPeriod || HOUR;
        const priceMultiplier = params.priceMultiplier || ethers.utils.parseEther("2");
        const minInitPrice = params.minInitPrice || initPrice;

        const tx = await voter.addStrategy(
            payment.address,
            params.receiver || treasury.address,
            initPrice,
            epochPeriod,
            priceMultiplier,
            minInitPrice
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

    async function buyFromStrategy(strategyAddr, buyer, payment = paymentToken) {
        const strategy = await ethers.getContractAt("Strategy", strategyAddr);
        const epochId = await strategy.epochId();
        const price = await strategy.getPrice();

        await payment.connect(buyer).approve(strategy.address, price);
        const block = await ethers.provider.getBlock("latest");
        const deadline = block.timestamp + 3600;

        await strategy.connect(buyer).buy(buyer.address, epochId, deadline, price);
        return price;
    }

    // ==================== STRATEGY AUCTION MECHANICS ====================

    describe("Strategy Auction Mechanics", function () {
        describe("Price Decay", function () {
            it("should decay linearly from initPrice to 0 over epochPeriod", async function () {
                const { strategy } = await createStrategy();
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter["distribute(address)"](strategy);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const initPrice = await strategyContract.initPrice();

                // At t=0, price = initPrice
                const price0 = await strategyContract.getPrice();
                expect(price0).to.be.closeTo(initPrice, initPrice.div(100));

                // At t=epochPeriod/4, price = 75% of initPrice
                await advanceTime(HOUR / 4);
                const price25 = await strategyContract.getPrice();
                expect(price25).to.be.closeTo(initPrice.mul(75).div(100), initPrice.div(50));

                // At t=epochPeriod/2, price = 50% of initPrice
                await advanceTime(HOUR / 4);
                const price50 = await strategyContract.getPrice();
                expect(price50).to.be.closeTo(initPrice.mul(50).div(100), initPrice.div(50));

                // At t=3*epochPeriod/4, price = 25% of initPrice
                await advanceTime(HOUR / 4);
                const price75 = await strategyContract.getPrice();
                expect(price75).to.be.closeTo(initPrice.mul(25).div(100), initPrice.div(50));

                // At t=epochPeriod, price = 0
                await advanceTime(HOUR / 4 + 60);
                const price100 = await strategyContract.getPrice();
                expect(price100).to.equal(0);
            });

            it("should stay at 0 after epochPeriod passes", async function () {
                const { strategy } = await createStrategy();
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter["distribute(address)"](strategy);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);

                // Way past epoch
                await advanceTime(HOUR * 10);
                expect(await strategyContract.getPrice()).to.equal(0);
            });
        });

        describe("Epoch Transitions", function () {
            it("should start new epoch with adjusted price after buy", async function () {
                const { strategy } = await createStrategy();
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter["distribute(address)"](strategy);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const epochIdBefore = await strategyContract.epochId();

                await buyFromStrategy(strategy, buyer1);

                const epochIdAfter = await strategyContract.epochId();
                const startTimeAfter = await strategyContract.startTime();
                const initPriceAfter = await strategyContract.initPrice();

                // Epoch ID incremented
                expect(epochIdAfter).to.equal(epochIdBefore.add(1));

                // Start time reset to now
                const block = await ethers.provider.getBlock("latest");
                expect(startTimeAfter.toNumber()).to.be.closeTo(block.timestamp, 2);

                // Price at new epoch start should be close to new initPrice
                expect(await strategyContract.getPrice()).to.be.closeTo(initPriceAfter, initPriceAfter.div(100));
            });

            it("should increment epochId by 1 on each buy (no overflow)", async function () {
                const { strategy } = await createStrategy();
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);

                for (let i = 0; i < 5; i++) {
                    await sendRevenue(ethers.utils.parseEther("10"));
                    await voter["distribute(address)"](strategy);

                    const epochIdBefore = await strategyContract.epochId();
                    expect(epochIdBefore).to.equal(i);

                    await buyFromStrategy(strategy, buyer1);

                    const epochIdAfter = await strategyContract.epochId();
                    expect(epochIdAfter).to.equal(i + 1);
                }
            });
        });

        describe("Price Multiplier and Clamping", function () {
            it("should clamp new initPrice to minInitPrice when payment is low", async function () {
                // Create strategy with high minInitPrice
                const minInitPrice = ethers.utils.parseUnits("50", 6);
                const { strategy } = await createStrategy(paymentToken, {
                    initPrice: ethers.utils.parseUnits("100", 6),
                    priceMultiplier: ethers.utils.parseEther("1.1"), // 1.1x
                    minInitPrice: minInitPrice
                });

                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter["distribute(address)"](strategy);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);

                // Wait for price to drop very low
                await advanceTime(HOUR - 60);
                const lowPrice = await strategyContract.getPrice();
                expect(lowPrice).to.be.lt(minInitPrice);

                // Buy at low price
                const epochId = await strategyContract.epochId();
                await paymentToken.connect(buyer1).approve(strategy, lowPrice);
                const block = await ethers.provider.getBlock("latest");
                await strategyContract.connect(buyer1).buy(buyer1.address, epochId, block.timestamp + 3600, lowPrice);

                // New initPrice should be clamped to minInitPrice
                const initPriceAfter = await strategyContract.initPrice();
                expect(initPriceAfter).to.equal(minInitPrice);
            });

            it("should apply priceMultiplier correctly", async function () {
                const { strategy } = await createStrategy(paymentToken, {
                    initPrice: ethers.utils.parseUnits("100", 6),
                    priceMultiplier: ethers.utils.parseEther("1.5"), // 1.5x
                    minInitPrice: ethers.utils.parseUnits("1", 6)
                });

                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter["distribute(address)"](strategy);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const pricePaid = await buyFromStrategy(strategy, buyer1);

                const initPriceAfter = await strategyContract.initPrice();
                // New initPrice = pricePaid * 1.5
                const expectedNewPrice = pricePaid.mul(15).div(10);
                expect(initPriceAfter).to.be.closeTo(expectedNewPrice, expectedNewPrice.div(100));
            });

            it("should handle free purchase (price = 0) and use minInitPrice", async function () {
                const minInitPrice = ethers.utils.parseUnits("10", 6);
                const { strategy } = await createStrategy(paymentToken, {
                    initPrice: ethers.utils.parseUnits("100", 6),
                    priceMultiplier: ethers.utils.parseEther("2"),
                    minInitPrice: minInitPrice
                });

                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter["distribute(address)"](strategy);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);

                // Wait for price to reach 0
                await advanceTime(HOUR + 60);
                expect(await strategyContract.getPrice()).to.equal(0);

                // Buy for free
                const epochId = await strategyContract.epochId();
                const block = await ethers.provider.getBlock("latest");
                await strategyContract.connect(buyer1).buy(buyer1.address, epochId, block.timestamp + 3600, 0);

                // New initPrice should be minInitPrice (0 * priceMultiplier = 0, clamped to min)
                const initPriceAfter = await strategyContract.initPrice();
                expect(initPriceAfter).to.equal(minInitPrice);
            });
        });

        describe("Deadline and Frontrun Protection", function () {
            it("should revert if deadline has passed", async function () {
                const { strategy } = await createStrategy();
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter["distribute(address)"](strategy);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const epochId = await strategyContract.epochId();
                const price = await strategyContract.getPrice();

                await paymentToken.connect(buyer1).approve(strategy, price);
                const block = await ethers.provider.getBlock("latest");
                const pastDeadline = block.timestamp - 1;

                await expect(
                    strategyContract.connect(buyer1).buy(buyer1.address, epochId, pastDeadline, price)
                ).to.be.reverted;
            });

            it("should revert if maxPaymentAmount exceeded", async function () {
                const { strategy } = await createStrategy();
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
                await voter["distribute(address)"](strategy);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const epochId = await strategyContract.epochId();
                const price = await strategyContract.getPrice();

                await paymentToken.connect(buyer1).approve(strategy, price);
                const block = await ethers.provider.getBlock("latest");

                // Set maxPaymentAmount below current price
                await expect(
                    strategyContract.connect(buyer1).buy(buyer1.address, epochId, block.timestamp + 3600, price.div(2))
                ).to.be.reverted;
            });

            it("should revert if strategy has no revenue tokens", async function () {
                const { strategy } = await createStrategy();
                // Don't send any revenue

                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const epochId = await strategyContract.epochId();
                const price = await strategyContract.getPrice();

                await paymentToken.connect(buyer1).approve(strategy, price);
                const block = await ethers.provider.getBlock("latest");

                await expect(
                    strategyContract.connect(buyer1).buy(buyer1.address, epochId, block.timestamp + 3600, price)
                ).to.be.reverted;
            });
        });
    });

    // ==================== BRIBE ROUTER MECHANICS ====================

    describe("BribeRouter Mechanics", function () {
        it("should not distribute if balance <= left()", async function () {
            const { strategy, bribeRouter, bribe } = await createStrategy();

            await voter.setBribeSplit(2000); // 20%
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            // First buy and distribute - starts reward period
            await buyFromStrategy(strategy, buyer1);
            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            // Second buy - smaller amount
            await sendRevenue(ethers.utils.parseEther("10"));
            await voter["distribute(address)"](strategy);
            await advanceTime(60); // Small time advance so price drops a lot
            await advanceTime(HOUR - 120); // Near end of epoch
            await buyFromStrategy(strategy, buyer1);

            // Balance in bribe router after second buy
            const balance = await paymentToken.balanceOf(bribeRouter);
            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const left = await bribeContract.left(paymentToken.address);

            // If balance <= left, distribute should not trigger notifyRewardAmount
            if (balance.lte(left)) {
                const bribeBalanceBefore = await paymentToken.balanceOf(bribe);
                await bribeRouterContract.distribute();
                const bribeBalanceAfter = await paymentToken.balanceOf(bribe);
                // No change because balance <= left
                expect(bribeBalanceAfter).to.equal(bribeBalanceBefore);
            }
        });

        it("should distribute when balance > left()", async function () {
            const { strategy, bribeRouter, bribe } = await createStrategy();

            await voter.setBribeSplit(2000);
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            // First buy - high payment
            await buyFromStrategy(strategy, buyer1);

            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            const balance = await paymentToken.balanceOf(bribeRouter);
            expect(balance).to.be.gt(0);

            // left() should be 0 since no rewards distributed yet
            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            expect(await bribeContract.left(paymentToken.address)).to.equal(0);

            // Distribute should work
            await bribeRouterContract.distribute();

            // Bribe should now have the tokens
            expect(await paymentToken.balanceOf(bribe)).to.be.gt(0);
        });
    });

    // ==================== BRIBE REWARD CALCULATIONS ====================

    describe("Bribe Reward Calculations", function () {
        it("should calculate earned correctly with time passage", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            await voter.setBribeSplit(2000);
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            await buyFromStrategy(strategy, buyer1);
            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const rewardData = await bribeContract.token_RewardData(paymentToken.address);
            const totalReward = rewardData.rewardRate.mul(WEEK);

            // After half the duration, earned should be ~50% of total
            await advanceTime(WEEK / 2);
            const earnedHalf = await bribeContract.earned(user1.address, paymentToken.address);
            expect(earnedHalf).to.be.closeTo(totalReward.div(2), totalReward.div(100));

            // After full duration, earned should be ~100% of total
            await advanceTime(WEEK / 2);
            const earnedFull = await bribeContract.earned(user1.address, paymentToken.address);
            expect(earnedFull).to.be.closeTo(totalReward, totalReward.div(100));
        });

        it("should split rewards proportionally between voters", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            await voter.setBribeSplit(2000);

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

            // User2 should earn 3x user1
            expect(earned2).to.be.closeTo(earned1.mul(3), earned1.div(10));
        });

        it("should handle reward notification when existing rewards still streaming", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            await voter.setBribeSplit(5000); // 50% to maximize bribe
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // First reward distribution
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            await buyFromStrategy(strategy, buyer1);
            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const rewardRate1 = (await bribeContract.token_RewardData(paymentToken.address)).rewardRate;

            // Halfway through, add more rewards
            await advanceTime(WEEK / 2);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            await buyFromStrategy(strategy, buyer1);
            await bribeRouterContract.distribute();

            const rewardRate2 = (await bribeContract.token_RewardData(paymentToken.address)).rewardRate;

            // New reward rate should be >= original (existing leftover + new rewards / DURATION)
            // It may be equal if amounts are similar and integer division rounds same
            expect(rewardRate2).to.be.gte(rewardRate1);
        });

        it("should handle getReward correctly", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            await voter.setBribeSplit(2000);
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            await buyFromStrategy(strategy, buyer1);

            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            await advanceTime(WEEK);

            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const earnedBefore = await bribeContract.earned(user1.address, paymentToken.address);
            const balanceBefore = await paymentToken.balanceOf(user1.address);

            await bribeContract.getReward(user1.address);

            const earnedAfter = await bribeContract.earned(user1.address, paymentToken.address);
            const balanceAfter = await paymentToken.balanceOf(user1.address);

            // Earned should be 0 after claim
            expect(earnedAfter).to.equal(0);
            // Balance should increase by earned amount
            expect(balanceAfter.sub(balanceBefore)).to.be.closeTo(earnedBefore, earnedBefore.div(100));
        });
    });

    // ==================== GOVERNANCE TOKEN EDGE CASES ====================

    describe("GovernanceToken Edge Cases", function () {
        it("should allow changing voter (for emergency reset)", async function () {
            // Create fresh governance token
            const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
            const newGovToken = await GovernanceToken.deploy(underlying.address, "Test", "TEST");

            await newGovToken.setVoter(user1.address);
            await newGovToken.setVoter(user2.address);
            expect(await newGovToken.voter()).to.equal(user2.address);

            // Can also reset to address(0) to open withdrawals
            await newGovToken.setVoter(ethers.constants.AddressZero);
            expect(await newGovToken.voter()).to.equal(ethers.constants.AddressZero);
        });

        it("should allow unstaking when voter is not set", async function () {
            const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
            const newGovToken = await GovernanceToken.deploy(underlying.address, "Test", "TEST");

            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(newGovToken.address, amount);
            await newGovToken.connect(user1).stake(amount);

            // Voter not set, can unstake freely
            await newGovToken.connect(user1).unstake(amount);
            expect(await newGovToken.balanceOf(user1.address)).to.equal(0);
        });

        it("should revert stake with zero amount", async function () {
            await expect(governanceToken.connect(user1).stake(0)).to.be.reverted;
        });

        it("should revert unstake with zero amount", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await expect(governanceToken.connect(user1).unstake(0)).to.be.reverted;
        });

        it("should handle approve correctly (even though transfer disabled)", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            // Approve should work
            await governanceToken.connect(user1).approve(user2.address, ethers.utils.parseEther("50"));
            expect(await governanceToken.allowance(user1.address, user2.address)).to.equal(ethers.utils.parseEther("50"));

            // But transferFrom should fail
            await expect(
                governanceToken.connect(user2).transferFrom(user1.address, user2.address, ethers.utils.parseEther("50"))
            ).to.be.reverted;
        });
    });

    // ==================== REVENUE ROUTER EDGE CASES ====================

    describe("RevenueRouter Edge Cases", function () {
        it("should revert flush with zero balance", async function () {
            await expect(revenueRouter.flush()).to.be.reverted;
        });

        it("should succeed flushIfAvailable with zero balance", async function () {
            await revenueRouter.flushIfAvailable();
            // No revert, just returns 0
        });

        it("should return pending revenue correctly", async function () {
            expect(await revenueRouter.pendingRevenue()).to.equal(0);

            await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("100"));
            expect(await revenueRouter.pendingRevenue()).to.equal(ethers.utils.parseEther("100"));
        });
    });

    // ==================== COMPLEX MULTI-EPOCH SCENARIOS ====================

    describe("Complex Multi-Epoch Scenarios", function () {
        it("should correctly handle weight changes across epochs with revenue", async function () {
            const { strategy: s1 } = await createStrategy(paymentToken);
            const { strategy: s2 } = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("100"));

            // Epoch 1: Both vote for s1
            await voter.connect(user1).vote([s1], [100]);
            await voter.connect(user2).vote([s1], [100]);
            await sendRevenue(ethers.utils.parseEther("200"));
            await voter.distro();

            expect(await revenueToken.balanceOf(s1)).to.equal(ethers.utils.parseEther("200"));
            expect(await revenueToken.balanceOf(s2)).to.equal(0);

            // Epoch 2: User1 switches to s2
            await advanceTime(WEEK);
            await voter.connect(user1).vote([s2], [100]);
            // User2 keeps voting for s1
            await voter.connect(user2).vote([s1], [100]);

            await sendRevenue(ethers.utils.parseEther("200"));
            await voter.distro();

            // s1 gets 100 (user2's 50%), s2 gets 100 (user1's 50%)
            expect(await revenueToken.balanceOf(s1)).to.equal(ethers.utils.parseEther("300"));
            expect(await revenueToken.balanceOf(s2)).to.equal(ethers.utils.parseEther("100"));

            // Epoch 3: Both vote for s2
            await advanceTime(WEEK);
            await voter.connect(user1).vote([s2], [100]);
            await voter.connect(user2).vote([s2], [100]);

            await sendRevenue(ethers.utils.parseEther("200"));
            await voter.distro();

            // s1 gets nothing new, s2 gets all 200
            expect(await revenueToken.balanceOf(s1)).to.equal(ethers.utils.parseEther("300"));
            expect(await revenueToken.balanceOf(s2)).to.equal(ethers.utils.parseEther("300"));
        });

        it("should handle user leaving and rejoining governance", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("100"));

            // User1 resets and unstakes
            await advanceTime(WEEK);
            await voter.connect(user1).reset();
            await governanceToken.connect(user1).unstake(ethers.utils.parseEther("100"));

            // More revenue with no voters -> treasury
            const treasuryBefore = await revenueToken.balanceOf(treasury.address);
            await sendRevenue(ethers.utils.parseEther("100"));
            const treasuryAfter = await revenueToken.balanceOf(treasury.address);
            expect(treasuryAfter.sub(treasuryBefore)).to.equal(ethers.utils.parseEther("100"));

            // User1 rejoins
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await advanceTime(WEEK);
            await voter.connect(user1).vote([strategy], [100]);

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("200"));
        });

        it("should maintain correct bribe balances through voting changes", async function () {
            const { strategy: s1, bribe: b1 } = await createStrategy(paymentToken);
            const { strategy: s2, bribe: b2 } = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            const bribe1 = await ethers.getContractAt("Bribe", b1);
            const bribe2 = await ethers.getContractAt("Bribe", b2);

            // Vote for s1
            await voter.connect(user1).vote([s1], [100]);
            expect(await bribe1.account_Balance(user1.address)).to.equal(ethers.utils.parseEther("100"));
            expect(await bribe2.account_Balance(user1.address)).to.equal(0);
            expect(await bribe1.totalSupply()).to.equal(ethers.utils.parseEther("100"));

            // Switch to s2
            await advanceTime(WEEK);
            await voter.connect(user1).vote([s2], [100]);
            expect(await bribe1.account_Balance(user1.address)).to.equal(0);
            expect(await bribe2.account_Balance(user1.address)).to.equal(ethers.utils.parseEther("100"));
            expect(await bribe1.totalSupply()).to.equal(0);
            expect(await bribe2.totalSupply()).to.equal(ethers.utils.parseEther("100"));

            // Split between both
            await advanceTime(WEEK);
            await voter.connect(user1).vote([s1, s2], [50, 50]);
            expect(await bribe1.account_Balance(user1.address)).to.equal(ethers.utils.parseEther("50"));
            expect(await bribe2.account_Balance(user1.address)).to.equal(ethers.utils.parseEther("50"));
        });
    });

    // ==================== INTEGRATION INVARIANTS ====================

    describe("Integration Invariants", function () {
        it("totalWeight should always equal sum of all strategy weights", async function () {
            const { strategy: s1 } = await createStrategy(paymentToken);
            const { strategy: s2 } = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));

            // Various vote combinations
            await voter.connect(user1).vote([s1], [100]);
            await voter.connect(user2).vote([s1, s2], [50, 50]);
            await voter.connect(user3).vote([s2], [100]);

            let weight1 = await voter.strategy_Weight(s1);
            let weight2 = await voter.strategy_Weight(s2);
            let total = await voter.totalWeight();
            expect(total).to.equal(weight1.add(weight2));

            // After epoch, some reset
            await advanceTime(WEEK);
            await voter.connect(user1).reset();

            weight1 = await voter.strategy_Weight(s1);
            weight2 = await voter.strategy_Weight(s2);
            total = await voter.totalWeight();
            expect(total).to.equal(weight1.add(weight2));

            // After more changes
            await voter.connect(user2).vote([s1], [100]);

            weight1 = await voter.strategy_Weight(s1);
            weight2 = await voter.strategy_Weight(s2);
            total = await voter.totalWeight();
            expect(total).to.equal(weight1.add(weight2));
        });

        it("bribe totalSupply should always equal strategy weight", async function () {
            const { strategy, bribe } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));

            const bribeContract = await ethers.getContractAt("Bribe", bribe);

            await voter.connect(user1).vote([strategy], [100]);
            expect(await bribeContract.totalSupply()).to.equal(await voter.strategy_Weight(strategy));

            await voter.connect(user2).vote([strategy], [100]);
            expect(await bribeContract.totalSupply()).to.equal(await voter.strategy_Weight(strategy));

            await advanceTime(WEEK);
            await voter.connect(user1).reset();
            expect(await bribeContract.totalSupply()).to.equal(await voter.strategy_Weight(strategy));
        });

        it("account usedWeight should equal sum of their strategy votes", async function () {
            const { strategy: s1 } = await createStrategy(paymentToken);
            const { strategy: s2 } = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));

            await voter.connect(user1).vote([s1, s2], [60, 40]);

            const vote1 = await voter.account_Strategy_Votes(user1.address, s1);
            const vote2 = await voter.account_Strategy_Votes(user1.address, s2);
            const usedWeight = await voter.account_UsedWeights(user1.address);

            expect(usedWeight).to.equal(vote1.add(vote2));
            expect(usedWeight).to.equal(ethers.utils.parseEther("100"));
        });

        it("revenue distribution should never exceed notified amount", async function () {
            const { strategy: s1 } = await createStrategy(paymentToken);
            const { strategy: s2 } = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));

            await voter.connect(user1).vote([s1], [100]);
            await voter.connect(user2).vote([s2], [100]);

            const notifiedAmount = ethers.utils.parseEther("1000");
            await sendRevenue(notifiedAmount);
            await voter.distro();

            const balance1 = await revenueToken.balanceOf(s1);
            const balance2 = await revenueToken.balanceOf(s2);
            const totalDistributed = balance1.add(balance2);

            // Total distributed should be <= notified (with possible dust)
            expect(totalDistributed).to.be.lte(notifiedAmount);
            // And very close to it
            expect(notifiedAmount.sub(totalDistributed)).to.be.lt(1000); // Less than 1000 wei dust
        });
    });

    // ==================== BRIBE SPECIFIC TESTS ====================

    describe("Bribe Specific Tests", function () {
        it("should revert notifyRewardAmount with amount < DURATION", async function () {
            const { bribe } = await createStrategy();
            const bribeContract = await ethers.getContractAt("Bribe", bribe);

            await paymentToken.mint(owner.address, ethers.utils.parseUnits("1000", 6));
            await paymentToken.approve(bribe, ethers.utils.parseUnits("1000", 6));

            // Amount less than DURATION (604800 seconds = 7 days)
            await expect(
                bribeContract.notifyRewardAmount(paymentToken.address, WEEK - 1)
            ).to.be.reverted;
        });

        it("should handle multiple reward tokens", async function () {
            const { strategy, bribe, bribeRouter } = await createStrategy();

            // Add second reward token
            await voter.addBribeReward(bribe, revenueToken.address);

            await voter.setBribeSplit(2000);
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            await buyFromStrategy(strategy, buyer1);

            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            // Also add WETH rewards directly
            const bribeContract = await ethers.getContractAt("Bribe", bribe);
            const wethReward = ethers.utils.parseEther("100");
            await revenueToken.approve(bribe, wethReward);
            await bribeContract.notifyRewardAmount(revenueToken.address, wethReward);

            await advanceTime(WEEK);

            const earnedUSDC = await bribeContract.earned(user1.address, paymentToken.address);
            const earnedWETH = await bribeContract.earned(user1.address, revenueToken.address);

            expect(earnedUSDC).to.be.gt(0);
            expect(earnedWETH).to.be.gt(0);
        });

        it("should revert addReward for already added token", async function () {
            const { bribe } = await createStrategy();

            // paymentToken already added during strategy creation
            await expect(voter.addBribeReward(bribe, paymentToken.address)).to.be.reverted;
        });

        it("should revert _deposit and _withdraw from non-voter", async function () {
            const { bribe } = await createStrategy();
            const bribeContract = await ethers.getContractAt("Bribe", bribe);

            await expect(
                bribeContract.connect(user1)._deposit(ethers.utils.parseEther("100"), user1.address)
            ).to.be.reverted;

            await expect(
                bribeContract.connect(user1)._withdraw(ethers.utils.parseEther("100"), user1.address)
            ).to.be.reverted;
        });
    });

    // ==================== VOTER ADMIN FUNCTIONS ====================

    describe("Voter Admin Functions", function () {
        it("should correctly change bribeSplit and affect new strategy buys", async function () {
            const { strategy, bribeRouter } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Set initial split
            await voter.setBribeSplit(1000); // 10%
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const price1 = await buyFromStrategy(strategy, buyer1);
            const bribeAmount1 = await paymentToken.balanceOf(bribeRouter);

            // Change split
            await voter.setBribeSplit(5000); // 50%

            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const bribeRouterBalanceBefore = await paymentToken.balanceOf(bribeRouter);
            const price2 = await buyFromStrategy(strategy, buyer1);
            const bribeRouterBalanceAfter = await paymentToken.balanceOf(bribeRouter);
            const bribeAmount2 = bribeRouterBalanceAfter.sub(bribeRouterBalanceBefore);

            // First buy: 10% of price went to bribe
            expect(bribeAmount1).to.be.closeTo(price1.mul(1000).div(10000), price1.div(100));

            // Second buy: 50% of price went to bribe
            expect(bribeAmount2).to.be.closeTo(price2.mul(5000).div(10000), price2.div(100));
        });

        it("should correctly switch revenue source", async function () {
            const { strategy } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Create new revenue router
            const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
            const newRevenueRouter = await RevenueRouter.deploy(revenueToken.address, voter.address);

            // Old router works
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("100"));

            // Switch source
            await voter.setRevenueSource(newRevenueRouter.address);

            // Old router should fail now
            await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("100"));
            await expect(revenueRouter.flush()).to.be.reverted;

            // New router should work
            await revenueToken.transfer(newRevenueRouter.address, ethers.utils.parseEther("100"));
            await newRevenueRouter.flush();
            await voter["distribute(address)"](strategy);
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("200"));
        });
    });
});
