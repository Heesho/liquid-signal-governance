const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Stress test for distributeAndBuy function
 * Goal: Try every possible way to make this function fail
 * to determine if frontend issues are smart contract related
 */
describe("DistributeAndBuy Stress Tests", function () {
    let owner, user1, user2, user3, buyer;
    let underlying, revenueToken, paymentToken, paymentToken18;
    let governanceToken, voter, bribeFactory, strategyFactory, revenueRouter;
    let multicall;

    const WEEK = 7 * 24 * 60 * 60;
    const HOUR = 60 * 60;
    const MINUTE = 60;
    const DAY = 24 * 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, user3, buyer] = await ethers.getSigners();

        // Deploy mock tokens
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("Underlying Token", "UNDERLYING", 18);
        revenueToken = await MockERC20.deploy("Revenue Token", "WETH", 18);
        paymentToken = await MockERC20.deploy("Payment Token", "USDC", 6); // 6 decimals
        paymentToken18 = await MockERC20.deploy("Payment Token 18", "DAI", 18); // 18 decimals

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
            owner.address, // treasury
            bribeFactory.address,
            strategyFactory.address
        );

        await governanceToken.setVoter(voter.address);

        // Deploy RevenueRouter
        const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
        revenueRouter = await RevenueRouter.deploy(revenueToken.address, voter.address);
        await voter.setRevenueSource(revenueRouter.address);

        // Deploy Multicall
        const Multicall = await ethers.getContractFactory("Multicall");
        multicall = await Multicall.deploy(voter.address);

        // Mint tokens
        await underlying.mint(user1.address, ethers.utils.parseEther("10000"));
        await underlying.mint(user2.address, ethers.utils.parseEther("10000"));
        await revenueToken.mint(owner.address, ethers.utils.parseEther("1000000"));

        // Give buyer plenty of payment tokens
        await paymentToken.mint(buyer.address, ethers.utils.parseUnits("10000000", 6)); // 10M USDC
        await paymentToken18.mint(buyer.address, ethers.utils.parseEther("10000000")); // 10M DAI
    });

    // ========== HELPER FUNCTIONS ==========

    async function createStrategy(payment = paymentToken, initPriceAmount = null) {
        const decimals = await payment.decimals();
        const initPrice = initPriceAmount || ethers.utils.parseUnits("100", decimals);
        const tx = await voter.addStrategy(
            payment.address,
            owner.address, // paymentReceiver
            initPrice,
            HOUR,
            ethers.utils.parseEther("2"), // priceMultiplier
            initPrice // minInitPrice
        );
        const receipt = await tx.wait();
        const event = receipt.events.find(e => e.event === "Voter__StrategyAdded");
        return {
            strategy: event.args.strategy,
            bribe: event.args.bribe,
            bribeRouter: event.args.bribeRouter,
            strategyContract: await ethers.getContractAt("Strategy", event.args.strategy)
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

    async function getBlockTimestamp() {
        const block = await ethers.provider.getBlock("latest");
        return block.timestamp;
    }

    async function setupStrategyWithRevenue(revenueAmount = ethers.utils.parseEther("100")) {
        const { strategy, strategyContract, bribe, bribeRouter } = await createStrategy();

        await stakeTokens(user1, ethers.utils.parseEther("100"));
        await voter.connect(user1).vote([strategy], [100]);
        await sendRevenue(revenueAmount);

        return { strategy, strategyContract, bribe, bribeRouter };
    }

    function log(msg) {
        console.log(`    [DEBUG] ${msg}`);
    }

    // ========== TEST SUITES ==========

    describe("1. EPOCH ID MISMATCH SCENARIOS", function () {
        it("should FAIL when epochId is stale (someone bought before us)", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // Get initial epochId
            const initialEpochId = await strategyContract.epochId();
            log(`Initial epochId: ${initialEpochId}`);

            // First buyer executes
            await voter["distribute(address)"](strategy);
            const price = await strategyContract.getPrice();
            await paymentToken.connect(buyer).approve(strategyContract.address, price);
            const deadline = (await getBlockTimestamp()) + 3600;
            await strategyContract.connect(buyer).buy(buyer.address, initialEpochId, deadline, price);

            log(`Epoch after first buy: ${await strategyContract.epochId()}`);

            // Second buyer tries with old epochId - SHOULD FAIL
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.mint(user2.address, maxPayment);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            await expect(
                multicall.connect(user2).distributeAndBuy(strategy, initialEpochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EpochIdMismatch
        });

        it("should FAIL with future epochId", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const currentEpochId = await strategyContract.epochId();
            const futureEpochId = currentEpochId.add(1);

            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, futureEpochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EpochIdMismatch
        });

        it("should FAIL with very large epochId", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, 999999, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EpochIdMismatch
        });
    });

    describe("2. DEADLINE SCENARIOS", function () {
        it("should FAIL when deadline is in the past", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);

            const pastDeadline = (await getBlockTimestamp()) - 1;

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, pastDeadline, maxPayment)
            ).to.be.reverted; // Strategy__DeadlinePassed
        });

        it("should FAIL when deadline is exactly block.timestamp (edge case)", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);

            // Get current timestamp - next block will be +1
            const currentTimestamp = await getBlockTimestamp();

            // The transaction will execute in the next block, so timestamp will be current+1
            // Setting deadline to current means it will be in the past when tx executes
            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, currentTimestamp, maxPayment)
            ).to.be.reverted; // Strategy__DeadlinePassed
        });

        it("should SUCCEED when deadline is exactly current+1", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);

            // Deadline just barely valid
            const deadline = (await getBlockTimestamp()) + 2;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            // Verify success
            const revenueBalance = await revenueToken.balanceOf(buyer.address);
            expect(revenueBalance).to.equal(ethers.utils.parseEther("100"));
        });

        it("should FAIL if deadline expires during long pending tx simulation", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);

            // Short deadline
            const deadline = (await getBlockTimestamp()) + 10;

            // Simulate time passing before tx executes
            await advanceTime(15);

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__DeadlinePassed
        });

        it("should FAIL with deadline = 0", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, 0, maxPayment)
            ).to.be.reverted; // Strategy__DeadlinePassed
        });
    });

    describe("3. MAX PAYMENT AMOUNT SCENARIOS", function () {
        it("should FAIL when maxPaymentAmount is significantly less than current price", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // Distribute first so we have a stable price at execution time
            await voter["distribute(address)"](strategy);

            const epochId = await strategyContract.epochId();
            const currentPrice = await strategyContract.getPrice();
            log(`Current price: ${ethers.utils.formatUnits(currentPrice, 6)} USDC`);

            // Set max payment SIGNIFICANTLY below current price (price might decay slightly)
            const maxPayment = currentPrice.div(2); // 50% of price - definitely too low
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__MaxPaymentAmountExceeded
        });

        it("should FAIL when price increases due to frontrunning and exceeds maxPayment", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // User checks price and sets maxPayment exactly
            const epochId = await strategyContract.epochId();
            const currentPrice = await strategyContract.getPrice();
            const maxPayment = currentPrice; // Exact amount

            log(`Price when user checked: ${ethers.utils.formatUnits(currentPrice, 6)}`);

            // Frontrunner buys first (resetting the auction)
            await voter["distribute(address)"](strategy);
            await paymentToken.connect(buyer).approve(strategyContract.address, currentPrice);
            const deadline = (await getBlockTimestamp()) + 3600;
            await strategyContract.connect(buyer).buy(buyer.address, epochId, deadline, currentPrice);

            // New epoch starts with higher initPrice (2x the payment due to priceMultiplier)
            const newEpochId = await strategyContract.epochId();
            const newPrice = await strategyContract.getPrice();
            log(`New price after frontrun: ${ethers.utils.formatUnits(newPrice, 6)}`);

            // Even if user had correct epochId, price is now higher
            expect(newPrice).to.be.gt(maxPayment);

            // Send new revenue so there's something to buy
            await sendRevenue(ethers.utils.parseEther("50"));
            await voter["distribute(address)"](strategy);

            await paymentToken.mint(user2.address, maxPayment);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            await expect(
                multicall.connect(user2).distributeAndBuy(strategy, newEpochId, deadline + 3600, maxPayment)
            ).to.be.reverted; // Strategy__MaxPaymentAmountExceeded
        });

        it("should SUCCEED with maxPaymentAmount = 0 when price is 0 (epoch expired)", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();

            // Wait for epoch to expire (price becomes 0)
            await advanceTime(HOUR + 60);

            const price = await strategyContract.getPrice();
            expect(price).to.equal(0);
            log(`Price after epoch expires: ${price}`);

            // maxPayment = 0 should work
            await paymentToken.connect(buyer).approve(multicall.address, 0);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, 0);

            // Buyer should receive revenue tokens for free
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should refund excess when maxPaymentAmount > actual price", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const currentPrice = await strategyContract.getPrice();

            // Provide way more than needed
            const maxPayment = currentPrice.mul(10);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);

            const balanceBefore = await paymentToken.balanceOf(buyer.address);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            const balanceAfter = await paymentToken.balanceOf(buyer.address);
            const spent = balanceBefore.sub(balanceAfter);

            log(`MaxPayment: ${ethers.utils.formatUnits(maxPayment, 6)}`);
            log(`Actual spent: ${ethers.utils.formatUnits(spent, 6)}`);
            log(`Price at execution: ${ethers.utils.formatUnits(currentPrice, 6)}`);

            // Should have spent approximately the price, not maxPayment
            expect(spent).to.be.lte(currentPrice.add(1)); // Allow 1 wei tolerance
            expect(spent).to.be.lt(maxPayment);
        });
    });

    describe("4. EMPTY ASSETS / ZERO REVENUE SCENARIOS", function () {
        it("should FAIL when strategy has no revenue tokens", async function () {
            const { strategy, strategyContract } = await createStrategy();

            // Setup votes but NO revenue
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EmptyAssets
        });

        it("should FAIL when revenue is in voter but not distributed to strategy", async function () {
            const { strategy, strategyContract, bribe, bribeRouter } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Send revenue to revenueRouter but DON'T flush
            await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("100"));

            // distributeAndBuy calls flushIfAvailable, so revenue WILL be flushed
            // But if we check revenueBalance before that...
            const revenueBalanceBefore = await strategyContract.getRevenueBalance();
            expect(revenueBalanceBefore).to.equal(0);

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            // This should SUCCEED because distributeAndBuy flushes and distributes
            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should FAIL when strategy has no votes (0 weight)", async function () {
            const { strategy, strategyContract } = await createStrategy();

            // NO staking, NO votes
            // Send revenue
            await sendRevenue(ethers.utils.parseEther("100"));

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            // Strategy has 0 weight, so distribute won't give it anything
            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EmptyAssets
        });

        it("should FAIL when revenue was already bought in same epoch", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const deadline = (await getBlockTimestamp()) + 3600;

            // First buy succeeds
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            // Second buy with same epochId should fail (epochId changed)
            await paymentToken.mint(user2.address, maxPayment);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            await expect(
                multicall.connect(user2).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EpochIdMismatch
        });

        it("should FAIL when trying to buy again with new epochId but no new revenue", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // First buy
            let epochId = await strategyContract.epochId();
            let deadline = (await getBlockTimestamp()) + 3600;
            let maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            // Try second buy with correct new epochId but no new revenue
            epochId = await strategyContract.epochId();
            deadline = (await getBlockTimestamp()) + 3600;
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EmptyAssets
        });
    });

    describe("5. APPROVAL AND BALANCE SCENARIOS", function () {
        it("should FAIL when user has no approval for multicall", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            // NO approval!
            const deadline = (await getBlockTimestamp()) + 3600;

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // ERC20 insufficient allowance
        });

        it("should FAIL when approval is less than maxPaymentAmount", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            // Approve less than maxPayment
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment.sub(1));
            const deadline = (await getBlockTimestamp()) + 3600;

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted;
        });

        it("should FAIL when user has insufficient balance", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);

            // Create a poor user with no tokens
            await paymentToken.connect(user3).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            // user3 has 0 balance
            expect(await paymentToken.balanceOf(user3.address)).to.equal(0);

            await expect(
                multicall.connect(user3).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted;
        });

        it("should FAIL when balance is less than price even with sufficient approval", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();

            // Give user3 slightly less than price
            await paymentToken.mint(user3.address, price.sub(1));
            await paymentToken.connect(user3).approve(multicall.address, price);
            const deadline = (await getBlockTimestamp()) + 3600;

            await expect(
                multicall.connect(user3).distributeAndBuy(strategy, epochId, deadline, price)
            ).to.be.reverted;
        });

        it("should SUCCEED when approval equals exactly the price", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();

            // Wait a bit for price to decay
            await advanceTime(30 * MINUTE);

            const price = await strategyContract.getPrice();
            log(`Price: ${ethers.utils.formatUnits(price, 6)}`);

            // Approve and provide exactly the price
            await paymentToken.connect(buyer).approve(multicall.address, price);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, price);

            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });
    });

    describe("6. RACE CONDITIONS / MULTIPLE BUYERS", function () {
        it("only first buyer should succeed in same block (simulated)", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            const deadline = (await getBlockTimestamp()) + 3600;

            // Prepare two buyers
            await paymentToken.mint(user2.address, maxPayment);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            // First buyer succeeds
            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            // Second buyer fails (epoch changed)
            await expect(
                multicall.connect(user2).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EpochIdMismatch
        });

        it("second buyer can succeed with new revenue and new epochId", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // First buyer
            let epochId = await strategyContract.epochId();
            let maxPayment = ethers.utils.parseUnits("1000", 6);
            let deadline = (await getBlockTimestamp()) + 3600;
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            log(`Buyer1 got: ${ethers.utils.formatEther(await revenueToken.balanceOf(buyer.address))} ETH`);

            // Add new revenue
            await sendRevenue(ethers.utils.parseEther("50"));

            // Second buyer with updated params
            epochId = await strategyContract.epochId();
            deadline = (await getBlockTimestamp()) + 3600;
            await paymentToken.mint(user2.address, maxPayment);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);
            await multicall.connect(user2).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            log(`Buyer2 got: ${ethers.utils.formatEther(await revenueToken.balanceOf(user2.address))} ETH`);
            expect(await revenueToken.balanceOf(user2.address)).to.equal(ethers.utils.parseEther("50"));
        });
    });

    describe("7. TIMING EDGE CASES", function () {
        it("should handle buying at exact epoch start (max price)", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const initPrice = await strategyContract.initPrice();
            const currentPrice = await strategyContract.getPrice();

            log(`Init price: ${ethers.utils.formatUnits(initPrice, 6)}`);
            log(`Current price: ${ethers.utils.formatUnits(currentPrice, 6)}`);

            // Price should be close to initPrice at start
            expect(currentPrice).to.be.lte(initPrice);

            const maxPayment = initPrice.mul(2); // Generous max
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should handle buying at exact epoch end (price = 0)", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();

            // Advance past epoch
            await advanceTime(HOUR + 1);

            const price = await strategyContract.getPrice();
            expect(price).to.equal(0);

            await paymentToken.connect(buyer).approve(multicall.address, 1);
            const deadline = (await getBlockTimestamp()) + 3600;

            // Should work with 0 payment
            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, 0);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should handle buying exactly at epoch boundary", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const startTime = await strategyContract.startTime();
            const epochPeriod = await strategyContract.epochPeriod();

            // Advance to exactly epoch period
            const currentTime = await getBlockTimestamp();
            const timeToWait = startTime.add(epochPeriod).sub(currentTime).toNumber() - 1;
            if (timeToWait > 0) {
                await advanceTime(timeToWait);
            }

            const price = await strategyContract.getPrice();
            log(`Price at boundary: ${ethers.utils.formatUnits(price, 6)}`);

            await paymentToken.connect(buyer).approve(multicall.address, ethers.utils.parseUnits("1000", 6));
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, ethers.utils.parseUnits("1000", 6));
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should handle multiple buys in rapid succession", async function () {
            // Create strategy with votes
            const { strategy, strategyContract } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            for (let i = 0; i < 5; i++) {
                // Send fresh revenue
                await sendRevenue(ethers.utils.parseEther("10"));

                const epochId = await strategyContract.epochId();
                const price = await strategyContract.getPrice();
                // Use price * 10 as maxPayment to account for price increases after each buy
                const maxPayment = price.mul(10).add(ethers.utils.parseUnits("1000", 6));
                await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
                const deadline = (await getBlockTimestamp()) + 3600;

                await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
                log(`Buy ${i+1} complete, epochId now: ${await strategyContract.epochId()}, new initPrice: ${ethers.utils.formatUnits(await strategyContract.initPrice(), 6)}`);
            }

            // Should have accumulated 50 ETH
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("50"));
        });
    });

    describe("8. DEAD STRATEGY SCENARIOS", function () {
        it("should FAIL when strategy is killed before buy", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // Kill the strategy
            await voter.killStrategy(strategy);

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            // Strategy is dead, claimable should be 0, no revenue to distribute
            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EmptyAssets
        });

        it("should still allow buying existing revenue from killed strategy", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // Distribute revenue BEFORE killing
            await voter["distribute(address)"](strategy);

            const revenueBalance = await strategyContract.getRevenueBalance();
            log(`Revenue in strategy: ${ethers.utils.formatEther(revenueBalance)}`);
            expect(revenueBalance).to.equal(ethers.utils.parseEther("100"));

            // Kill the strategy
            await voter.killStrategy(strategy);

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(strategyContract.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            // Direct buy should still work (strategy has tokens)
            await strategyContract.connect(buyer).buy(buyer.address, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });
    });

    describe("9. DIFFERENT PAYMENT TOKEN DECIMALS", function () {
        it("should work correctly with 6 decimal payment token (USDC)", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();
            log(`Price (6 decimals): ${ethers.utils.formatUnits(price, 6)} USDC`);

            const maxPayment = ethers.utils.parseUnits("200", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should work correctly with 18 decimal payment token (DAI)", async function () {
            // Create strategy with 18 decimal payment token
            const { strategy, strategyContract } = await createStrategy(paymentToken18);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));

            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();
            log(`Price (18 decimals): ${ethers.utils.formatEther(price)} DAI`);

            const maxPayment = ethers.utils.parseEther("200");
            await paymentToken18.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });
    });

    describe("10. VERY SMALL / VERY LARGE AMOUNTS", function () {
        it("should handle small revenue amount", async function () {
            const { strategy, strategyContract } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Send small but non-dust amount (1 gwei worth)
            const smallAmount = ethers.utils.parseUnits("1", 9); // 1 gwei
            await sendRevenue(smallAmount);

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(smallAmount);
        });

        it("should FAIL with 1 wei revenue (dust gets lost in distribution)", async function () {
            const { strategy, strategyContract } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // 1 wei might be lost in rounding during index calculations
            await sendRevenue(1);

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            // This may fail with EmptyAssets because dust gets lost
            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EmptyAssets (dust lost in distribution)
        });

        it("should handle very large revenue amount", async function () {
            const { strategy, strategyContract } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Send large amount
            const largeAmount = ethers.utils.parseEther("100000");
            await revenueToken.mint(owner.address, largeAmount);
            await sendRevenue(largeAmount);

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("10000000", 6); // 10M USDC
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(largeAmount);
        });
    });

    describe("11. BRIBE SPLIT SCENARIOS", function () {
        it("should work correctly with 0% bribe split", async function () {
            await voter.setBribeSplit(0); // 0%

            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();
            const maxPayment = price.mul(2);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should work correctly with max allowed bribe split (50%)", async function () {
            // Note: 100% bribe split is not allowed - there's a max limit
            await voter.setBribeSplit(5000); // 50% (max allowed)

            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();
            const maxPayment = price.mul(2);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should FAIL when trying to set 100% bribe split", async function () {
            // Contract has a max bribe split limit
            await expect(voter.setBribeSplit(10000)).to.be.reverted;
        });

        it("should work correctly with 50% bribe split", async function () {
            await voter.setBribeSplit(5000); // 50%

            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();
            const maxPayment = price.mul(2);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });
    });

    describe("12. DISTRIBUTEALL AND BUY", function () {
        it("should work with distributeAllAndBuy", async function () {
            // Create multiple strategies
            const { strategy: s1 } = await createStrategy();
            const { strategy: s2 } = await createStrategy(paymentToken18);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([s1, s2], [50, 50]);
            await sendRevenue(ethers.utils.parseEther("100"));

            const strategyContract = await ethers.getContractAt("Strategy", s1);
            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAllAndBuy(s1, epochId, deadline, maxPayment);

            // Buyer should get 50% (s1's share)
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("50"));

            // s2 should also have its share distributed
            const s2Contract = await ethers.getContractAt("Strategy", s2);
            expect(await s2Contract.getRevenueBalance()).to.equal(ethers.utils.parseEther("50"));
        });
    });

    describe("13. COMPREHENSIVE INTEGRATION TEST", function () {
        it("should handle a realistic buy scenario with all steps", async function () {
            // 1. Create strategy
            const { strategy, strategyContract, bribe, bribeRouter } = await createStrategy();
            log(`Strategy created: ${strategy}`);

            // 2. User stakes and votes
            await stakeTokens(user1, ethers.utils.parseEther("1000"));
            await voter.connect(user1).vote([strategy], [100]);
            log(`User1 voted with 1000 governance tokens`);

            // 3. Revenue comes in
            await sendRevenue(ethers.utils.parseEther("10"));
            log(`10 ETH revenue sent`);

            // 4. Some time passes (price decays)
            await advanceTime(30 * MINUTE);

            // 5. Get all the data a frontend would need
            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();
            const deadline = (await getBlockTimestamp()) + 300; // 5 minute deadline

            log(`EpochId: ${epochId}`);
            log(`Price: ${ethers.utils.formatUnits(price, 6)} USDC`);
            log(`Deadline: ${deadline}`);

            // 6. Add some buffer to price for safety
            const maxPayment = price.add(price.div(10)); // +10%
            log(`Max payment (with buffer): ${ethers.utils.formatUnits(maxPayment, 6)} USDC`);

            // 7. Approve
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);

            // 8. Execute buy
            const buyerBalanceBefore = await paymentToken.balanceOf(buyer.address);
            const tx = await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            const receipt = await tx.wait();
            const buyerBalanceAfter = await paymentToken.balanceOf(buyer.address);

            log(`Gas used: ${receipt.gasUsed.toString()}`);
            log(`Payment tokens spent: ${ethers.utils.formatUnits(buyerBalanceBefore.sub(buyerBalanceAfter), 6)}`);
            log(`Revenue tokens received: ${ethers.utils.formatEther(await revenueToken.balanceOf(buyer.address))}`);

            // 9. Verify success
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("10"));
            expect(await strategyContract.epochId()).to.equal(epochId.add(1));
        });
    });

    describe("14. POTENTIAL FRONTEND ISSUES", function () {
        it("SCENARIO: Frontend uses old epochId from cache", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // Frontend caches epochId
            const cachedEpochId = await strategyContract.epochId();

            // Someone else buys first
            await voter["distribute(address)"](strategy);
            const price = await strategyContract.getPrice();
            await paymentToken.connect(user2).approve(strategyContract.address, price);
            await paymentToken.mint(user2.address, price);
            const deadline1 = (await getBlockTimestamp()) + 3600;
            await strategyContract.connect(user2).buy(user2.address, cachedEpochId, deadline1, price);

            // Frontend tries with cached epochId
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline2 = (await getBlockTimestamp()) + 3600;

            // Should fail with epoch mismatch
            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, cachedEpochId, deadline2, maxPayment)
            ).to.be.reverted; // Strategy__EpochIdMismatch
        });

        it("SCENARIO: Frontend calculates price but it changes before tx confirms", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // Frontend gets price
            const priceAtCheck = await strategyContract.getPrice();
            const epochId = await strategyContract.epochId();

            // Time passes, price decays
            await advanceTime(10 * MINUTE);

            const priceAtExecution = await strategyContract.getPrice();
            log(`Price at check: ${ethers.utils.formatUnits(priceAtCheck, 6)}`);
            log(`Price at execution: ${ethers.utils.formatUnits(priceAtExecution, 6)}`);

            // Using original price as max should still work (price went down)
            await paymentToken.connect(buyer).approve(multicall.address, priceAtCheck);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, priceAtCheck);

            // Should succeed and refund the difference
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("SCENARIO: Frontend uses deadline that's too short for network congestion", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);

            // Short deadline (simulating "tx pending for too long")
            const deadline = (await getBlockTimestamp()) + 30; // 30 seconds

            // Simulate network delay
            await advanceTime(35);

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__DeadlinePassed
        });

        it("SCENARIO: Frontend doesn't check if strategy has revenue", async function () {
            const { strategy, strategyContract } = await createStrategy();

            // Setup votes but NO revenue
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment)
            ).to.be.reverted; // Strategy__EmptyAssets
        });

        it("SCENARIO: Frontend approves multicall but user has insufficient balance", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();

            // User3 has no tokens but approves anyway
            await paymentToken.connect(user3).approve(multicall.address, price);
            const deadline = (await getBlockTimestamp()) + 3600;

            await expect(
                multicall.connect(user3).distributeAndBuy(strategy, epochId, deadline, price)
            ).to.be.reverted;
        });

        it("SCENARIO: Frontend calculates price with wrong decimals", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();

            // Frontend mistakenly uses 18 decimals instead of 6
            const wrongDecimalPrice = ethers.utils.parseEther("100"); // Way too high
            await paymentToken.connect(buyer).approve(multicall.address, wrongDecimalPrice);
            const deadline = (await getBlockTimestamp()) + 3600;

            // This would fail with insufficient balance or succeed with huge overpay
            // The actual price is ~100 USDC (6 decimals) = 100000000
            // wrongDecimalPrice = 100e18 = 100000000000000000000

            // User doesn't have this much
            const balance = await paymentToken.balanceOf(buyer.address);
            log(`User balance: ${ethers.utils.formatUnits(balance, 6)}`);
            log(`Wrong decimal price: ${ethers.utils.formatUnits(wrongDecimalPrice, 6)}`);

            // This should revert due to insufficient balance for transfer
            await expect(
                multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, wrongDecimalPrice)
            ).to.be.reverted;
        });
    });

    describe("15. BRIBE REWARD MINIMUM (LIKELY THE BUG)", function () {
        it("should SUCCEED even when bribe amount is less than DURATION (604800) - skips bribe distribution", async function () {
            // FIX: Multicall now skips bribe distribution when balance < 604800
            // This allows the buy to succeed, and bribe accumulates until large enough

            // Set bribe split to 20%
            await voter.setBribeSplit(2000);

            const { strategy, strategyContract, bribeRouter } = await createStrategy();

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));

            // Wait for price to decay significantly so payment is small
            await advanceTime(59 * MINUTE); // Near end of epoch

            const price = await strategyContract.getPrice();
            log(`Price near epoch end: ${ethers.utils.formatUnits(price, 6)} USDC`);

            // Bribe amount = price * 20%
            const bribeAmount = price.mul(2000).div(10000);
            log(`Bribe amount would be: ${bribeAmount.toString()} (${ethers.utils.formatUnits(bribeAmount, 6)} USDC)`);
            log(`DURATION requirement: 604800`);
            log(`Below minimum: ${bribeAmount.lt(604800)}`);

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            // Should NOW SUCCEED - bribe distribution is skipped when too small
            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            // Buyer got the revenue
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));

            // Bribe amount is sitting in BribeRouter (not distributed yet)
            const bribeRouterBalance = await paymentToken.balanceOf(bribeRouter);
            log(`BribeRouter balance after buy: ${ethers.utils.formatUnits(bribeRouterBalance, 6)} USDC`);
            expect(bribeRouterBalance).to.be.gt(0);
        });

        it("should calculate minimum payment needed to not fail bribe", async function () {
            // DURATION = 604800
            // bribeAmount = payment * bribeSplit / 10000
            // For bribeAmount >= DURATION: payment >= DURATION * 10000 / bribeSplit

            const bribeSplit = 2000; // 20%
            await voter.setBribeSplit(bribeSplit);

            // Minimum payment for 6 decimal token (USDC)
            const minPaymentFor6Decimals = 604800 * 10000 / bribeSplit;
            log(`Minimum payment (6 decimals): ${minPaymentFor6Decimals} = ${minPaymentFor6Decimals / 1e6} USDC`);

            // Minimum payment for 8 decimal token (BTC)
            const minPaymentFor8Decimals = 604800 * 10000 / bribeSplit;
            log(`Minimum payment (8 decimals): ${minPaymentFor8Decimals} = ${minPaymentFor8Decimals / 1e8} BTC`);

            // For BTC at $100k, minimum = 0.03024 BTC = $3024 payment needed!
            // The user tried to pay $1000 worth, which is below minimum

            expect(minPaymentFor6Decimals).to.equal(3024000); // 3.024 USDC minimum
            expect(minPaymentFor8Decimals).to.equal(3024000); // 0.03024 BTC minimum
        });

        it("should SUCCEED when payment is above minimum threshold", async function () {
            await voter.setBribeSplit(2000); // 20%

            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            // DON'T wait - buy at high price to ensure bribe > DURATION
            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();

            const bribeAmount = price.mul(2000).div(10000);
            log(`Price: ${ethers.utils.formatUnits(price, 6)} USDC`);
            log(`Bribe amount: ${bribeAmount.toString()} (needs >= 604800)`);

            // Should succeed because price is ~100 USDC, bribe = ~20 USDC = 20,000,000 > 604800
            expect(bribeAmount.gt(604800)).to.be.true;

            const maxPayment = price.mul(2);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            expect(await revenueToken.balanceOf(buyer.address)).to.equal(ethers.utils.parseEther("100"));
        });
    });

    describe("16. GAS AND LIMITS", function () {
        it("should complete within reasonable gas limit", async function () {
            const { strategy, strategyContract } = await setupStrategyWithRevenue();

            const epochId = await strategyContract.epochId();
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(buyer).approve(multicall.address, maxPayment);
            const deadline = (await getBlockTimestamp()) + 3600;

            const tx = await multicall.connect(buyer).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            const receipt = await tx.wait();

            log(`Gas used for distributeAndBuy: ${receipt.gasUsed.toString()}`);

            // Should be well under block gas limit
            expect(receipt.gasUsed).to.be.lt(500000);
        });
    });
});
