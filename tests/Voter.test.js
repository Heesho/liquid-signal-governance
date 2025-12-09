const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Voter Contract - Comprehensive Tests", function () {
    let owner, user1, user2, user3, user4, treasury, attacker;
    let underlying, revenueToken, paymentToken, paymentToken2;
    let governanceToken, voter, bribeFactory, strategyFactory, revenueRouter;

    const WEEK = 7 * 24 * 60 * 60;
    const HOUR = 60 * 60;
    const DAY = 24 * 60 * 60;

    beforeEach(async function () {
        [owner, user1, user2, user3, user4, treasury, attacker] = await ethers.getSigners();

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

        // Mint tokens to users
        await underlying.mint(user1.address, ethers.utils.parseEther("1000"));
        await underlying.mint(user2.address, ethers.utils.parseEther("1000"));
        await underlying.mint(user3.address, ethers.utils.parseEther("1000"));
        await underlying.mint(user4.address, ethers.utils.parseEther("1000"));
        await revenueToken.mint(owner.address, ethers.utils.parseEther("100000"));
        await paymentToken.mint(user1.address, ethers.utils.parseUnits("100000", 6));
        await paymentToken.mint(user2.address, ethers.utils.parseUnits("100000", 6));
        await paymentToken.mint(user3.address, ethers.utils.parseUnits("100000", 6));
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

    async function advanceToNextEpoch() {
        await ethers.provider.send("evm_increaseTime", [WEEK]);
        await ethers.provider.send("evm_mine");
    }

    async function sendRevenue(amount) {
        await revenueToken.transfer(revenueRouter.address, amount);
        await revenueRouter.flush();
    }

    // ==================== CONSTRUCTOR & INITIALIZATION ====================

    describe("Constructor & Initialization", function () {
        it("should set immutable variables correctly", async function () {
            expect(await voter.governanceToken()).to.equal(governanceToken.address);
            expect(await voter.revenueToken()).to.equal(revenueToken.address);
            expect(await voter.treasury()).to.equal(treasury.address);
            expect(await voter.bribeFactory()).to.equal(bribeFactory.address);
            expect(await voter.strategyFactory()).to.equal(strategyFactory.address);
        });

        it("should start with zero totalWeight", async function () {
            expect(await voter.totalWeight()).to.equal(0);
        });

        it("should start with zero bribeSplit", async function () {
            expect(await voter.bribeSplit()).to.equal(0);
        });

        it("should start with no strategies", async function () {
            expect(await voter.length()).to.equal(0);
            const strategies = await voter.getStrategies();
            expect(strategies.length).to.equal(0);
        });

        it("should have correct constants", async function () {
            expect(await voter.MAX_BRIBE_SPLIT()).to.equal(5000);
            expect(await voter.DIVISOR()).to.equal(10000);
        });
    });

    // ==================== ADMIN FUNCTIONS ====================

    describe("Admin Functions", function () {
        describe("setRevenueSource", function () {
            it("should allow owner to set revenue source", async function () {
                const newSource = user1.address;
                await expect(voter.setRevenueSource(newSource))
                    .to.emit(voter, "Voter__RevenueSourceSet")
                    .withArgs(newSource);
                expect(await voter.revenueSource()).to.equal(newSource);
            });

            it("should revert when non-owner calls", async function () {
                await expect(voter.connect(user1).setRevenueSource(user1.address))
                    .to.be.revertedWith("Ownable: caller is not the owner");
            });

            it("should revert with zero address", async function () {
                await expect(voter.setRevenueSource(ethers.constants.AddressZero))
                    .to.be.reverted;
            });
        });

        describe("setBribeSplit", function () {
            it("should allow owner to set bribe split", async function () {
                await expect(voter.setBribeSplit(2000))
                    .to.emit(voter, "Voter__BribeSplitSet")
                    .withArgs(2000);
                expect(await voter.bribeSplit()).to.equal(2000);
            });

            it("should allow setting to max value", async function () {
                await voter.setBribeSplit(5000);
                expect(await voter.bribeSplit()).to.equal(5000);
            });

            it("should allow setting to zero", async function () {
                await voter.setBribeSplit(2000);
                await voter.setBribeSplit(0);
                expect(await voter.bribeSplit()).to.equal(0);
            });

            it("should revert when exceeding max", async function () {
                await expect(voter.setBribeSplit(5001)).to.be.reverted;
            });

            it("should revert when non-owner calls", async function () {
                await expect(voter.connect(user1).setBribeSplit(1000))
                    .to.be.revertedWith("Ownable: caller is not the owner");
            });
        });

        describe("addStrategy", function () {
            it("should create strategy with correct parameters", async function () {
                const { strategy, bribe, bribeRouter } = await createStrategy();

                expect(await voter.strategy_IsValid(strategy)).to.be.true;
                expect(await voter.strategy_IsAlive(strategy)).to.be.true;
                expect(await voter.strategy_Bribe(strategy)).to.equal(bribe);
                expect(await voter.strategy_BribeRouter(strategy)).to.equal(bribeRouter);
                expect(await voter.strategy_PaymentToken(strategy)).to.equal(paymentToken.address);
            });

            it("should add strategy to array", async function () {
                const { strategy } = await createStrategy();
                expect(await voter.length()).to.equal(1);
                expect(await voter.strategies(0)).to.equal(strategy);
            });

            it("should emit StrategyAdded event", async function () {
                const initPrice = ethers.utils.parseUnits("100", 6);
                await expect(voter.addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice))
                    .to.emit(voter, "Voter__StrategyAdded");
            });

            it("should revert when non-owner calls", async function () {
                const initPrice = ethers.utils.parseUnits("100", 6);
                await expect(voter.connect(user1).addStrategy(paymentToken.address, treasury.address, initPrice, HOUR, ethers.utils.parseEther("2"), initPrice))
                    .to.be.revertedWith("Ownable: caller is not the owner");
            });

            it("should allow multiple strategies", async function () {
                await createStrategy(paymentToken);
                await createStrategy(paymentToken2);

                expect(await voter.length()).to.equal(2);
            });

            it("should initialize strategy supply index to current index", async function () {
                // First add a strategy and vote to increase index
                const { strategy: s1 } = await createStrategy();
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([s1], [100]);

                // Send revenue to increase index
                await sendRevenue(ethers.utils.parseEther("100"));

                // Now add new strategy - it should start at current index
                const { strategy: s2 } = await createStrategy(paymentToken2);

                // Update and check claimable - should be 0 for new strategy
                await voter.updateStrategy(s2);
                expect(await voter.strategy_Claimable(s2)).to.equal(0);
            });
        });

        describe("killStrategy", function () {
            it("should mark strategy as not alive", async function () {
                const { strategy } = await createStrategy();
                await voter.killStrategy(strategy);

                expect(await voter.strategy_IsAlive(strategy)).to.be.false;
                expect(await voter.strategy_IsValid(strategy)).to.be.true; // still valid
            });

            it("should emit StrategyKilled event", async function () {
                const { strategy } = await createStrategy();
                await expect(voter.killStrategy(strategy))
                    .to.emit(voter, "Voter__StrategyKilled")
                    .withArgs(strategy);
            });

            it("should clear claimable amount", async function () {
                const { strategy } = await createStrategy();
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy], [100]);

                await sendRevenue(ethers.utils.parseEther("100"));
                await voter.updateStrategy(strategy);

                expect(await voter.strategy_Claimable(strategy)).to.be.gt(0);

                await voter.killStrategy(strategy);
                expect(await voter.strategy_Claimable(strategy)).to.equal(0);
            });

            it("should revert when killing already dead strategy", async function () {
                const { strategy } = await createStrategy();
                await voter.killStrategy(strategy);

                await expect(voter.killStrategy(strategy)).to.be.reverted;
            });

            it("should revert when non-owner calls", async function () {
                const { strategy } = await createStrategy();
                await expect(voter.connect(user1).killStrategy(strategy))
                    .to.be.revertedWith("Ownable: caller is not the owner");
            });
        });

        describe("addBribeReward", function () {
            it("should add reward token to bribe", async function () {
                const { bribe } = await createStrategy();
                await expect(voter.addBribeReward(bribe, revenueToken.address))
                    .to.emit(voter, "Voter__BribeRewardAdded")
                    .withArgs(bribe, revenueToken.address);
            });

            it("should revert with zero address", async function () {
                const { bribe } = await createStrategy();
                await expect(voter.addBribeReward(bribe, ethers.constants.AddressZero))
                    .to.be.reverted;
            });

            it("should revert when non-owner calls", async function () {
                const { bribe } = await createStrategy();
                await expect(voter.connect(user1).addBribeReward(bribe, revenueToken.address))
                    .to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });

    // ==================== VOTING ====================

    describe("Voting", function () {
        let strategy1, strategy2, bribe1, bribe2;

        beforeEach(async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);
            strategy1 = s1.strategy;
            strategy2 = s2.strategy;
            bribe1 = s1.bribe;
            bribe2 = s2.bribe;

            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));
        });

        describe("vote", function () {
            it("should record vote with full weight", async function () {
                await voter.connect(user1).vote([strategy1], [100]);

                expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));
                expect(await voter.strategy_Weight(strategy1)).to.equal(ethers.utils.parseEther("100"));
                expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));
            });

            it("should emit Voted event", async function () {
                await expect(voter.connect(user1).vote([strategy1], [100]))
                    .to.emit(voter, "Voter__Voted")
                    .withArgs(user1.address, strategy1, ethers.utils.parseEther("100"));
            });

            it("should normalize weights correctly", async function () {
                // Vote 60/40 split
                await voter.connect(user1).vote([strategy1, strategy2], [60, 40]);

                const weight1 = await voter.account_Strategy_Votes(user1.address, strategy1);
                const weight2 = await voter.account_Strategy_Votes(user1.address, strategy2);

                // 60% of 100 = 60, 40% of 100 = 40
                expect(weight1).to.equal(ethers.utils.parseEther("60"));
                expect(weight2).to.equal(ethers.utils.parseEther("40"));
            });

            it("should handle unequal weight ratios", async function () {
                // Vote 70/30 split
                await voter.connect(user2).vote([strategy1, strategy2], [7, 3]);

                const weight1 = await voter.account_Strategy_Votes(user2.address, strategy1);
                const weight2 = await voter.account_Strategy_Votes(user2.address, strategy2);

                // 70% of 200 = 140, 30% of 200 = 60
                expect(weight1).to.equal(ethers.utils.parseEther("140"));
                expect(weight2).to.equal(ethers.utils.parseEther("60"));
            });

            it("should track strategy votes array", async function () {
                await voter.connect(user1).vote([strategy1, strategy2], [50, 50]);

                const votes = await voter.getStrategyVote(user1.address);
                expect(votes.length).to.equal(2);
                expect(votes[0]).to.equal(strategy1);
                expect(votes[1]).to.equal(strategy2);
            });

            it("should update lastVoted timestamp", async function () {
                const block = await ethers.provider.getBlock("latest");
                await voter.connect(user1).vote([strategy1], [100]);

                const lastVoted = await voter.account_LastVoted(user1.address);
                expect(lastVoted).to.be.gte(block.timestamp);
            });

            it("should deposit to bribe contract", async function () {
                await voter.connect(user1).vote([strategy1], [100]);

                const bribeContract = await ethers.getContractAt("Bribe", bribe1);
                expect(await bribeContract.account_Balance(user1.address)).to.equal(ethers.utils.parseEther("100"));
            });

            it("should revert with mismatched array lengths", async function () {
                await expect(voter.connect(user1).vote([strategy1, strategy2], [100]))
                    .to.be.reverted;
            });

            it("should revert when voting twice in same epoch", async function () {
                await voter.connect(user1).vote([strategy1], [100]);
                await expect(voter.connect(user1).vote([strategy1], [100]))
                    .to.be.reverted;
            });

            it("should allow voting in new epoch", async function () {
                await voter.connect(user1).vote([strategy1], [100]);

                await advanceToNextEpoch();

                await voter.connect(user1).vote([strategy2], [100]);
                expect(await voter.account_Strategy_Votes(user1.address, strategy2)).to.equal(ethers.utils.parseEther("100"));
            });

            it("should skip invalid strategies", async function () {
                const fakeStrategy = user4.address;
                await voter.connect(user1).vote([strategy1, fakeStrategy], [50, 50]);

                // Only strategy1 should have votes, weight normalized to 100%
                expect(await voter.account_Strategy_Votes(user1.address, strategy1)).to.equal(ethers.utils.parseEther("100"));
                expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));
            });

            it("should skip dead strategies", async function () {
                await voter.killStrategy(strategy2);

                await voter.connect(user1).vote([strategy1, strategy2], [50, 50]);

                // Only strategy1 should have votes
                expect(await voter.account_Strategy_Votes(user1.address, strategy1)).to.equal(ethers.utils.parseEther("100"));
                expect(await voter.account_Strategy_Votes(user1.address, strategy2)).to.equal(0);
            });

            it("should handle multiple users voting", async function () {
                await voter.connect(user1).vote([strategy1], [100]);
                await voter.connect(user2).vote([strategy1, strategy2], [50, 50]);
                await voter.connect(user3).vote([strategy2], [100]);

                // strategy1: 100 + 100 = 200
                // strategy2: 100 + 300 = 400
                expect(await voter.strategy_Weight(strategy1)).to.equal(ethers.utils.parseEther("200"));
                expect(await voter.strategy_Weight(strategy2)).to.equal(ethers.utils.parseEther("400"));
                expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("600"));
            });

            it("should revert when voting for same strategy twice in one call", async function () {
                await expect(voter.connect(user1).vote([strategy1, strategy1], [50, 50]))
                    .to.be.reverted;
            });

            it("should revert with zero weight after normalization", async function () {
                // If user has very small balance, normalized weight could be 0
                await underlying.mint(user4.address, 1); // 1 wei
                await stakeTokens(user4, 1);

                // This should revert because weight becomes 0
                await expect(voter.connect(user4).vote([strategy1, strategy2], [1, 1]))
                    .to.be.reverted;
            });
        });

        describe("reset", function () {
            beforeEach(async function () {
                await voter.connect(user1).vote([strategy1, strategy2], [60, 40]);
            });

            it("should clear all votes", async function () {
                await advanceToNextEpoch();
                await voter.connect(user1).reset();

                expect(await voter.account_Strategy_Votes(user1.address, strategy1)).to.equal(0);
                expect(await voter.account_Strategy_Votes(user1.address, strategy2)).to.equal(0);
                expect(await voter.account_UsedWeights(user1.address)).to.equal(0);
            });

            it("should reduce strategy weights", async function () {
                await advanceToNextEpoch();
                await voter.connect(user1).reset();

                expect(await voter.strategy_Weight(strategy1)).to.equal(0);
                expect(await voter.strategy_Weight(strategy2)).to.equal(0);
            });

            it("should reduce total weight", async function () {
                await advanceToNextEpoch();
                await voter.connect(user1).reset();

                expect(await voter.totalWeight()).to.equal(0);
            });

            it("should emit Abstained events", async function () {
                await advanceToNextEpoch();

                await expect(voter.connect(user1).reset())
                    .to.emit(voter, "Voter__Abstained");
            });

            it("should withdraw from bribe contracts", async function () {
                const bribeContract1 = await ethers.getContractAt("Bribe", bribe1);
                const bribeContract2 = await ethers.getContractAt("Bribe", bribe2);

                expect(await bribeContract1.account_Balance(user1.address)).to.be.gt(0);
                expect(await bribeContract2.account_Balance(user1.address)).to.be.gt(0);

                await advanceToNextEpoch();
                await voter.connect(user1).reset();

                expect(await bribeContract1.account_Balance(user1.address)).to.equal(0);
                expect(await bribeContract2.account_Balance(user1.address)).to.equal(0);
            });

            it("should clear strategy vote array", async function () {
                await advanceToNextEpoch();
                await voter.connect(user1).reset();

                const votes = await voter.getStrategyVote(user1.address);
                expect(votes.length).to.equal(0);
            });

            it("should revert when reset twice in same epoch", async function () {
                await advanceToNextEpoch();
                await voter.connect(user1).reset();

                await expect(voter.connect(user1).reset()).to.be.reverted;
            });

            it("should update lastVoted timestamp", async function () {
                await advanceToNextEpoch();
                const block = await ethers.provider.getBlock("latest");
                await voter.connect(user1).reset();

                const lastVoted = await voter.account_LastVoted(user1.address);
                expect(lastVoted).to.be.gte(block.timestamp);
            });
        });

        describe("vote resets previous votes", function () {
            it("should reset previous votes when voting again", async function () {
                await voter.connect(user1).vote([strategy1], [100]);
                expect(await voter.strategy_Weight(strategy1)).to.equal(ethers.utils.parseEther("100"));

                await advanceToNextEpoch();

                await voter.connect(user1).vote([strategy2], [100]);

                expect(await voter.strategy_Weight(strategy1)).to.equal(0);
                expect(await voter.strategy_Weight(strategy2)).to.equal(ethers.utils.parseEther("100"));
                expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));
            });

            it("should update bribe balances when changing vote", async function () {
                await voter.connect(user1).vote([strategy1], [100]);

                const bribeContract1 = await ethers.getContractAt("Bribe", bribe1);
                const bribeContract2 = await ethers.getContractAt("Bribe", bribe2);

                expect(await bribeContract1.account_Balance(user1.address)).to.equal(ethers.utils.parseEther("100"));
                expect(await bribeContract2.account_Balance(user1.address)).to.equal(0);

                await advanceToNextEpoch();

                await voter.connect(user1).vote([strategy2], [100]);

                expect(await bribeContract1.account_Balance(user1.address)).to.equal(0);
                expect(await bribeContract2.account_Balance(user1.address)).to.equal(ethers.utils.parseEther("100"));
            });
        });
    });

    // ==================== REVENUE DISTRIBUTION ====================

    describe("Revenue Distribution", function () {
        let strategy1, strategy2;

        beforeEach(async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);
            strategy1 = s1.strategy;
            strategy2 = s2.strategy;
        });

        describe("notifyAndDistribute", function () {
            it("should send revenue to treasury when no votes", async function () {
                const treasuryBalanceBefore = await revenueToken.balanceOf(treasury.address);
                await sendRevenue(ethers.utils.parseEther("100"));
                const treasuryBalanceAfter = await revenueToken.balanceOf(treasury.address);

                expect(treasuryBalanceAfter.sub(treasuryBalanceBefore)).to.equal(ethers.utils.parseEther("100"));
            });

            it("should update index when votes exist", async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1], [100]);

                await sendRevenue(ethers.utils.parseEther("100"));

                // index should be revenue / totalWeight * 1e18
                // 100e18 * 1e18 / 100e18 = 1e18
                await voter.updateStrategy(strategy1);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("100"));
            });

            it("should emit NotifyRevenue event", async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1], [100]);

                await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("100"));
                await expect(revenueRouter.flush())
                    .to.emit(voter, "Voter__NotifyRevenue");
            });

            it("should revert when called by non-revenue source", async function () {
                await expect(voter.connect(user1).notifyAndDistribute(ethers.utils.parseEther("100")))
                    .to.be.reverted;
            });

            it("should distribute proportionally to vote weights", async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await stakeTokens(user2, ethers.utils.parseEther("300"));

                await voter.connect(user1).vote([strategy1], [100]);
                await voter.connect(user2).vote([strategy2], [100]);

                // total weight: 400, strategy1: 100 (25%), strategy2: 300 (75%)
                await sendRevenue(ethers.utils.parseEther("400"));

                await voter.updateAll();

                const claimable1 = await voter.strategy_Claimable(strategy1);
                const claimable2 = await voter.strategy_Claimable(strategy2);

                expect(claimable1).to.equal(ethers.utils.parseEther("100"));
                expect(claimable2).to.equal(ethers.utils.parseEther("300"));
            });

            it("should handle multiple revenue distributions", async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1], [100]);

                await sendRevenue(ethers.utils.parseEther("50"));
                await sendRevenue(ethers.utils.parseEther("50"));

                await voter.updateStrategy(strategy1);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("100"));
            });

            it("should not accumulate claimable for dead strategy", async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1], [100]);

                await sendRevenue(ethers.utils.parseEther("50"));
                await voter.updateStrategy(strategy1);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("50"));

                await voter.killStrategy(strategy1);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(0);

                // Send more revenue - dead strategy shouldn't accumulate
                await sendRevenue(ethers.utils.parseEther("50"));
                await voter.updateStrategy(strategy1);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(0);
            });
        });

        describe("distribute", function () {
            beforeEach(async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1], [100]);
                await sendRevenue(ethers.utils.parseEther("100"));
            });

            it("should transfer claimable to strategy", async function () {
                const balanceBefore = await revenueToken.balanceOf(strategy1);
                await voter["distribute(address)"](strategy1);
                const balanceAfter = await revenueToken.balanceOf(strategy1);

                expect(balanceAfter.sub(balanceBefore)).to.equal(ethers.utils.parseEther("100"));
            });

            it("should emit DistributeRevenue event", async function () {
                await expect(voter["distribute(address)"](strategy1))
                    .to.emit(voter, "Voter__DistributeRevenue")
                    .withArgs(owner.address, strategy1, ethers.utils.parseEther("100"));
            });

            it("should clear claimable after distribution", async function () {
                await voter["distribute(address)"](strategy1);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(0);
            });

            it("should not transfer if claimable is zero", async function () {
                await voter["distribute(address)"](strategy1);

                const balanceBefore = await revenueToken.balanceOf(strategy1);
                await voter["distribute(address)"](strategy1);
                const balanceAfter = await revenueToken.balanceOf(strategy1);

                expect(balanceAfter).to.equal(balanceBefore);
            });

            it("should allow anyone to call distribute", async function () {
                await voter.connect(user2)["distribute(address)"](strategy1);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(0);
            });
        });

        describe("distribute (range)", function () {
            beforeEach(async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1, strategy2], [50, 50]);
                await sendRevenue(ethers.utils.parseEther("100"));
            });

            it("should distribute to range of strategies", async function () {
                await voter["distribute(uint256,uint256)"](0, 2);

                expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("50"));
                expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("50"));
            });

            it("should distribute to partial range", async function () {
                await voter["distribute(uint256,uint256)"](0, 1);

                expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("50"));
                expect(await revenueToken.balanceOf(strategy2)).to.equal(0);
            });
        });

        describe("distro", function () {
            beforeEach(async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1, strategy2], [50, 50]);
                await sendRevenue(ethers.utils.parseEther("100"));
            });

            it("should distribute to all strategies", async function () {
                await voter.distro();

                expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("50"));
                expect(await revenueToken.balanceOf(strategy2)).to.equal(ethers.utils.parseEther("50"));
            });
        });

        describe("update functions", function () {
            beforeEach(async function () {
                await stakeTokens(user1, ethers.utils.parseEther("100"));
                await voter.connect(user1).vote([strategy1, strategy2], [50, 50]);
                await sendRevenue(ethers.utils.parseEther("100"));
            });

            it("updateStrategy should update single strategy", async function () {
                await voter.updateStrategy(strategy1);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("50"));
                expect(await voter.strategy_Claimable(strategy2)).to.equal(0);
            });

            it("updateFor should update multiple strategies", async function () {
                await voter.updateFor([strategy1, strategy2]);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("50"));
                expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("50"));
            });

            it("updateForRange should update range", async function () {
                await voter.updateForRange(0, 2);
                expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("50"));
                expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("50"));
            });

            it("updateAll should update all strategies", async function () {
                await voter.updateAll();
                expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("50"));
                expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("50"));
            });
        });
    });

    // ==================== EPOCH BOUNDARY TESTS ====================

    describe("Epoch Boundaries", function () {
        let strategy1;

        beforeEach(async function () {
            const s1 = await createStrategy();
            strategy1 = s1.strategy;
            await stakeTokens(user1, ethers.utils.parseEther("100"));
        });

        it("should allow voting at start of new epoch", async function () {
            await voter.connect(user1).vote([strategy1], [100]);

            // Advance to exactly the start of next epoch
            const currentBlock = await ethers.provider.getBlock("latest");
            const currentEpochStart = Math.floor(currentBlock.timestamp / WEEK) * WEEK;
            const nextEpochStart = currentEpochStart + WEEK;
            const timeToAdvance = nextEpochStart - currentBlock.timestamp + 1;

            await ethers.provider.send("evm_increaseTime", [timeToAdvance]);
            await ethers.provider.send("evm_mine");

            await voter.connect(user1).vote([strategy1], [100]);
            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should block voting within same epoch even near boundary", async function () {
            await voter.connect(user1).vote([strategy1], [100]);

            // Advance to 1 second before next epoch
            const currentBlock = await ethers.provider.getBlock("latest");
            const currentEpochStart = Math.floor(currentBlock.timestamp / WEEK) * WEEK;
            const nextEpochStart = currentEpochStart + WEEK;
            const timeToAdvance = nextEpochStart - currentBlock.timestamp - 2;

            await ethers.provider.send("evm_increaseTime", [timeToAdvance]);
            await ethers.provider.send("evm_mine");

            await expect(voter.connect(user1).vote([strategy1], [100])).to.be.reverted;
        });
    });

    // ==================== COMPLEX SCENARIOS ====================

    describe("Complex Scenarios", function () {
        let strategy1, strategy2, strategy3;

        beforeEach(async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);
            const s3 = await createStrategy(paymentToken);
            strategy1 = s1.strategy;
            strategy2 = s2.strategy;
            strategy3 = s3.strategy;
        });

        it("should handle users changing votes across multiple epochs", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));

            // Epoch 1: user1 votes strategy1, user2 votes strategy2
            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy2], [100]);

            await sendRevenue(ethers.utils.parseEther("300"));
            await voter.updateAll();

            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("200"));

            // Distribute and move to next epoch
            await voter.distro();
            await advanceToNextEpoch();

            // Epoch 2: user1 switches to strategy2, user2 splits
            await voter.connect(user1).vote([strategy2], [100]);
            await voter.connect(user2).vote([strategy1, strategy2], [50, 50]);

            // strategy1: 100, strategy2: 100 + 100 = 200
            expect(await voter.strategy_Weight(strategy1)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Weight(strategy2)).to.equal(ethers.utils.parseEther("200"));

            await sendRevenue(ethers.utils.parseEther("300"));
            await voter.updateAll();

            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("200"));
        });

        it("should handle user staking more tokens mid-vote", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            // User stakes more - but current epoch votes are locked
            await stakeTokens(user1, ethers.utils.parseEther("100"));

            // Vote weight should still be original amount
            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));

            // Next epoch, new vote will use full balance
            await advanceToNextEpoch();
            await voter.connect(user1).vote([strategy1], [100]);

            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("200"));
        });

        it("should handle killing strategy with active votes", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1, strategy2], [50, 50]);

            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));

            // Kill strategy1 - weight preserved so users can reset without underflow
            await voter.killStrategy(strategy1);

            // Weights unchanged (user still has votes pointing to strategy1)
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("100"));
            expect(await voter.strategy_Weight(strategy1)).to.equal(ethers.utils.parseEther("50"));
            expect(await voter.strategy_Weight(strategy2)).to.equal(ethers.utils.parseEther("50"));
            expect(await voter.account_UsedWeights(user1.address)).to.equal(ethers.utils.parseEther("100"));

            // Revenue: strategy2 gets 50%, strategy1's 50% is discarded (dead strategy)
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter.updateAll();

            expect(await voter.strategy_Claimable(strategy1)).to.equal(0);
            expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("50"));
        });

        it("should handle user resetting then voting for different strategies", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            await advanceToNextEpoch();
            await voter.connect(user1).reset();

            // Vote for different strategy
            await advanceToNextEpoch();
            await voter.connect(user1).vote([strategy2, strategy3], [70, 30]);

            expect(await voter.strategy_Weight(strategy1)).to.equal(0);
            expect(await voter.strategy_Weight(strategy2)).to.equal(ethers.utils.parseEther("70"));
            expect(await voter.strategy_Weight(strategy3)).to.equal(ethers.utils.parseEther("30"));
        });

        it("should maintain correct state with many users and strategies", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await stakeTokens(user2, ethers.utils.parseEther("200"));
            await stakeTokens(user3, ethers.utils.parseEther("300"));
            await stakeTokens(user4, ethers.utils.parseEther("400"));

            await voter.connect(user1).vote([strategy1], [100]);
            await voter.connect(user2).vote([strategy1, strategy2], [50, 50]);
            await voter.connect(user3).vote([strategy2, strategy3], [60, 40]);
            await voter.connect(user4).vote([strategy3], [100]);

            // strategy1: 100 + 100 = 200
            // strategy2: 100 + 180 = 280
            // strategy3: 120 + 400 = 520
            expect(await voter.strategy_Weight(strategy1)).to.equal(ethers.utils.parseEther("200"));
            expect(await voter.strategy_Weight(strategy2)).to.equal(ethers.utils.parseEther("280"));
            expect(await voter.strategy_Weight(strategy3)).to.equal(ethers.utils.parseEther("520"));
            expect(await voter.totalWeight()).to.equal(ethers.utils.parseEther("1000"));

            // Distribute 1000 revenue proportionally
            await sendRevenue(ethers.utils.parseEther("1000"));
            await voter.updateAll();

            expect(await voter.strategy_Claimable(strategy1)).to.equal(ethers.utils.parseEther("200"));
            expect(await voter.strategy_Claimable(strategy2)).to.equal(ethers.utils.parseEther("280"));
            expect(await voter.strategy_Claimable(strategy3)).to.equal(ethers.utils.parseEther("520"));
        });
    });

    // ==================== EDGE CASES ====================

    describe("Edge Cases", function () {
        let strategy1;

        beforeEach(async function () {
            const s1 = await createStrategy();
            strategy1 = s1.strategy;
        });

        it("should handle voting with zero strategies array", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            // Empty vote should work but result in no weight
            await voter.connect(user1).vote([], []);

            expect(await voter.account_UsedWeights(user1.address)).to.equal(0);
            expect(await voter.totalWeight()).to.equal(0);
        });

        it("should handle very large revenue amounts", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);

            // Large but realistic revenue
            const largeAmount = ethers.utils.parseEther("1000000000"); // 1 billion
            await revenueToken.mint(owner.address, largeAmount);
            await sendRevenue(largeAmount);

            await voter.updateStrategy(strategy1);
            expect(await voter.strategy_Claimable(strategy1)).to.equal(largeAmount);
        });

        it("should handle very small vote weights", async function () {
            await underlying.mint(user1.address, 1000);
            await stakeTokens(user1, 1000);

            await voter.connect(user1).vote([strategy1], [100]);
            expect(await voter.account_UsedWeights(user1.address)).to.equal(1000);
        });

        it("should handle distribute when voter has no revenue tokens", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);
            await sendRevenue(ethers.utils.parseEther("100"));

            // This should work - revenue router transferred tokens
            await voter["distribute(address)"](strategy1);
            expect(await revenueToken.balanceOf(strategy1)).to.equal(ethers.utils.parseEther("100"));
        });

        it("should revert when user with no governance tokens tries to vote", async function () {
            // User has no staked tokens - should revert
            await expect(voter.connect(user4).vote([strategy1], [100]))
                .to.be.reverted;
        });
    });

    // ==================== VIEW FUNCTIONS ====================

    describe("View Functions", function () {
        let strategy1, strategy2;

        beforeEach(async function () {
            const s1 = await createStrategy(paymentToken);
            const s2 = await createStrategy(paymentToken2);
            strategy1 = s1.strategy;
            strategy2 = s2.strategy;
        });

        it("getStrategies should return all strategies", async function () {
            const strategies = await voter.getStrategies();
            expect(strategies.length).to.equal(2);
            expect(strategies[0]).to.equal(strategy1);
            expect(strategies[1]).to.equal(strategy2);
        });

        it("length should return correct count", async function () {
            expect(await voter.length()).to.equal(2);
        });

        it("getStrategyVote should return user's votes", async function () {
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1, strategy2], [50, 50]);

            const votes = await voter.getStrategyVote(user1.address);
            expect(votes.length).to.equal(2);
            expect(votes[0]).to.equal(strategy1);
            expect(votes[1]).to.equal(strategy2);
        });

        it("getStrategyVote should return empty for non-voter", async function () {
            const votes = await voter.getStrategyVote(user1.address);
            expect(votes.length).to.equal(0);
        });

        it("strategies mapping should be accessible by index", async function () {
            expect(await voter.strategies(0)).to.equal(strategy1);
            expect(await voter.strategies(1)).to.equal(strategy2);
        });
    });

    // ==================== CLAIM BRIBES ====================

    describe("claimBribes", function () {
        let strategy1, bribe1;

        beforeEach(async function () {
            const s1 = await createStrategy();
            strategy1 = s1.strategy;
            bribe1 = s1.bribe;

            await voter.setBribeSplit(2000); // 20%
            await stakeTokens(user1, ethers.utils.parseEther("100"));
            await voter.connect(user1).vote([strategy1], [100]);
        });

        it("should claim from multiple bribes", async function () {
            // Setup: need to generate bribe rewards through auction sale
            await sendRevenue(ethers.utils.parseEther("100"));
            await voter["distribute(address)"](strategy1);

            // Execute auction buy
            const strategyContract = await ethers.getContractAt("Strategy", strategy1);
            const epochId = await strategyContract.epochId();
            const price = await strategyContract.getPrice();

            await paymentToken.connect(user2).approve(strategyContract.address, price);
            const block = await ethers.provider.getBlock("latest");
            const deadline = block.timestamp + 3600;
            await strategyContract.connect(user2).buy(user2.address, epochId, deadline, price);

            // Distribute bribes
            const bribeRouterAddr = await voter.strategy_BribeRouter(strategy1);
            const bribeRouter = await ethers.getContractAt("BribeRouter", bribeRouterAddr);
            await bribeRouter.distribute();

            // Wait for rewards
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            const balanceBefore = await paymentToken.balanceOf(user1.address);
            await voter.connect(user1).claimBribes([bribe1]);
            const balanceAfter = await paymentToken.balanceOf(user1.address);

            expect(balanceAfter).to.be.gt(balanceBefore);
        });
    });
});
