const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Multicall Contract", function () {
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
        await underlying.mint(user1.address, ethers.utils.parseEther("1000"));
        await underlying.mint(user2.address, ethers.utils.parseEther("2000"));
        await underlying.mint(user3.address, ethers.utils.parseEther("3000"));
        await underlying.mint(user4.address, ethers.utils.parseEther("4000"));
        await revenueToken.mint(owner.address, ethers.utils.parseEther("100000"));
        await paymentToken.mint(user1.address, ethers.utils.parseUnits("100000", 6));
        await paymentToken.mint(user2.address, ethers.utils.parseUnits("100000", 6));
        await paymentToken.mint(user3.address, ethers.utils.parseUnits("100000", 6));
        await paymentToken.mint(user4.address, ethers.utils.parseUnits("100000", 6));
        await paymentToken2.mint(user1.address, ethers.utils.parseEther("100000"));
        await paymentToken2.mint(user2.address, ethers.utils.parseEther("100000"));
    });

    // Helper functions
    async function createStrategy(payment = paymentToken) {
        const initPrice = ethers.utils.parseUnits("100", payment.address === paymentToken.address ? 6 : 18);
        const tx = await voter.addStrategy(payment.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice);
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

    // ==================== CONSTRUCTOR ====================

    describe("Constructor", function () {
        it("should set voter address correctly", async function () {
            expect(await multicall.voter()).to.equal(voter.address);
        });
    });

    // ==================== VOTER STATE ====================

    describe("getVoterData", function () {
        it("should return correct global state with no account", async function () {
            const state = await multicall.getVoterData(ethers.constants.AddressZero);

            expect(state.governanceToken).to.equal(governanceToken.address);
            expect(state.revenueToken).to.equal(revenueToken.address);
            expect(state.treasury).to.equal(treasury.address);
            expect(state.underlyingToken).to.equal(underlying.address);
            expect(state.underlyingTokenDecimals).to.equal(18);
            expect(state.totalWeight).to.equal(0);
            expect(state.strategyCount).to.equal(0);
            expect(state.governanceTokenTotalSupply).to.equal(0);
        });

        it("should return correct account balances", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            const state = await multicall.getVoterData(user1.address);

            expect(state.accountGovernanceTokenBalance).to.equal(ethers.utils.parseEther("100"));
            expect(state.accountUnderlyingTokenBalance).to.equal(ethers.utils.parseEther("900"));
            expect(state.accountUsedWeights).to.equal(0);
            expect(state.accountLastVoted).to.equal(0);
        });

        it("should return correct state after voting", async function () {
            const { strategy } = await createStrategy();
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const state = await multicall.getVoterData(user1.address);

            expect(state.totalWeight).to.equal(ethers.utils.parseEther("100"));
            expect(state.strategyCount).to.equal(1);
            expect(state.accountUsedWeights).to.equal(ethers.utils.parseEther("100"));
            expect(state.accountLastVoted).to.be.gt(0);
        });

        it("should return correct governance token total supply", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));

            const state = await multicall.getVoterData(ethers.constants.AddressZero);

            expect(state.governanceTokenTotalSupply).to.equal(ethers.utils.parseEther("300"));
        });
    });

    // ==================== STRATEGY CARDS ====================

    describe("getStrategyData", function () {
        let strategy, bribe, bribeRouter;

        beforeEach(async function () {
            const s = await createStrategy();
            strategy = s.strategy;
            bribe = s.bribe;
            bribeRouter = s.bribeRouter;
        });

        it("should return correct strategy info", async function () {
            const card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);

            expect(card.strategy).to.equal(strategy);
            expect(card.bribe).to.equal(bribe);
            expect(card.bribeRouter).to.equal(bribeRouter);
            expect(card.paymentToken).to.equal(paymentToken.address);
            expect(card.paymentReceiver).to.equal(treasury.address);
            expect(card.isAlive).to.be.true;
            expect(card.paymentTokenDecimals).to.equal(6);
        });

        it("should return correct auction data", async function () {
            const card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);

            expect(card.epochPeriod).to.equal(HOUR);
            expect(card.priceMultiplier).to.equal(ethers.utils.parseEther("2"));
            expect(card.minInitPrice).to.equal(ethers.utils.parseUnits("100", 6));
            expect(card.epochId).to.equal(0);
            expect(card.initPrice).to.equal(ethers.utils.parseUnits("100", 6));
            expect(card.startTime).to.be.gt(0);
            expect(card.currentPrice).to.be.gt(0);
        });

        it("should return correct vote weight data", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);

            expect(card.strategyWeight).to.equal(ethers.utils.parseEther("100"));
            expect(card.votePercent).to.equal(ethers.utils.parseEther("100")); // 100%
        });

        it("should return correct vote percent with multiple strategies", async function () {
            const { strategy: strategy2 } = await createStrategy(paymentToken2);

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("300"));
            await voter.connect(user1).vote([strategy], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            const card1 = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
            const card2 = await multicall.getStrategyData(strategy2, ethers.constants.AddressZero);

            // strategy1: 100/400 = 25%, strategy2: 300/400 = 75%
            expect(card1.votePercent).to.equal(ethers.utils.parseEther("25"));
            expect(card2.votePercent).to.equal(ethers.utils.parseEther("75"));
        });

        it("should return correct claimable amount", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateStrategy(strategy);

            const card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);

            expect(card.claimable).to.equal(ethers.utils.parseEther("100"));
        });

        it("should return correct revenue balance", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);

            expect(card.revenueBalance).to.equal(ethers.utils.parseEther("100"));
        });

        it("should return correct account data", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const card = await multicall.getStrategyData(strategy, user1.address);

            expect(card.accountVotes).to.equal(ethers.utils.parseEther("100"));
            expect(card.accountPaymentTokenBalance).to.equal(ethers.utils.parseUnits("100000", 6));
        });

        it("should handle dead strategy", async function () {
            await voter.killStrategy(strategy);

            const card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);

            expect(card.isAlive).to.be.false;
        });
    });

    describe("getStrategiesData", function () {
        let strategy1, strategy2;

        beforeEach(async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);
            strategy1 = s1.strategy;
            strategy2 = s2.strategy;
        });

        it("should return all strategy cards in range", async function () {
            const cards = await multicall.getStrategiesData(0, 2, ethers.constants.AddressZero);

            expect(cards.length).to.equal(2);
            expect(cards[0].strategy).to.equal(strategy1);
            expect(cards[1].strategy).to.equal(strategy2);
        });

        it("should return partial range", async function () {
            const cards = await multicall.getStrategiesData(0, 1, ethers.constants.AddressZero);

            expect(cards.length).to.equal(1);
            expect(cards[0].strategy).to.equal(strategy1);
        });

        it("should return correct account data for all cards", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1, strategy2], [60, 40]);

            const cards = await multicall.getStrategiesData(0, 2, user1.address);

            expect(cards[0].accountVotes).to.equal(ethers.utils.parseEther("60"));
            expect(cards[1].accountVotes).to.equal(ethers.utils.parseEther("40"));
        });
    });

    describe("getAllStrategiesData", function () {
        it("should return all strategy cards", async function () {
            await createStrategy(paymentToken);
            await createStrategy(paymentToken2);
            await createStrategy(paymentToken);

            const cards = await multicall.getAllStrategiesData(ethers.constants.AddressZero);

            expect(cards.length).to.equal(3);
        });

        it("should return empty array when no strategies", async function () {
            const cards = await multicall.getAllStrategiesData(ethers.constants.AddressZero);

            expect(cards.length).to.equal(0);
        });
    });

    // ==================== BRIBE CARDS ====================

    describe("getBribeData", function () {
        let strategy, bribe;

        beforeEach(async function () {
            const s = await createStrategy();
            strategy = s.strategy;
            bribe = s.bribe;
            // Note: paymentToken is automatically added as reward when strategy is created
        });

        it("should return correct bribe info", async function () {
            const card = await multicall.getBribeData(strategy, ethers.constants.AddressZero);

            expect(card.strategy).to.equal(strategy);
            expect(card.bribe).to.equal(bribe);
            expect(card.isAlive).to.be.true;
        });

        it("should return correct reward tokens", async function () {
            const card = await multicall.getBribeData(strategy, ethers.constants.AddressZero);

            expect(card.rewardTokens.length).to.equal(1);
            expect(card.rewardTokens[0]).to.equal(paymentToken.address);
            expect(card.rewardTokenDecimals[0]).to.equal(6);
        });

        it("should return correct vote data", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const card = await multicall.getBribeData(strategy, ethers.constants.AddressZero);

            expect(card.voteWeight).to.equal(ethers.utils.parseEther("100"));
            expect(card.votePercent).to.equal(ethers.utils.parseEther("100"));
            expect(card.totalSupply).to.equal(ethers.utils.parseEther("100"));
        });

        it("should return correct account vote (virtual balance)", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            const card = await multicall.getBribeData(strategy, user1.address);

            expect(card.accountVote).to.equal(ethers.utils.parseEther("100"));
        });

        it("should return zero accountVote for non-voter", async function () {
            const card = await multicall.getBribeData(strategy, user1.address);

            expect(card.accountVote).to.equal(0);
        });

        it("should return correct rewards data with active rewards", async function () {
            await voter.setBribeSplit(2000); // 20%
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Generate bribe rewards through auction
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(user2).approve(strategyContract.address, price);
            const block = await ethers.provider.getBlock("latest");
            await strategyContract.connect(user2).buy(user2.address, epochId, block.timestamp + 3600, price);

            // Distribute bribes
            const bribeRouterAddr = await voter.strategy_BribeRouter(strategy);
            const bribeRouter = await ethers.getContractAt("BribeRouter", bribeRouterAddr);
            await bribeRouter.distribute();

            const card = await multicall.getBribeData(strategy, user1.address);

            expect(card.rewardsPerToken.length).to.equal(1);
            expect(card.rewardsLeft.length).to.equal(1);
            expect(card.rewardsLeft[0]).to.be.gt(0);
        });
    });

    describe("getBribesData", function () {
        let strategy1, strategy2;

        beforeEach(async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);
            strategy1 = s1.strategy;
            strategy2 = s2.strategy;
        });

        it("should return all bribe cards in range", async function () {
            const cards = await multicall.getBribesData(0, 2, ethers.constants.AddressZero);

            expect(cards.length).to.equal(2);
            expect(cards[0].strategy).to.equal(strategy1);
            expect(cards[1].strategy).to.equal(strategy2);
        });

        it("should return partial range", async function () {
            const cards = await multicall.getBribesData(1, 2, ethers.constants.AddressZero);

            expect(cards.length).to.equal(1);
            expect(cards[0].strategy).to.equal(strategy2);
        });
    });

    describe("getAllBribesData", function () {
        it("should return all bribe cards", async function () {
            await createStrategy(paymentToken);
            await createStrategy(paymentToken2);

            const cards = await multicall.getAllBribesData(ethers.constants.AddressZero);

            expect(cards.length).to.equal(2);
        });

        it("should return empty array when no strategies", async function () {
            const cards = await multicall.getAllBribesData(ethers.constants.AddressZero);

            expect(cards.length).to.equal(0);
        });
    });

    // ==================== HELPER FUNCTIONS ====================

    describe("Helper Functions", function () {
        let strategy1, strategy2;

        beforeEach(async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);
            strategy1 = s1.strategy;
            strategy2 = s2.strategy;
        });

        it("getStrategies should return all strategy addresses", async function () {
            const strategies = await multicall.getStrategies();

            expect(strategies.length).to.equal(2);
            expect(strategies[0]).to.equal(strategy1);
            expect(strategies[1]).to.equal(strategy2);
        });

        it("getStrategy should return strategy at index", async function () {
            expect(await multicall.getStrategy(0)).to.equal(strategy1);
            expect(await multicall.getStrategy(1)).to.equal(strategy2);
        });

        it("getStrategyCount should return correct count", async function () {
            expect(await multicall.getStrategyCount()).to.equal(2);
        });
    });

    // ==================== EDGE CASES ====================

    describe("Edge Cases", function () {
        it("should handle zero address account", async function () {
            const { strategy } = await createStrategy();

            const strategyCard = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
            const bribeCard = await multicall.getBribeData(strategy, ethers.constants.AddressZero);
            const getVoterDataData = await multicall.getVoterData(ethers.constants.AddressZero);

            expect(strategyCard.accountVotes).to.equal(0);
            expect(strategyCard.accountPaymentTokenBalance).to.equal(0);
            expect(bribeCard.accountVote).to.equal(0);
            expect(getVoterDataData.accountGovernanceTokenBalance).to.equal(0);
        });

        it("should handle multiple reward tokens", async function () {
            const { strategy, bribe } = await createStrategy();

            // paymentToken is auto-added when strategy is created, so add a second one
            await voter.addBribeReward(bribe, revenueToken.address);

            const card = await multicall.getBribeData(strategy, ethers.constants.AddressZero);

            expect(card.rewardTokens.length).to.equal(2);
            expect(card.rewardTokenDecimals.length).to.equal(2);
            expect(card.rewardsPerToken.length).to.equal(2);
            expect(card.accountRewardsEarned.length).to.equal(2);
            expect(card.rewardsLeft.length).to.equal(2);
        });

        it("should handle strategy with zero total weight", async function () {
            const { strategy } = await createStrategy();

            const card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);

            expect(card.strategyWeight).to.equal(0);
            expect(card.votePercent).to.equal(0);
        });

        it("should handle bribe with zero total supply", async function () {
            const { strategy } = await createStrategy();

            const card = await multicall.getBribeData(strategy, ethers.constants.AddressZero);

            expect(card.totalSupply).to.equal(0);
        });
    });

    // ==================== GAS OPTIMIZATION CHECKS ====================

    describe("Gas Optimization", function () {
        it("should efficiently batch strategy card reads", async function () {
            // Create 5 strategies
            for (let i = 0; i < 5; i++) {
                await createStrategy(i % 2 === 0 ? paymentToken : paymentToken2);
            }

            await stakeTokens(user1, ethers.utils.parseEther("100"));

            // This should be more efficient than 5 separate calls
            const cards = await multicall.getAllStrategiesData(user1.address);

            expect(cards.length).to.equal(5);
        });

        it("should efficiently batch bribe card reads", async function () {
            // Create 5 strategies
            for (let i = 0; i < 5; i++) {
                await createStrategy(i % 2 === 0 ? paymentToken : paymentToken2);
            }

            // This should be more efficient than 5 separate calls
            const cards = await multicall.getAllBribesData(user1.address);

            expect(cards.length).to.equal(5);
        });
    });

    // ==================== DISTRIBUTE FUNCTIONS ====================

    describe("distribute", function () {
        let strategy;

        beforeEach(async function () {
            const s = await createStrategy();
            strategy = s.strategy;

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));
        });

        it("should distribute revenue to a single strategy", async function () {
            const strategyContract = await ethers.getContractAt("Strategy", strategy);

            // Before distribute
            expect(await strategyContract.getRevenueBalance()).to.equal(0);

            // Distribute via multicall
            await multicall.distribute(strategy);

            // After distribute
            expect(await strategyContract.getRevenueBalance()).to.equal(ethers.utils.parseEther("100"));
        });

        it("should allow anyone to call distribute", async function () {
            const strategyContract = await ethers.getContractAt("Strategy", strategy);

            await multicall.connect(user2).distribute(strategy);

            expect(await strategyContract.getRevenueBalance()).to.equal(ethers.utils.parseEther("100"));
        });

        it("should not affect other strategies", async function () {
            const { strategy: strategy2 } = await createStrategy(paymentToken2);

            // Vote for strategy2 in new epoch
            await advanceToNextEpoch();
            await voter.connect(user1).vote([strategy, strategy2], [50, 50]);
            await sendRevenue(ethers.utils.parseEther("100"));

            // Only distribute to strategy1
            await multicall.distribute(strategy);

            const strategy1Contract = await ethers.getContractAt("Strategy", strategy);
            const strategy2Contract = await ethers.getContractAt("Strategy", strategy2);

            // strategy1 should have revenue, strategy2 should not
            expect(await strategy1Contract.getRevenueBalance()).to.be.gt(0);
            expect(await strategy2Contract.getRevenueBalance()).to.equal(0);
        });

        it("should handle multiple distribute calls", async function () {
            const strategyContract = await ethers.getContractAt("Strategy", strategy);

            await multicall.distribute(strategy);
            expect(await strategyContract.getRevenueBalance()).to.equal(ethers.utils.parseEther("100"));

            // Send more revenue
            await sendRevenue(ethers.utils.parseEther("50"));

            // Distribute again
            await multicall.distribute(strategy);
            expect(await strategyContract.getRevenueBalance()).to.equal(ethers.utils.parseEther("150"));
        });
    });

    describe("distro", function () {
        let strategy1, strategy2, strategy3;

        beforeEach(async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);
            const s3 = await createStrategy(paymentToken);
            strategy1 = s1.strategy;
            strategy2 = s2.strategy;
            strategy3 = s3.strategy;

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));

            await voter.connect(user1).vote([strategy1, strategy2], [50, 50]);
            await voter.connect(user2).vote([strategy2, strategy3], [50, 50]);

            // Total: strategy1=50, strategy2=150, strategy3=100 (total=300)
            await sendRevenue(ethers.utils.parseEther("300"));
        });

        it("should distribute to all strategies", async function () {
            await multicall.distributeAll();

            const s1Contract = await ethers.getContractAt("Strategy", strategy1);
            const s2Contract = await ethers.getContractAt("Strategy", strategy2);
            const s3Contract = await ethers.getContractAt("Strategy", strategy3);

            // 50/300 * 300 = 50
            expect(await s1Contract.getRevenueBalance()).to.equal(ethers.utils.parseEther("50"));
            // 150/300 * 300 = 150
            expect(await s2Contract.getRevenueBalance()).to.equal(ethers.utils.parseEther("150"));
            // 100/300 * 300 = 100
            expect(await s3Contract.getRevenueBalance()).to.equal(ethers.utils.parseEther("100"));
        });

        it("should allow anyone to call distributeAll", async function () {
            await multicall.connect(user3).distributeAll();

            const s1Contract = await ethers.getContractAt("Strategy", strategy1);
            expect(await s1Contract.getRevenueBalance()).to.be.gt(0);
        });

        it("should handle distributeAll with no pending revenue", async function () {
            // First distributeAll
            await multicall.distributeAll();

            const s1Contract = await ethers.getContractAt("Strategy", strategy1);
            const balanceAfterFirst = await s1Contract.getRevenueBalance();

            // Second distro with no new revenue
            await multicall.distributeAll();

            // Balance should remain the same
            expect(await s1Contract.getRevenueBalance()).to.equal(balanceAfterFirst);
        });
    });

    // ==================== BUY FUNCTIONS ====================

    describe("distributeAndBuy", function () {
        let strategy;

        beforeEach(async function () {
            const s = await createStrategy();
            strategy = s.strategy;

            // Setup: stake tokens and vote so revenue gets distributed
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy], [100]);

            // Send revenue to router and flush to voter
            await sendRevenue(ethers.utils.parseEther("100"));
        });

        it("should distribute and execute buy", async function () {
            // Approve multicall to spend payment tokens
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            // Get strategy contract to check epoch
            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const epochId = await strategyContract.epochId();
            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;

            // Check revenue balance before (should be 0 as not distributed yet)
            const revenueBalanceBefore = await strategyContract.getRevenueBalance();
            expect(revenueBalanceBefore).to.equal(0);

            // Execute distributeAndBuy
            await multicall.connect(user2).distributeAndBuy(strategy, epochId, deadline, maxPayment);

            // User should have received revenue tokens
            const userRevenueBalance = await revenueToken.balanceOf(user2.address);
            expect(userRevenueBalance).to.equal(ethers.utils.parseEther("100"));
        });

        it("should refund unused payment tokens", async function () {
            const maxPayment = ethers.utils.parseUnits("10000", 6);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const epochId = await strategyContract.epochId();
            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;

            const balanceBefore = await paymentToken.balanceOf(user2.address);
            await multicall.connect(user2).distributeAndBuy(strategy, epochId, deadline, maxPayment);
            const balanceAfter = await paymentToken.balanceOf(user2.address);

            // User should have been refunded (balance should be > balanceBefore - maxPayment)
            const spent = balanceBefore.sub(balanceAfter);
            expect(spent).to.be.lt(maxPayment);
        });

        it("should revert with wrong epochId", async function () {
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;

            await expect(
                multicall.connect(user2).distributeAndBuy(strategy, 999, deadline, maxPayment)
            ).to.be.reverted;
        });

        it("should revert with expired deadline", async function () {
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            const strategyContract = await ethers.getContractAt("Strategy", strategy);
            const epochId = await strategyContract.epochId();

            await expect(
                multicall.connect(user2).distributeAndBuy(strategy, epochId, 1, maxPayment)
            ).to.be.reverted;
        });
    });

    describe("distributeAllAndBuy", function () {
        let strategy1, strategy2;

        beforeEach(async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);
            strategy1 = s1.strategy;
            strategy2 = s2.strategy;

            // Setup: stake tokens and vote
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1, strategy2], [50, 50]);

            // Send revenue
            await sendRevenue(ethers.utils.parseEther("100"));
        });

        it("should distro all and execute buy", async function () {
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            const strategyContract = await ethers.getContractAt("Strategy", strategy1);
            const epochId = await strategyContract.epochId();
            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;

            // Execute distributeAllAndBuy
            await multicall.connect(user2).distributeAllAndBuy(strategy1, epochId, deadline, maxPayment);

            // User should have received revenue tokens (50% of 100 = 50)
            const userRevenueBalance = await revenueToken.balanceOf(user2.address);
            expect(userRevenueBalance).to.equal(ethers.utils.parseEther("50"));

            // The other strategy should also have been distributed
            const strategy2Contract = await ethers.getContractAt("Strategy", strategy2);
            const strategy2Balance = await strategy2Contract.getRevenueBalance();
            expect(strategy2Balance).to.equal(ethers.utils.parseEther("50"));
        });

        it("should refund unused payment tokens", async function () {
            const maxPayment = ethers.utils.parseUnits("10000", 6);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            const strategyContract = await ethers.getContractAt("Strategy", strategy1);
            const epochId = await strategyContract.epochId();
            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;

            const balanceBefore = await paymentToken.balanceOf(user2.address);
            await multicall.connect(user2).distributeAllAndBuy(strategy1, epochId, deadline, maxPayment);
            const balanceAfter = await paymentToken.balanceOf(user2.address);

            // User should have been refunded
            const spent = balanceBefore.sub(balanceAfter);
            expect(spent).to.be.lt(maxPayment);
        });

        it("should revert with wrong epochId", async function () {
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;

            await expect(
                multicall.connect(user2).distributeAllAndBuy(strategy1, 999, deadline, maxPayment)
            ).to.be.reverted;
        });

        it("should revert with expired deadline", async function () {
            const maxPayment = ethers.utils.parseUnits("1000", 6);
            await paymentToken.connect(user2).approve(multicall.address, maxPayment);

            const strategyContract = await ethers.getContractAt("Strategy", strategy1);
            const epochId = await strategyContract.epochId();

            await expect(
                multicall.connect(user2).distributeAllAndBuy(strategy1, epochId, 1, maxPayment)
            ).to.be.reverted;
        });
    });

    // ==================== COMPLEX SCENARIOS ====================

    describe("Complex Scenarios", function () {
        describe("Multi-user voting and revenue distribution", function () {
            let strategy1, strategy2, strategy3;

            beforeEach(async function () {
                const s1 = await createStrategy(paymentToken);
                const s2 = await createStrategy(paymentToken2);
                const s3 = await createStrategy(paymentToken);
                strategy1 = s1.strategy;
                strategy2 = s2.strategy;
                strategy3 = s3.strategy;
            });

            it("should correctly show vote distribution across multiple users", async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await stakeTokens(user2, ethers.utils.parseEther("200"));
                await stakeTokens(user3, ethers.utils.parseEther("300"));
                await stakeTokens(user4, ethers.utils.parseEther("400"));

                await voter.connect(user1).vote([strategy1], [100]);
                await voter.connect(user2).vote([strategy1, strategy2], [50, 50]);
                await voter.connect(user3).vote([strategy2, strategy3], [60, 40]);
                await voter.connect(user4).vote([strategy3], [100]);

                // Total weights:
                // strategy1: 100 + 100 = 200
                // strategy2: 100 + 180 = 280
                // strategy3: 120 + 400 = 520
                // total = 1000

                const card1 = await multicall.getStrategyData(strategy1, ethers.constants.AddressZero);
                const card2 = await multicall.getStrategyData(strategy2, ethers.constants.AddressZero);
                const card3 = await multicall.getStrategyData(strategy3, ethers.constants.AddressZero);

                expect(card1.strategyWeight).to.equal(ethers.utils.parseEther("200"));
                expect(card2.strategyWeight).to.equal(ethers.utils.parseEther("280"));
                expect(card3.strategyWeight).to.equal(ethers.utils.parseEther("520"));

                // Check vote percentages (scaled by 1e18)
                expect(card1.votePercent).to.equal(ethers.utils.parseEther("20")); // 20%
                expect(card2.votePercent).to.equal(ethers.utils.parseEther("28")); // 28%
                expect(card3.votePercent).to.equal(ethers.utils.parseEther("52")); // 52%
            });

            it("should correctly show individual account votes", async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1, strategy2, strategy3], [50, 30, 20]);

                const card1 = await multicall.getStrategyData(strategy1, user1.address);
                const card2 = await multicall.getStrategyData(strategy2, user1.address);
                const card3 = await multicall.getStrategyData(strategy3, user1.address);

                expect(card1.accountVotes).to.equal(ethers.utils.parseEther("50"));
                expect(card2.accountVotes).to.equal(ethers.utils.parseEther("30"));
                expect(card3.accountVotes).to.equal(ethers.utils.parseEther("20"));
            });

            it("should update correctly when votes change across epochs", async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1], [100]);

                let card = await multicall.getStrategyData(strategy1, user1.address);
                expect(card.accountVotes).to.equal(ethers.utils.parseEther("100"));
                expect(card.strategyWeight).to.equal(ethers.utils.parseEther("100"));

                // Move to next epoch and change vote
                await advanceToNextEpoch();
                await voter.connect(user1).vote([strategy2], [100]);

                const card1 = await multicall.getStrategyData(strategy1, user1.address);
                const card2 = await multicall.getStrategyData(strategy2, user1.address);

                expect(card1.accountVotes).to.equal(0);
                expect(card1.strategyWeight).to.equal(0);
                expect(card2.accountVotes).to.equal(ethers.utils.parseEther("100"));
                expect(card2.strategyWeight).to.equal(ethers.utils.parseEther("100"));
            });
        });

        describe("Revenue distribution tracking", function () {
            let strategy;

            beforeEach(async function () {
                const s = await createStrategy();
                strategy = s.strategy;

                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
            });

            it("should track claimable and revenue balance correctly", async function () {
                await sendRevenue(ethers.utils.parseEther("100"));

                // Before distribute - claimable should be shown (after voter update)
                await voter.updateStrategy(strategy);
                let card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.claimable).to.equal(ethers.utils.parseEther("100"));
                expect(card.revenueBalance).to.equal(0);

                // After distribute - revenue should be in strategy
                await multicall.distribute(strategy);
                card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.claimable).to.equal(0);
                expect(card.revenueBalance).to.equal(ethers.utils.parseEther("100"));
            });

            it("should track multiple revenue distributions", async function () {
                // First revenue
                await sendRevenue(ethers.utils.parseEther("50"));
                await multicall.distribute(strategy);

                let card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.revenueBalance).to.equal(ethers.utils.parseEther("50"));

                // Second revenue
                await sendRevenue(ethers.utils.parseEther("75"));
                await multicall.distribute(strategy);

                card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.revenueBalance).to.equal(ethers.utils.parseEther("125"));
            });
        });

        describe("Auction state tracking", function () {
            let strategy;

            beforeEach(async function () {
                const s = await createStrategy();
                strategy = s.strategy;

                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
                await multicall.distribute(strategy);
            });

            it("should track auction price decay over time", async function () {
                const card1 = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                const initialPrice = card1.currentPrice;

                // Advance time by 30 minutes (half the epoch)
                await advanceTime(30 * 60);

                const card2 = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                const midPrice = card2.currentPrice;

                // Price should have decayed
                expect(midPrice).to.be.lt(initialPrice);
                // Should be approximately half (with some tolerance for block time)
                expect(midPrice).to.be.closeTo(initialPrice.div(2), initialPrice.div(20));
            });

            it("should track epoch changes after buy", async function () {
                const cardBefore = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                const epochBefore = cardBefore.epochId;

                // Execute buy
                const maxPayment = ethers.utils.parseUnits("1000", 6);
                await paymentToken.connect(user2).approve(multicall.address, maxPayment);
                const block = await ethers.provider.getBlock("latest");
                await multicall.connect(user2).distributeAndBuy(strategy, epochBefore, block.timestamp + 3600, maxPayment);

                const cardAfter = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);

                // Epoch should have advanced
                expect(cardAfter.epochId).to.equal(epochBefore.add(1));
                // Revenue balance should be 0 (bought)
                expect(cardAfter.revenueBalance).to.equal(0);
                // New start time should be updated
                expect(cardAfter.startTime).to.be.gte(cardBefore.startTime);
            });

            it("should show price at zero after epoch expires", async function () {
                // Advance past the epoch period (1 hour)
                await advanceTime(HOUR + 60);

                const card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.currentPrice).to.equal(0);
            });
        });

        describe("Bribe rewards tracking", function () {
            let strategy, bribe;

            beforeEach(async function () {
                const s = await createStrategy();
                strategy = s.strategy;
                bribe = s.bribe;

                await voter.setBribeSplit(2000); // 20% to bribes
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
            });

            it("should track bribe rewards after auction purchase", async function () {
                // Send revenue and distribute
                await sendRevenue(ethers.utils.parseEther("100"));
                await multicall.distribute(strategy);

                // Buy from auction (generates bribe rewards)
                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const epochId = await strategyContract.epochId();
                const price = await strategyContract.getPrice();

                await paymentToken.connect(user2).approve(strategy, price);
                const block = await ethers.provider.getBlock("latest");
                await strategyContract.connect(user2).buy(user2.address, epochId, block.timestamp + 3600, price);

                // Distribute bribes
                const bribeRouterAddr = await voter.strategy_BribeRouter(strategy);
                const bribeRouter = await ethers.getContractAt("BribeRouter", bribeRouterAddr);
                await bribeRouter.distribute();

                // Check bribe card shows rewards
                const bribeCard = await multicall.getBribeData(strategy, user1.address);

                expect(bribeCard.rewardsLeft[0]).to.be.gt(0);
            });

            it("should track earned rewards over time", async function () {
                // Setup rewards
                await sendRevenue(ethers.utils.parseEther("100"));
                await multicall.distribute(strategy);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const epochId = await strategyContract.epochId();
                const price = await strategyContract.getPrice();

                await paymentToken.connect(user2).approve(strategy, price);
                const block = await ethers.provider.getBlock("latest");
                await strategyContract.connect(user2).buy(user2.address, epochId, block.timestamp + 3600, price);

                const bribeRouterAddr = await voter.strategy_BribeRouter(strategy);
                const bribeRouter = await ethers.getContractAt("BribeRouter", bribeRouterAddr);
                await bribeRouter.distribute();

                // Check earned before time passes
                const bribeCard1 = await multicall.getBribeData(strategy, user1.address);
                const earnedBefore = bribeCard1.accountRewardsEarned[0];

                // Advance time
                await advanceTime(DAY);

                // Check earned after time passes
                const bribeCard2 = await multicall.getBribeData(strategy, user1.address);
                const earnedAfter = bribeCard2.accountRewardsEarned[0];

                expect(earnedAfter).to.be.gt(earnedBefore);
            });
        });

        describe("Dead strategy handling", function () {
            let strategy;

            beforeEach(async function () {
                const s = await createStrategy();
                strategy = s.strategy;

                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
            });

            it("should reflect killed strategy in cards", async function () {
                let card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.isAlive).to.be.true;

                await voter.killStrategy(strategy);

                card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.isAlive).to.be.false;
            });

            it("should not accumulate claimable for dead strategy", async function () {
                await sendRevenue(ethers.utils.parseEther("50"));
                await voter.updateStrategy(strategy);

                let card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.claimable).to.equal(ethers.utils.parseEther("50"));

                // Kill strategy
                await voter.killStrategy(strategy);

                card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.claimable).to.equal(0);

                // Send more revenue - should not accumulate
                await sendRevenue(ethers.utils.parseEther("50"));
                await voter.updateStrategy(strategy);

                card = await multicall.getStrategyData(strategy, ethers.constants.AddressZero);
                expect(card.claimable).to.equal(0);
            });
        });
    });

    // ==================== INTEGRATION TESTS ====================

    describe("Integration Tests", function () {
        describe("Full auction lifecycle", function () {
            let strategy;

            beforeEach(async function () {
                const s = await createStrategy();
                strategy = s.strategy;
            });

            it("should track complete auction lifecycle through multicall", async function () {
                // 1. Setup voting
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);

                let state = await multicall.getVoterData(user1.address);
                expect(state.totalWeight).to.equal(ethers.utils.parseEther("100"));

                // 2. Revenue comes in
                await sendRevenue(ethers.utils.parseEther("100"));

                // 3. Check claimable via strategy card (after update)
                await voter.updateStrategy(strategy);
                let card = await multicall.getStrategyData(strategy, user1.address);
                expect(card.claimable).to.equal(ethers.utils.parseEther("100"));
                expect(card.revenueBalance).to.equal(0);

                // 4. Distribute and check
                await multicall.distribute(strategy);
                card = await multicall.getStrategyData(strategy, user1.address);
                expect(card.claimable).to.equal(0);
                expect(card.revenueBalance).to.equal(ethers.utils.parseEther("100"));

                // 5. Check auction state
                expect(card.epochId).to.equal(0);
                expect(card.currentPrice).to.be.gt(0);

                // 6. Execute buy
                const maxPayment = ethers.utils.parseUnits("1000", 6);
                await paymentToken.connect(user2).approve(multicall.address, maxPayment);
                const block = await ethers.provider.getBlock("latest");
                await multicall.connect(user2).distributeAndBuy(strategy, card.epochId, block.timestamp + 3600, maxPayment);

                // 7. Verify post-buy state
                card = await multicall.getStrategyData(strategy, user1.address);
                expect(card.epochId).to.equal(1);
                expect(card.revenueBalance).to.equal(0);

                // 8. Buyer received revenue tokens
                expect(await revenueToken.balanceOf(user2.address)).to.equal(ethers.utils.parseEther("100"));
            });
        });

        describe("Pagination", function () {
            it("should correctly paginate strategy cards", async function () {
                // Create 10 strategies
                const strategies = [];
                for (let i = 0; i < 10; i++) {
                    const s = await createStrategy(i % 2 === 0 ? paymentToken : paymentToken2);
                    strategies.push(s.strategy);
                }

                // Get first 5
                const first5 = await multicall.getStrategiesData(0, 5, ethers.constants.AddressZero);
                expect(first5.length).to.equal(5);
                expect(first5[0].strategy).to.equal(strategies[0]);
                expect(first5[4].strategy).to.equal(strategies[4]);

                // Get next 5
                const next5 = await multicall.getStrategiesData(5, 10, ethers.constants.AddressZero);
                expect(next5.length).to.equal(5);
                expect(next5[0].strategy).to.equal(strategies[5]);
                expect(next5[4].strategy).to.equal(strategies[9]);

                // Get middle range
                const middle = await multicall.getStrategiesData(3, 7, ethers.constants.AddressZero);
                expect(middle.length).to.equal(4);
                expect(middle[0].strategy).to.equal(strategies[3]);
                expect(middle[3].strategy).to.equal(strategies[6]);
            });

            it("should correctly paginate bribe cards", async function () {
                // Create 10 strategies
                const strategies = [];
                for (let i = 0; i < 10; i++) {
                    const s = await createStrategy(i % 2 === 0 ? paymentToken : paymentToken2);
                    strategies.push(s.strategy);
                }

                // Get first 5
                const first5 = await multicall.getBribesData(0, 5, ethers.constants.AddressZero);
                expect(first5.length).to.equal(5);
                expect(first5[0].strategy).to.equal(strategies[0]);

                // Get all
                const all = await multicall.getAllBribesData(ethers.constants.AddressZero);
                expect(all.length).to.equal(10);
            });
        });

        describe("Multiple payment tokens", function () {
            it("should handle strategies with different payment tokens", async function () {
                const s1 = await createStrategy(paymentToken);   // USDC (6 decimals)
                const s2 = await createStrategy(paymentToken2);  // DAI (18 decimals)

                const card1 = await multicall.getStrategyData(s1.strategy, user1.address);
                const card2 = await multicall.getStrategyData(s2.strategy, user1.address);

                expect(card1.paymentToken).to.equal(paymentToken.address);
                expect(card1.paymentTokenDecimals).to.equal(6);

                expect(card2.paymentToken).to.equal(paymentToken2.address);
                expect(card2.paymentTokenDecimals).to.equal(18);
            });

            it("should show correct account payment token balances", async function () {
                const s1 = await createStrategy(paymentToken);
                const s2 = await createStrategy(paymentToken2);

                const card1 = await multicall.getStrategyData(s1.strategy, user1.address);
                const card2 = await multicall.getStrategyData(s2.strategy, user1.address);

                expect(card1.accountPaymentTokenBalance).to.equal(ethers.utils.parseUnits("100000", 6));
                expect(card2.accountPaymentTokenBalance).to.equal(ethers.utils.parseEther("100000"));
            });
        });
    });

    // ==================== ERROR HANDLING ====================

    describe("Error Handling", function () {
        describe("distributeAndBuy errors", function () {
            let strategy;

            beforeEach(async function () {
                const s = await createStrategy();
                strategy = s.strategy;

                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
            });

            it("should revert when maxPayment is too low", async function () {
                const maxPayment = ethers.utils.parseUnits("1", 6); // Very low
                await paymentToken.connect(user2).approve(multicall.address, maxPayment);

                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const epochId = await strategyContract.epochId();
                const block = await ethers.provider.getBlock("latest");

                await expect(
                    multicall.connect(user2).distributeAndBuy(strategy, epochId, block.timestamp + 3600, maxPayment)
                ).to.be.reverted;
            });

            it("should revert when insufficient approval", async function () {
                // Don't approve multicall
                const strategyContract = await ethers.getContractAt("Strategy", strategy);
                const epochId = await strategyContract.epochId();
                const block = await ethers.provider.getBlock("latest");

                await expect(
                    multicall.connect(user2).distributeAndBuy(
                        strategy,
                        epochId,
                        block.timestamp + 3600,
                        ethers.utils.parseUnits("1000", 6)
                    )
                ).to.be.reverted;
            });

            it("should revert when buying from strategy with no claimable revenue", async function () {
                // Create a new strategy with no votes (so no revenue allocation)
                const { strategy: emptyStrategy } = await createStrategy();

                const maxPayment = ethers.utils.parseUnits("1000", 6);
                await paymentToken.connect(user2).approve(multicall.address, maxPayment);

                const strategyContract = await ethers.getContractAt("Strategy", emptyStrategy);
                const epochId = await strategyContract.epochId();
                const block = await ethers.provider.getBlock("latest");

                // Strategy has 0 revenue balance and 0 claimable (no votes pointing to it)
                await expect(
                    multicall.connect(user2).distributeAndBuy(emptyStrategy, epochId, block.timestamp + 3600, maxPayment)
                ).to.be.reverted;
            });
        });
    });
});
