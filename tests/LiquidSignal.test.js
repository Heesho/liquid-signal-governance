const { expect } = require("chai");
const { ethers, waffle } = require("hardhat");

describe("Liquid Signal Governance", function () {
    let owner, user1, user2, user3, treasury;
    let underlying, revenueToken, paymentToken;
    let governanceToken, voter, bribeFactory, strategyFactoryContract;
    let strategy, bribe, bribeRouter;

    const WEEK = 7 * 24 * 60 * 60;
    const HOUR = 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, user3, treasury] = await ethers.getSigners();

        // Deploy mock tokens
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("Underlying Token", "UNDERLYING", 18);
        revenueToken = await MockERC20.deploy("Revenue Token", "WETH", 18);
        paymentToken = await MockERC20.deploy("Payment Token", "USDC", 6);

        // Deploy factories
        const BribeFactory = await ethers.getContractFactory("BribeFactory");
        bribeFactory = await BribeFactory.deploy();

        const StrategyFactory = await ethers.getContractFactory("StrategyFactory");
        const strategyFactory = await StrategyFactory.deploy();

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
        const revenueRouter = await RevenueRouter.deploy(revenueToken.address, voter.address);
        await voter.setRevenueSource(revenueRouter.address);

        // Set bribe split (20%)
        await voter.setBribeSplit(2000);

        // Mint tokens to users
        await underlying.mint(user1.address, ethers.utils.parseEther("1000"));
        await underlying.mint(user2.address, ethers.utils.parseEther("1000"));
        await underlying.mint(user3.address, ethers.utils.parseEther("1000"));
        await revenueToken.mint(owner.address, ethers.utils.parseEther("10000"));
        await paymentToken.mint(user1.address, ethers.utils.parseUnits("100000", 6));
        await paymentToken.mint(user2.address, ethers.utils.parseUnits("100000", 6));
    });

    describe("GovernanceToken", function () {
        it("should stake underlying tokens 1:1", async function () {
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);

            expect(await governanceToken.balanceOf(user1.address)).to.equal(amount);
            expect(await underlying.balanceOf(governanceToken.address)).to.equal(amount);
        });

        it("should unstake when no active votes", async function () {
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);

            await governanceToken.connect(user1).unstake(amount);

            expect(await governanceToken.balanceOf(user1.address)).to.equal(0);
            expect(await underlying.balanceOf(user1.address)).to.equal(ethers.utils.parseEther("1000"));
        });

        it("should prevent transfers between accounts", async function () {
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);

            await expect(
                governanceToken.connect(user1).transfer(user2.address, amount)
            ).to.be.reverted;
        });

        it("should prevent unstaking with active votes", async function () {
            // Setup strategy first
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            strategy = await voter.strategies(0);

            // Stake and vote
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);
            await voter.connect(user1).vote([strategy], [100]);

            await expect(
                governanceToken.connect(user1).unstake(amount)
            ).to.be.reverted;
        });

        it("should allow unstaking after resetting votes", async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            strategy = await voter.strategies(0);

            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);
            await voter.connect(user1).vote([strategy], [100]);

            // Advance to next epoch and reset
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");
            await voter.connect(user1).reset();

            await governanceToken.connect(user1).unstake(amount);
            expect(await governanceToken.balanceOf(user1.address)).to.equal(0);
        });
    });

    describe("Voter - Strategy Management", function () {
        it("should add a new strategy", async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);

            expect(await voter.length()).to.equal(1);
            strategy = await voter.strategies(0);
            expect(await voter.strategy_IsValid(strategy)).to.be.true;
            expect(await voter.strategy_IsAlive(strategy)).to.be.true;
        });

        it("should kill a strategy", async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            strategy = await voter.strategies(0);

            await voter.killStrategy(strategy);

            expect(await voter.strategy_IsAlive(strategy)).to.be.false;
        });

        it("should prevent non-owner from adding strategy", async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await expect(
                voter.connect(user1).addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });

    describe("Voter - Voting", function () {
        beforeEach(async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            strategy = await voter.strategies(0);
            bribe = await voter.strategy_Bribe(strategy);
        });

        it("should allow voting with staked tokens", async function () {
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);

            await voter.connect(user1).vote([strategy], [100]);

            expect(await voter.account_UsedWeights(user1.address)).to.equal(amount);
            expect(await voter.strategy_Weight(strategy)).to.equal(amount);
            expect(await voter.totalWeight()).to.equal(amount);
        });

        it("should normalize vote weights", async function () {
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);

            // Add second strategy
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            const strategy2 = await voter.strategies(1);

            // Vote 75% to strategy1, 25% to strategy2
            await voter.connect(user1).vote([strategy, strategy2], [3, 1]);

            const weight1 = await voter.strategy_Weight(strategy);
            const weight2 = await voter.strategy_Weight(strategy2);

            // Allow 1 wei tolerance for rounding
            expect(weight1).to.be.closeTo(ethers.utils.parseEther("75"), 1);
            expect(weight2).to.be.closeTo(ethers.utils.parseEther("25"), 1);
        });

        it("should prevent voting twice in same epoch", async function () {
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);

            await voter.connect(user1).vote([strategy], [100]);

            await expect(
                voter.connect(user1).vote([strategy], [100])
            ).to.be.reverted;
        });

        it("should allow voting in new epoch", async function () {
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);

            await voter.connect(user1).vote([strategy], [100]);

            // Advance to next epoch
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            await voter.connect(user1).vote([strategy], [100]);
            expect(await voter.account_UsedWeights(user1.address)).to.equal(amount);
        });

        it("should deposit virtual balance to bribe on vote", async function () {
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);

            await voter.connect(user1).vote([strategy], [100]);

            const Bribe = await ethers.getContractFactory("Bribe");
            const bribeContract = Bribe.attach(bribe);
            expect(await bribeContract.balanceOf(user1.address)).to.equal(amount);
        });
    });

    describe("Revenue Distribution", function () {
        let revenueRouter;

        beforeEach(async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            strategy = await voter.strategies(0);

            // Get revenue router
            revenueRouter = await ethers.getContractAt("RevenueRouter", await voter.revenueSource());
        });

        it("should distribute revenue proportionally to strategies", async function () {
            // User1 stakes and votes
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);
            await voter.connect(user1).vote([strategy], [100]);

            // Send revenue
            const revenueAmount = ethers.utils.parseEther("10");
            await revenueToken.transfer(revenueRouter.address, revenueAmount);
            await revenueRouter.flush();

            // Check claimable
            await voter.updateStrategy(strategy);
            expect(await voter.strategy_Claimable(strategy)).to.equal(revenueAmount);
        });

        it("should distribute to strategy when distribute is called", async function () {
            const amount = ethers.utils.parseEther("100");
            await underlying.connect(user1).approve(governanceToken.address, amount);
            await governanceToken.connect(user1).stake(amount);
            await voter.connect(user1).vote([strategy], [100]);

            const revenueAmount = ethers.utils.parseEther("10");
            await revenueToken.transfer(revenueRouter.address, revenueAmount);
            await revenueRouter.flush();

            await voter["distribute(address)"](strategy);

            expect(await revenueToken.balanceOf(strategy)).to.equal(revenueAmount);
            expect(await voter.strategy_Claimable(strategy)).to.equal(0);
        });

        it("should send revenue to treasury if no votes", async function () {
            const revenueAmount = ethers.utils.parseEther("10");
            await revenueToken.transfer(revenueRouter.address, revenueAmount);

            const treasuryBefore = await revenueToken.balanceOf(treasury.address);
            await revenueRouter.flush();
            const treasuryAfter = await revenueToken.balanceOf(treasury.address);

            expect(treasuryAfter.sub(treasuryBefore)).to.equal(revenueAmount);
        });

        it("should distribute proportionally with multiple strategies", async function () {
            // Add second strategy
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            const strategy2 = await voter.strategies(1);

            // User1 votes 100% for strategy1
            await underlying.connect(user1).approve(governanceToken.address, ethers.utils.parseEther("100"));
            await governanceToken.connect(user1).stake(ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // User2 votes 100% for strategy2
            await underlying.connect(user2).approve(governanceToken.address, ethers.utils.parseEther("100"));
            await governanceToken.connect(user2).stake(ethers.utils.parseEther("100"));
            await voter.connect(user2).vote([strategy2], [100]);

            // Send revenue
            const revenueAmount = ethers.utils.parseEther("10");
            await revenueToken.transfer(revenueRouter.address, revenueAmount);
            await revenueRouter.flush();

            await voter.updateStrategy(strategy);
            await voter.updateStrategy(strategy2);

            // Each should get 50%
            expect(await voter.strategy_Claimable(strategy)).to.equal(ethers.utils.parseEther("5"));
            expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("5"));
        });
    });

    describe("Strategy (Dutch Auction)", function () {
        let strategyContract;

        beforeEach(async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            strategy = await voter.strategies(0);
            strategyContract = await ethers.getContractAt("Strategy", strategy);
            bribeRouter = await voter.strategy_BribeRouter(strategy);

            // Stake and vote so revenue can be distributed
            await underlying.connect(user1).approve(governanceToken.address, ethers.utils.parseEther("100"));
            await governanceToken.connect(user1).stake(ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Send revenue to strategy
            const revenueRouter = await ethers.getContractAt("RevenueRouter", await voter.revenueSource());
            await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("10"));
            await revenueRouter.flush();
            await voter["distribute(address)"](strategy);
        });

        it("should have correct initial price", async function () {
            const price = await strategyContract.getPrice();
            expect(price).to.be.closeTo(ethers.utils.parseUnits("100", 6), ethers.utils.parseUnits("1", 6));
        });

        it("should decrease price over time", async function () {
            const priceBefore = await strategyContract.getPrice();

            await ethers.provider.send("evm_increaseTime", [HOUR / 2]);
            await ethers.provider.send("evm_mine");

            const priceAfter = await strategyContract.getPrice();
            expect(priceAfter).to.be.lt(priceBefore);
            expect(priceAfter).to.be.closeTo(ethers.utils.parseUnits("50", 6), ethers.utils.parseUnits("1", 6));
        });

        it("should allow buying at current price", async function () {
            const slot0 = await strategyContract.getSlot0();
            const revenueBalance = await strategyContract.getRevenueBalance();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(user2).approve(strategyContract.address, price);

            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            await strategyContract.connect(user2).buy(user2.address, slot0.epochId, deadline, price);

            expect(await revenueToken.balanceOf(user2.address)).to.equal(revenueBalance);
        });

        it("should split payment between receiver and bribe router", async function () {
            const slot0 = await strategyContract.getSlot0();

            await paymentToken.connect(user2).approve(strategyContract.address, ethers.utils.parseUnits("200", 6));

            const treasuryBefore = await paymentToken.balanceOf(treasury.address);
            const bribeRouterBefore = await paymentToken.balanceOf(bribeRouter);

            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            const maxPayment = ethers.utils.parseUnits("200", 6);
            await strategyContract.connect(user2).buy(user2.address, slot0.epochId, deadline, maxPayment);

            const treasuryAfter = await paymentToken.balanceOf(treasury.address);
            const bribeRouterAfter = await paymentToken.balanceOf(bribeRouter);

            const bribeAmount = bribeRouterAfter.sub(bribeRouterBefore);
            const receiverAmount = treasuryAfter.sub(treasuryBefore);
            const totalPayment = bribeAmount.add(receiverAmount);

            // 20% bribe split - verify ratio is correct
            const bribePercent = bribeAmount.mul(10000).div(totalPayment).toNumber();
            const receiverPercent = receiverAmount.mul(10000).div(totalPayment).toNumber();

            expect(bribePercent).to.be.closeTo(2000, 1);
            expect(receiverPercent).to.be.closeTo(8000, 1);
        });

        it("should adjust next epoch price based on payment", async function () {
            const slot0Before = await strategyContract.getSlot0();

            await paymentToken.connect(user2).approve(strategyContract.address, ethers.utils.parseUnits("200", 6));

            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            const maxPayment = ethers.utils.parseUnits("200", 6);

            // Get actual price at time of buy
            const priceBefore = await strategyContract.getPrice();
            await strategyContract.connect(user2).buy(user2.address, slot0Before.epochId, deadline, maxPayment);

            const slot0After = await strategyContract.getSlot0();

            // priceMultiplier is 2x - next price should be ~2x what was paid
            // Allow some tolerance for block timing
            expect(slot0After.initPrice).to.be.closeTo(priceBefore.mul(2), priceBefore.div(10));
            expect(slot0After.epochId).to.equal(slot0Before.epochId + 1);
        });

        it("should revert if epoch id mismatch (frontrun protection)", async function () {
            const slot0 = await strategyContract.getSlot0();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(user2).approve(strategyContract.address, price);

            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            await expect(
                strategyContract.connect(user2).buy(user2.address, slot0.epochId + 1, deadline, price)
            ).to.be.reverted;
        });

        it("should revert if max payment exceeded", async function () {
            const slot0 = await strategyContract.getSlot0();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(user2).approve(strategyContract.address, price);

            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            // Set max payment to less than current price to trigger revert
            const tooLowMax = price.div(2);
            await expect(
                strategyContract.connect(user2).buy(user2.address, slot0.epochId, deadline, tooLowMax)
            ).to.be.reverted;
        });
    });

    describe("Bribe Rewards", function () {
        let bribeContract, revenueRouter;

        beforeEach(async function () {
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            strategy = await voter.strategies(0);
            bribe = await voter.strategy_Bribe(strategy);
            bribeRouter = await voter.strategy_BribeRouter(strategy);
            bribeContract = await ethers.getContractAt("Bribe", bribe);

            revenueRouter = await ethers.getContractAt("RevenueRouter", await voter.revenueSource());

            // Stake and vote
            await underlying.connect(user1).approve(governanceToken.address, ethers.utils.parseEther("100"));
            await governanceToken.connect(user1).stake(ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
        });

        it("should distribute bribe rewards to voters", async function () {
            // Send revenue and buy from strategy
            await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("10"));
            await revenueRouter.flush();
            await voter["distribute(address)"](strategy);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const slot0 = await strategyContract.getSlot0();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(user2).approve(strategyContract.address, price);
            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            await strategyContract.connect(user2).buy(user2.address, slot0.epochId, deadline, price);

            // Distribute bribe
            const BribeRouter = await ethers.getContractFactory("BribeRouter");
            const bribeRouterContract = BribeRouter.attach(bribeRouter);
            await bribeRouterContract.distribute();

            // Advance time for rewards to accrue
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            // Check earned
            const earned = await bribeContract.earned(user1.address, paymentToken.address);
            expect(earned).to.be.gt(0);
        });

        it("should allow claiming rewards", async function () {
            await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("10"));
            await revenueRouter.flush();
            await voter["distribute(address)"](strategy);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const slot0 = await strategyContract.getSlot0();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(user2).approve(strategyContract.address, price);
            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            await strategyContract.connect(user2).buy(user2.address, slot0.epochId, deadline, price);

            const BribeRouter = await ethers.getContractFactory("BribeRouter");
            const bribeRouterContract = BribeRouter.attach(bribeRouter);
            await bribeRouterContract.distribute();

            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            const balanceBefore = await paymentToken.balanceOf(user1.address);
            await bribeContract.getReward(user1.address);
            const balanceAfter = await paymentToken.balanceOf(user1.address);

            expect(balanceAfter).to.be.gt(balanceBefore);
        });

        it("should distribute rewards proportionally to vote weight", async function () {
            // User2 also votes with same amount
            await underlying.connect(user2).approve(governanceToken.address, ethers.utils.parseEther("100"));
            await governanceToken.connect(user2).stake(ethers.utils.parseEther("100"));
            await voter.connect(user2).vote([strategy], [100]);

            // Execute strategy buy
            await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("10"));
            await revenueRouter.flush();
            await voter["distribute(address)"](strategy);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const slot0 = await strategyContract.getSlot0();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(user3).mint(user3.address, price);
            await paymentToken.connect(user3).approve(strategyContract.address, price);
            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            await strategyContract.connect(user3).buy(user3.address, slot0.epochId, deadline, price);

            const BribeRouter = await ethers.getContractFactory("BribeRouter");
            const bribeRouterContract = BribeRouter.attach(bribeRouter);
            await bribeRouterContract.distribute();

            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            const earned1 = await bribeContract.earned(user1.address, paymentToken.address);
            const earned2 = await bribeContract.earned(user2.address, paymentToken.address);

            // Should be roughly equal (same vote weight)
            expect(earned1).to.be.closeTo(earned2, earned1.div(100)); // 1% tolerance
        });
    });

    describe("Full Integration Flow", function () {
        it("should complete full cycle: stake -> vote -> revenue -> strategy -> bribes -> claim", async function () {
            // 1. Setup strategy
            const initPrice = ethers.utils.parseUnits("100", 6);
            await voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
            strategy = await voter.strategies(0);

            // 2. Users stake
            await underlying.connect(user1).approve(governanceToken.address, ethers.utils.parseEther("300"));
            await governanceToken.connect(user1).stake(ethers.utils.parseEther("300"));

            await underlying.connect(user2).approve(governanceToken.address, ethers.utils.parseEther("100"));
            await governanceToken.connect(user2).stake(ethers.utils.parseEther("100"));

            // 3. Users vote (75% / 25%)
            await voter.connect(user1).vote([strategy], [100]);
            await voter.connect(user2).vote([strategy], [100]);

            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("400"));

            // 4. Revenue arrives
            const revenueRouter = await ethers.getContractAt("RevenueRouter", await voter.revenueSource());
            await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("100"));
            await revenueRouter.flush();

            // 5. Distribute to strategy
            await voter["distribute(address)"](strategy);
            expect(await revenueToken.balanceOf(strategy)).to.equal(ethers.utils.parseEther("100"));

            // 6. Buyer purchases from strategy
            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const slot0 = await strategyContract.getSlot0();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(user3).mint(user3.address, price);
            await paymentToken.connect(user3).approve(strategyContract.address, price);
            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            await strategyContract.connect(user3).buy(user3.address, slot0.epochId, deadline, price);

            // user3 got revenue tokens
            expect(await revenueToken.balanceOf(user3.address)).to.equal(ethers.utils.parseEther("100"));

            // 7. Bribe router distributes to bribe
            bribeRouter = await voter.strategy_BribeRouter(strategy);
            const bribeRouterContract = await ethers.getContractAt("BribeRouter", bribeRouter);
            await bribeRouterContract.distribute();

            // 8. Time passes for rewards to accrue
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            // 9. Users claim rewards
            bribe = await voter.strategy_Bribe(strategy);
            const bribeContract = await ethers.getContractAt("Bribe", bribe);

            const earned1 = await bribeContract.earned(user1.address, paymentToken.address);
            const earned2 = await bribeContract.earned(user2.address, paymentToken.address);

            // User1 should earn 3x more than user2 (300 vs 100 stake)
            expect(earned1).to.be.closeTo(earned2.mul(3), earned1.div(100));

            // Claim
            await bribeContract.getReward(user1.address);
            await bribeContract.getReward(user2.address);

            expect(await paymentToken.balanceOf(user1.address)).to.be.gt(0);
            expect(await paymentToken.balanceOf(user2.address)).to.be.gt(0);

            // 10. Users can reset and unstake
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            await voter.connect(user1).reset();
            await voter.connect(user2).reset();

            await governanceToken.connect(user1).unstake(ethers.utils.parseEther("300"));
            await governanceToken.connect(user2).unstake(ethers.utils.parseEther("100"));

            expect(await underlying.balanceOf(user1.address)).to.equal(ethers.utils.parseEther("1000"));
            expect(await underlying.balanceOf(user2.address)).to.equal(ethers.utils.parseEther("1000"));
        });
    });
});
