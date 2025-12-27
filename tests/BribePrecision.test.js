const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Test to analyze the bribe precision issue with low-decimal tokens like cbBTC (8 decimals)
 *
 * EXACT production values:
 * - cbBTC has 8 decimals
 * - notifyRewardAmount called with 0.00818777 cbBTC (818777 units)
 * - totalSupply in bribe: 26996052118890858560217955 wei (269960.52 gDONUT)
 * - User balance: 105000000000000000000000 wei (105000 gDONUT)
 * - User sees earned() = 0
 */
describe("Bribe Precision Analysis", function () {
    let owner, voter, user1, user2;
    let bribe, rewardToken;

    const WEEK = 7 * 24 * 60 * 60;
    const DAY = 24 * 60 * 60;
    const HOUR = 60 * 60;

    beforeEach(async function () {
        [owner, voter, user1, user2] = await ethers.getSigners();

        // Deploy 8-decimal token (like cbBTC)
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        rewardToken = await MockERC20.deploy("Coinbase BTC", "cbBTC", 8);

        // Deploy Bribe contract with voter as the authorized caller
        const Bribe = await ethers.getContractFactory("Bribe");
        bribe = await Bribe.deploy(voter.address);

        // Add reward token
        await bribe.connect(voter).addReward(rewardToken.address);

        // Mint reward tokens to owner for testing
        await rewardToken.mint(owner.address, ethers.utils.parseUnits("100", 8));
    });

    describe("Scenario 1: User votes BEFORE notifyRewardAmount", function () {
        it("should track rewards correctly when user votes first", async function () {
            // User1 votes first (deposits virtual balance)
            // Simulating ~270,000 gDONUT voting
            const user1Balance = ethers.utils.parseEther("105000"); // 105,000 gDONUT
            const user2Balance = ethers.utils.parseEther("165000"); // 165,000 gDONUT (total ~270k)

            await bribe.connect(voter)._deposit(user1Balance, user1.address);
            await bribe.connect(voter)._deposit(user2Balance, user2.address);

            const totalSupply = await bribe.totalSupply();
            console.log("\n=== Initial State ===");
            console.log("totalSupply:", ethers.utils.formatEther(totalSupply), "gDONUT");
            console.log("user1 balance:", ethers.utils.formatEther(user1Balance), "gDONUT");

            // Now notify reward amount (0.00818777 cbBTC = 818777 units)
            const rewardAmount = 818777; // 8 decimals
            await rewardToken.approve(bribe.address, rewardAmount);
            await bribe.notifyRewardAmount(rewardToken.address, rewardAmount);

            const rewardData = await bribe.token_RewardData(rewardToken.address);
            console.log("\n=== After notifyRewardAmount ===");
            console.log("reward amount:", rewardAmount, "units (", rewardAmount / 1e8, "cbBTC)");
            console.log("rewardRate:", rewardData.rewardRate.toString(), "units/second");
            console.log("Expected rewardRate:", Math.floor(rewardAmount / WEEK));

            // Check earned immediately
            let earned1 = await bribe.earned(user1.address, rewardToken.address);
            console.log("\n=== Immediately after notify ===");
            console.log("user1 earned:", earned1.toString(), "units");

            // Advance 1 hour
            await ethers.provider.send("evm_increaseTime", [HOUR]);
            await ethers.provider.send("evm_mine");

            earned1 = await bribe.earned(user1.address, rewardToken.address);
            const rewardPerToken1h = await bribe.rewardPerToken(rewardToken.address);
            console.log("\n=== After 1 hour ===");
            console.log("rewardPerToken:", rewardPerToken1h.toString());
            console.log("user1 earned:", earned1.toString(), "units (", earned1.toNumber() / 1e8, "cbBTC)");

            // Advance 1 day
            await ethers.provider.send("evm_increaseTime", [DAY - HOUR]);
            await ethers.provider.send("evm_mine");

            earned1 = await bribe.earned(user1.address, rewardToken.address);
            const rewardPerToken1d = await bribe.rewardPerToken(rewardToken.address);
            console.log("\n=== After 1 day ===");
            console.log("rewardPerToken:", rewardPerToken1d.toString());
            console.log("user1 earned:", earned1.toString(), "units (", earned1.toNumber() / 1e8, "cbBTC)");

            // Advance to end of period (7 days total)
            await ethers.provider.send("evm_increaseTime", [6 * DAY]);
            await ethers.provider.send("evm_mine");

            earned1 = await bribe.earned(user1.address, rewardToken.address);
            const earned2 = await bribe.earned(user2.address, rewardToken.address);
            const rewardPerToken7d = await bribe.rewardPerToken(rewardToken.address);
            console.log("\n=== After 7 days (full period) ===");
            console.log("rewardPerToken:", rewardPerToken7d.toString());
            console.log("user1 earned:", earned1.toString(), "units (", earned1.toNumber() / 1e8, "cbBTC)");
            console.log("user2 earned:", earned2.toString(), "units (", earned2.toNumber() / 1e8, "cbBTC)");
            console.log("total earned:", (earned1.toNumber() + earned2.toNumber()), "units");
            console.log("total distributed:", rewardData.rewardRate.toNumber() * WEEK, "units");
            console.log("original reward:", rewardAmount, "units");
            console.log("lost to rewardRate truncation:", rewardAmount - (rewardData.rewardRate.toNumber() * WEEK), "units");
        });
    });

    describe("Scenario 2: User votes AFTER notifyRewardAmount", function () {
        it("should track rewards when user votes after notify", async function () {
            // First, some other user has votes
            const otherUserBalance = ethers.utils.parseEther("165000");
            await bribe.connect(voter)._deposit(otherUserBalance, user2.address);

            console.log("\n=== Initial State (only user2 voted) ===");
            console.log("totalSupply:", ethers.utils.formatEther(await bribe.totalSupply()), "gDONUT");

            // Notify reward amount
            const rewardAmount = 818777;
            await rewardToken.approve(bribe.address, rewardAmount);
            await bribe.notifyRewardAmount(rewardToken.address, rewardAmount);

            const rewardData = await bribe.token_RewardData(rewardToken.address);
            console.log("\n=== After notifyRewardAmount ===");
            console.log("rewardRate:", rewardData.rewardRate.toString());

            // Advance 1 day
            await ethers.provider.send("evm_increaseTime", [DAY]);
            await ethers.provider.send("evm_mine");

            // NOW user1 votes (after 1 day of rewards have accrued)
            const user1Balance = ethers.utils.parseEther("105000");
            await bribe.connect(voter)._deposit(user1Balance, user1.address);

            const rewardPerTokenWhenVoted = await bribe.rewardPerToken(rewardToken.address);
            const user1Paid = await bribe.account_Token_RewardPerTokenPaid(user1.address, rewardToken.address);
            console.log("\n=== User1 votes after 1 day ===");
            console.log("rewardPerToken when voted:", rewardPerTokenWhenVoted.toString());
            console.log("user1 rewardPerTokenPaid:", user1Paid.toString());

            let earned1 = await bribe.earned(user1.address, rewardToken.address);
            console.log("user1 earned immediately after voting:", earned1.toString());

            // Advance another day
            await ethers.provider.send("evm_increaseTime", [DAY]);
            await ethers.provider.send("evm_mine");

            earned1 = await bribe.earned(user1.address, rewardToken.address);
            const earned2 = await bribe.earned(user2.address, rewardToken.address);
            console.log("\n=== After another day (2 days total) ===");
            console.log("rewardPerToken:", (await bribe.rewardPerToken(rewardToken.address)).toString());
            console.log("user1 earned:", earned1.toString(), "units");
            console.log("user2 earned:", earned2.toString(), "units");

            // Advance to end
            await ethers.provider.send("evm_increaseTime", [5 * DAY]);
            await ethers.provider.send("evm_mine");

            earned1 = await bribe.earned(user1.address, rewardToken.address);
            const earned2Final = await bribe.earned(user2.address, rewardToken.address);
            console.log("\n=== After 7 days (full period) ===");
            console.log("user1 earned:", earned1.toString(), "units (", earned1.toNumber() / 1e8, "cbBTC)");
            console.log("user2 earned:", earned2Final.toString(), "units (", earned2Final.toNumber() / 1e8, "cbBTC)");
        });
    });

    describe("Scenario 3: Extreme precision loss", function () {
        it("should show what happens with very large totalSupply", async function () {
            // Simulate 27 MILLION gDONUT voting (not 270k)
            const hugeBalance = ethers.utils.parseEther("27000000"); // 27M gDONUT
            await bribe.connect(voter)._deposit(hugeBalance, user1.address);

            console.log("\n=== Extreme case: 27M gDONUT totalSupply ===");
            console.log("totalSupply:", ethers.utils.formatEther(await bribe.totalSupply()), "gDONUT");

            // Notify small reward
            const rewardAmount = 818777;
            await rewardToken.approve(bribe.address, rewardAmount);
            await bribe.notifyRewardAmount(rewardToken.address, rewardAmount);

            const rewardData = await bribe.token_RewardData(rewardToken.address);
            console.log("rewardRate:", rewardData.rewardRate.toString());

            // Calculate expected rewardPerToken after 7 days
            // rewardPerToken = time * rewardRate * 1e18 / totalSupply
            const expectedRPT = BigInt(WEEK) * BigInt(rewardData.rewardRate) * BigInt(1e18) / BigInt(hugeBalance.toString());
            console.log("Expected rewardPerToken after 7 days:", expectedRPT.toString());

            // Advance to end
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            const rewardPerToken = await bribe.rewardPerToken(rewardToken.address);
            const earned = await bribe.earned(user1.address, rewardToken.address);
            console.log("\n=== After 7 days ===");
            console.log("actual rewardPerToken:", rewardPerToken.toString());
            console.log("user1 earned:", earned.toString(), "units");

            if (earned.toNumber() === 0) {
                console.log("\n*** REWARDS ARE STUCK! earned() = 0 ***");
            }
        });
    });

    describe("Scenario 4: Check specific on-chain values", function () {
        it("should replicate exact production scenario", async function () {
            // Exact values from production:
            // - totalSupply: 269960.52 gDONUT (let's use this exact value)
            // - user balance: 105000 gDONUT
            // - reward: 818777 units (0.00818777 cbBTC)

            const totalSupplyWei = ethers.utils.parseEther("269960.52");
            const user1Balance = ethers.utils.parseEther("105000");
            const user2Balance = totalSupplyWei.sub(user1Balance);

            // User1 deposits first
            await bribe.connect(voter)._deposit(user1Balance, user1.address);
            await bribe.connect(voter)._deposit(user2Balance, user2.address);

            console.log("\n=== Production-like scenario ===");
            console.log("totalSupply:", ethers.utils.formatEther(await bribe.totalSupply()), "gDONUT");
            console.log("user1 balance:", ethers.utils.formatEther(await bribe.account_Balance(user1.address)), "gDONUT");

            // Notify reward
            const rewardAmount = 818777;
            await rewardToken.approve(bribe.address, rewardAmount);
            await bribe.notifyRewardAmount(rewardToken.address, rewardAmount);

            const rewardData = await bribe.token_RewardData(rewardToken.address);
            console.log("\nrewardRate:", rewardData.rewardRate.toString(), "(should be 1)");

            // Check at various time intervals
            const checkpoints = [
                { name: "1 second", time: 1 },
                { name: "1 minute", time: 60 },
                { name: "1 hour", time: 3600 },
                { name: "1 day", time: 86400 },
                { name: "7 days", time: 604800 },
            ];

            let lastTime = 0;
            for (const cp of checkpoints) {
                await ethers.provider.send("evm_increaseTime", [cp.time - lastTime]);
                await ethers.provider.send("evm_mine");
                lastTime = cp.time;

                const rpt = await bribe.rewardPerToken(rewardToken.address);
                const earned = await bribe.earned(user1.address, rewardToken.address);
                console.log(`\nAfter ${cp.name}:`);
                console.log(`  rewardPerToken: ${rpt.toString()}`);
                console.log(`  user1 earned: ${earned.toString()} units (${earned.toNumber() / 1e8} cbBTC)`);
            }
        });
    });

    describe("Scenario 5: What if user's rewardPerTokenPaid is non-zero?", function () {
        it("should check if previous claims affect earned()", async function () {
            // Setup with multiple reward cycles
            const user1Balance = ethers.utils.parseEther("105000");
            await bribe.connect(voter)._deposit(user1Balance, user1.address);

            // First reward cycle
            const rewardAmount1 = 818777;
            await rewardToken.approve(bribe.address, rewardAmount1);
            await bribe.notifyRewardAmount(rewardToken.address, rewardAmount1);

            console.log("\n=== First reward cycle ===");

            // Advance some time
            await ethers.provider.send("evm_increaseTime", [3 * DAY]);
            await ethers.provider.send("evm_mine");

            const earned1 = await bribe.earned(user1.address, rewardToken.address);
            const rpt1 = await bribe.rewardPerToken(rewardToken.address);
            console.log("After 3 days:");
            console.log("  rewardPerToken:", rpt1.toString());
            console.log("  earned:", earned1.toString());

            // User claims rewards (this updates their rewardPerTokenPaid)
            // Note: getReward updates the state via updateReward modifier
            await bribe.getReward(user1.address);

            const paidAfterClaim = await bribe.account_Token_RewardPerTokenPaid(user1.address, rewardToken.address);
            const earnedAfterClaim = await bribe.earned(user1.address, rewardToken.address);
            console.log("\nAfter claiming:");
            console.log("  rewardPerTokenPaid:", paidAfterClaim.toString());
            console.log("  earned (should be 0 or very small):", earnedAfterClaim.toString());

            // Advance more time
            await ethers.provider.send("evm_increaseTime", [4 * DAY]);
            await ethers.provider.send("evm_mine");

            const earnedLater = await bribe.earned(user1.address, rewardToken.address);
            console.log("\nAfter 4 more days:");
            console.log("  earned:", earnedLater.toString());

            // Now add a NEW reward (second cycle)
            console.log("\n=== Second reward cycle (new notifyRewardAmount) ===");
            await rewardToken.mint(owner.address, ethers.utils.parseUnits("1", 8));
            await rewardToken.approve(bribe.address, rewardAmount1);
            await bribe.notifyRewardAmount(rewardToken.address, rewardAmount1);

            const rewardData2 = await bribe.token_RewardData(rewardToken.address);
            console.log("New rewardRate:", rewardData2.rewardRate.toString());

            // Check if user can earn from new cycle
            await ethers.provider.send("evm_increaseTime", [DAY]);
            await ethers.provider.send("evm_mine");

            const earnedNewCycle = await bribe.earned(user1.address, rewardToken.address);
            console.log("\nAfter 1 day of new cycle:");
            console.log("  earned:", earnedNewCycle.toString());
        });
    });

    describe("Scenario 6: EXACT production values", function () {
        it("should use exact wei values from on-chain", async function () {
            // EXACT values from production screenshots:
            // totalSupply = 269960.52 gDONUT (from converter: 269960.52118890858560217955 ETH)
            // user balance = 105000 gDONUT
            // reward = 818777 units (0.00818777 cbBTC)

            const EXACT_TOTAL_SUPPLY = ethers.utils.parseEther("269960.52");
            const EXACT_USER_BALANCE = ethers.utils.parseEther("105000");
            const EXACT_REWARD = 818777; // cbBTC units (8 decimals)

            // Calculate remaining supply for other voters
            const totalSupplyBN = EXACT_TOTAL_SUPPLY;
            const userBalanceBN = EXACT_USER_BALANCE;
            const otherVotersBalance = totalSupplyBN.sub(userBalanceBN);

            // Setup: user1 has exact balance, others make up the rest
            await bribe.connect(voter)._deposit(userBalanceBN, user1.address);
            await bribe.connect(voter)._deposit(otherVotersBalance, user2.address);

            console.log("\n========== EXACT PRODUCTION VALUES ==========");
            console.log("totalSupply (wei):", (await bribe.totalSupply()).toString());
            console.log("totalSupply (gDONUT):", ethers.utils.formatEther(await bribe.totalSupply()));
            console.log("user1 balance (wei):", (await bribe.account_Balance(user1.address)).toString());
            console.log("user1 balance (gDONUT):", ethers.utils.formatEther(await bribe.account_Balance(user1.address)));
            console.log("reward amount:", EXACT_REWARD, "units (", EXACT_REWARD / 1e8, "cbBTC)");

            // Notify reward
            await rewardToken.approve(bribe.address, EXACT_REWARD);
            await bribe.notifyRewardAmount(rewardToken.address, EXACT_REWARD);

            const rewardData = await bribe.token_RewardData(rewardToken.address);
            console.log("\nrewardRate:", rewardData.rewardRate.toString());
            console.log("DURATION:", WEEK, "seconds");
            console.log("Total distributable:", rewardData.rewardRate.toNumber() * WEEK, "units");

            // Check at key time points
            console.log("\n--- Time progression ---");

            const timePoints = [
                { days: 1, label: "1 day" },
                { days: 2, label: "2 days" },
                { days: 3, label: "3 days" },
                { days: 4, label: "4 days" },
                { days: 5, label: "5 days" },
                { days: 6, label: "6 days" },
                { days: 7, label: "7 days (end)" },
            ];

            let lastDays = 0;
            for (const tp of timePoints) {
                await ethers.provider.send("evm_increaseTime", [(tp.days - lastDays) * DAY]);
                await ethers.provider.send("evm_mine");
                lastDays = tp.days;

                const rpt = await bribe.rewardPerToken(rewardToken.address);
                const earned = await bribe.earned(user1.address, rewardToken.address);
                console.log(`${tp.label}: rewardPerToken=${rpt.toString()}, earned=${earned.toString()} (${(earned.toNumber() / 1e8).toFixed(8)} cbBTC)`);
            }

            // Final summary
            const finalEarned1 = await bribe.earned(user1.address, rewardToken.address);
            const finalEarned2 = await bribe.earned(user2.address, rewardToken.address);
            console.log("\n--- Final Results ---");
            console.log("user1 can claim:", finalEarned1.toString(), "units =", (finalEarned1.toNumber() / 1e8).toFixed(8), "cbBTC");
            console.log("user2 can claim:", finalEarned2.toString(), "units =", (finalEarned2.toNumber() / 1e8).toFixed(8), "cbBTC");
            console.log("Total claimable:", finalEarned1.add(finalEarned2).toString(), "units");
            console.log("Original reward:", EXACT_REWARD, "units");
            console.log("Lost to precision:", EXACT_REWARD - finalEarned1.add(finalEarned2).toNumber(), "units");
        });
    });

    describe("Scenario 7: Can small voters claim?", function () {
        it("should test various user balance sizes", async function () {
            const EXACT_TOTAL_SUPPLY = ethers.utils.parseEther("269960.52");
            const EXACT_REWARD = 818777;

            // Test different voter sizes
            const voterSizes = [
                { gDONUT: "100000", label: "100,000 gDONUT (whale)" },
                { gDONUT: "10000", label: "10,000 gDONUT (medium)" },
                { gDONUT: "1000", label: "1,000 gDONUT (small)" },
                { gDONUT: "100", label: "100 gDONUT (tiny)" },
                { gDONUT: "10", label: "10 gDONUT (micro)" },
                { gDONUT: "1", label: "1 gDONUT (dust)" },
            ];

            console.log("\n========== SMALL VOTER ANALYSIS ==========");
            console.log("totalSupply:", ethers.utils.formatEther(EXACT_TOTAL_SUPPLY.toString()), "gDONUT");
            console.log("reward:", EXACT_REWARD, "units (", EXACT_REWARD / 1e8, "cbBTC)");
            console.log("rewardRate: 1 unit/second");
            console.log("rewardPerToken after 7 days: 2");
            console.log("\n--- Minimum balance to earn anything ---");
            console.log("earned = balance * rewardPerToken / 1e18");
            console.log("For earned >= 1: balance >= 1e18 / 2 = 5e17 = 0.5 gDONUT");

            console.log("\n--- Expected earnings by voter size ---");

            for (const vs of voterSizes) {
                const balanceWei = ethers.utils.parseEther(vs.gDONUT);
                // earned = balance * rewardPerToken / 1e18
                // With rewardPerToken = 2:
                const expectedEarned = balanceWei.mul(2).div(ethers.utils.parseEther("1"));
                const earnedCbBTC = expectedEarned.toNumber() / 1e8;

                console.log(`${vs.label}:`);
                console.log(`  Expected earned: ${expectedEarned.toString()} units = ${earnedCbBTC.toFixed(8)} cbBTC`);

                if (expectedEarned.eq(0)) {
                    console.log(`  ⚠️  CANNOT CLAIM - balance too small!`);
                }
            }

            // Actually run test for smallest claimable voter
            console.log("\n--- Actual test with 1 gDONUT voter ---");

            const tinyBalance = ethers.utils.parseEther("1"); // 1 gDONUT
            const otherBalance = EXACT_TOTAL_SUPPLY.sub(tinyBalance);

            await bribe.connect(voter)._deposit(tinyBalance, user1.address);
            await bribe.connect(voter)._deposit(otherBalance, user2.address);

            await rewardToken.approve(bribe.address, EXACT_REWARD);
            await bribe.notifyRewardAmount(rewardToken.address, EXACT_REWARD);

            // Advance to end of period
            await ethers.provider.send("evm_increaseTime", [WEEK]);
            await ethers.provider.send("evm_mine");

            const tinyEarned = await bribe.earned(user1.address, rewardToken.address);
            console.log("1 gDONUT voter earned:", tinyEarned.toString(), "units");

            if (tinyEarned.eq(0)) {
                console.log("⚠️  1 gDONUT voter CANNOT claim anything!");
            } else {
                console.log("✓ 1 gDONUT voter CAN claim:", (tinyEarned.toNumber() / 1e8).toFixed(8), "cbBTC");
            }
        });

        it("should find minimum balance to earn 1 unit", async function () {
            const EXACT_TOTAL_SUPPLY = ethers.utils.parseEther("269960.52");
            const EXACT_REWARD = 818777;

            console.log("\n========== MINIMUM CLAIMABLE BALANCE ==========");

            // Binary search for minimum balance that earns > 0
            const balancesToTest = [
                "0.1",   // 0.1 gDONUT
                "0.5",   // 0.5 gDONUT
                "1",     // 1 gDONUT
                "5",     // 5 gDONUT
                "10",    // 10 gDONUT
            ];

            for (const bal of balancesToTest) {
                // Fresh bribe for each test
                const Bribe = await ethers.getContractFactory("Bribe");
                const testBribe = await Bribe.deploy(voter.address);
                await testBribe.connect(voter).addReward(rewardToken.address);

                const testBalance = ethers.utils.parseEther(bal);
                const otherBalance = EXACT_TOTAL_SUPPLY.sub(testBalance);

                await testBribe.connect(voter)._deposit(testBalance, user1.address);
                await testBribe.connect(voter)._deposit(otherBalance, user2.address);

                await rewardToken.mint(owner.address, EXACT_REWARD);
                await rewardToken.approve(testBribe.address, EXACT_REWARD);
                await testBribe.notifyRewardAmount(rewardToken.address, EXACT_REWARD);

                await ethers.provider.send("evm_increaseTime", [WEEK]);
                await ethers.provider.send("evm_mine");

                const earned = await testBribe.earned(user1.address, rewardToken.address);
                const status = earned.gt(0) ? "✓ CAN claim" : "✗ CANNOT claim";
                console.log(`${bal} gDONUT: earned=${earned.toString()} units ${status}`);
            }
        });
    });

    describe("Scenario 8: What if totalSupply grows?", function () {
        it("should show impact of more voters joining", async function () {
            console.log("\n========== IMPACT OF GROWING TOTALSUPPLY ==========");

            const EXACT_REWARD = 818777;
            const userBalance = ethers.utils.parseEther("105000"); // Fixed user balance

            // Test with different total supplies
            const totalSupplies = [
                { supply: "270000", label: "270K (current)" },
                { supply: "500000", label: "500K" },
                { supply: "1000000", label: "1M" },
                { supply: "5000000", label: "5M" },
                { supply: "10000000", label: "10M" },
                { supply: "27000000", label: "27M" },
            ];

            for (const ts of totalSupplies) {
                const Bribe = await ethers.getContractFactory("Bribe");
                const testBribe = await Bribe.deploy(voter.address);
                await testBribe.connect(voter).addReward(rewardToken.address);

                const totalSupplyBN = ethers.utils.parseEther(ts.supply);
                const otherBalance = totalSupplyBN.sub(userBalance);

                await testBribe.connect(voter)._deposit(userBalance, user1.address);
                if (otherBalance.gt(0)) {
                    await testBribe.connect(voter)._deposit(otherBalance, user2.address);
                }

                await rewardToken.mint(owner.address, EXACT_REWARD);
                await rewardToken.approve(testBribe.address, EXACT_REWARD);
                await testBribe.notifyRewardAmount(rewardToken.address, EXACT_REWARD);

                // Calculate expected rewardPerToken
                // rpt = WEEK * 1 * 1e18 / totalSupply
                const expectedRPT = ethers.BigNumber.from(WEEK).mul(ethers.utils.parseEther("1")).div(totalSupplyBN);

                await ethers.provider.send("evm_increaseTime", [WEEK]);
                await ethers.provider.send("evm_mine");

                const rpt = await testBribe.rewardPerToken(rewardToken.address);
                const earned = await testBribe.earned(user1.address, rewardToken.address);

                console.log(`\nTotal Supply: ${ts.label}`);
                console.log(`  Expected rewardPerToken: ${expectedRPT.toString()}`);
                console.log(`  Actual rewardPerToken: ${rpt.toString()}`);
                console.log(`  User (105K gDONUT) earned: ${earned.toString()} units = ${(earned.toNumber() / 1e8).toFixed(8)} cbBTC`);

                if (earned.eq(0)) {
                    console.log(`  ⚠️  REWARDS STUCK - rewardPerToken too small!`);
                }
            }
        });
    });
});
