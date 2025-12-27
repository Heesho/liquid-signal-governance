const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Dashboard Integration Test", function () {
    let owner, user1, user2, treasury;
    let underlying, revenueToken, paymentToken, paymentToken2;
    let governanceToken, voter, bribeFactory, strategyFactory, revenueRouter;
    let multicall;
    let strategy1, strategy2, bribeRouter1, bribeRouter2;

    const WEEK = 7 * 24 * 60 * 60;
    const HOUR = 60 * 60;

    // Dashboard helper functions
    const divDec = (amount, decimals = 18) => {
        if (!amount) return 0;
        return Number(amount) / 10 ** decimals;
    };

    const formatTime = (seconds) => {
        if (seconds <= 0) return "0s";
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (mins > 0) parts.push(`${mins}m`);
        if (secs > 0 && days === 0) parts.push(`${secs}s`);
        return parts.join(" ") || "0s";
    };

    before(async function () {
        [owner, user1, user2, treasury] = await ethers.getSigners();

        // Deploy mock tokens
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("DONUT", "DONUT", 18);
        revenueToken = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
        paymentToken = await MockERC20.deploy("USD Coin", "USDC", 6);
        paymentToken2 = await MockERC20.deploy("Coinbase BTC", "cbBTC", 8);

        // Deploy factories
        const BribeFactory = await ethers.getContractFactory("BribeFactory");
        bribeFactory = await BribeFactory.deploy();

        const StrategyFactory = await ethers.getContractFactory("StrategyFactory");
        strategyFactory = await StrategyFactory.deploy();

        // Deploy GovernanceToken
        const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
        governanceToken = await GovernanceToken.deploy(underlying.address, "Governance DONUT", "gDONUT");

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

        // Deploy RevenueRouter
        const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
        revenueRouter = await RevenueRouter.deploy(revenueToken.address, voter.address);
        await voter.setRevenueSource(revenueRouter.address);

        // Set bribe split
        await voter.setBribeSplit(2000); // 20%

        // Deploy Multicall
        const Multicall = await ethers.getContractFactory("Multicall");
        multicall = await Multicall.deploy(voter.address);

        // Create strategies
        const initPrice1 = ethers.utils.parseUnits("100", 6);
        let tx = await voter.addStrategy(paymentToken.address, treasury.address, initPrice1, HOUR * 24, ethers.utils.parseEther("1.2"), initPrice1);
        let receipt = await tx.wait();
        let event = receipt.events.find(e => e.event === "Voter__StrategyAdded");
        strategy1 = event.args.strategy;
        bribeRouter1 = event.args.bribeRouter;

        const initPrice2 = ethers.utils.parseUnits("0.01", 8);
        tx = await voter.addStrategy(paymentToken2.address, treasury.address, initPrice2, HOUR * 24, ethers.utils.parseEther("1.2"), initPrice2);
        receipt = await tx.wait();
        event = receipt.events.find(e => e.event === "Voter__StrategyAdded");
        strategy2 = event.args.strategy;
        bribeRouter2 = event.args.bribeRouter;

        // Mint tokens
        await underlying.mint(user1.address, ethers.utils.parseEther("10000"));
        await underlying.mint(user2.address, ethers.utils.parseEther("5000"));
        await revenueToken.mint(owner.address, ethers.utils.parseEther("1000"));
        await paymentToken.mint(user1.address, ethers.utils.parseUnits("100000", 6));
        await paymentToken2.mint(user1.address, ethers.utils.parseUnits("10", 8));

        // Users stake and vote
        await underlying.connect(user1).approve(governanceToken.address, ethers.utils.parseEther("10000"));
        await governanceToken.connect(user1).stake(ethers.utils.parseEther("10000"));
        await voter.connect(user1).vote([strategy1, strategy2], [70, 30]);

        await underlying.connect(user2).approve(governanceToken.address, ethers.utils.parseEther("5000"));
        await governanceToken.connect(user2).stake(ethers.utils.parseEther("5000"));
        await voter.connect(user2).vote([strategy1], [100]);

        // Send revenue
        await revenueToken.transfer(revenueRouter.address, ethers.utils.parseEther("10"));
    });

    it("should display full dashboard", async function () {
        // Fetch all data in one call
        const [system, strategies] = await multicall.getFullSystemView();

        console.log("\n");
        console.log("================================================================================");
        console.log("                    LIQUID SIGNAL GOVERNANCE - SYSTEM DASHBOARD                 ");
        console.log("================================================================================");
        console.log(`                          ${new Date().toUTCString()}`);
        console.log("================================================================================\n");

        // EPOCH STATUS
        console.log("-------------------------------- EPOCH STATUS ---------------------------------");
        console.log(`  Voting Epoch Flip:     ${formatTime(Number(system.timeUntilNextEpoch))}`);
        console.log(`  Current Epoch Start:   ${new Date(Number(system.currentEpochStart) * 1000).toUTCString()}`);
        console.log(`  Next Epoch Start:      ${new Date(Number(system.nextEpochStart) * 1000).toUTCString()}`);
        console.log("");

        // WETH DISTRIBUTION
        console.log("------------------------------ WETH DISTRIBUTION ------------------------------");
        const routerWeth = divDec(system.revenueRouterWethBalance);
        console.log(`  Revenue Router:        ${routerWeth.toFixed(6)} WETH`);
        console.log(`    Address:             ${system.revenueRouter}`);
        console.log("");

        const voterClaimable = divDec(system.voterTotalClaimable);
        console.log(`  Voter (Claimable):     ${voterClaimable.toFixed(6)} WETH`);
        console.log(`    Address:             ${system.voterAddress}`);
        console.log("");

        console.log("  Strategies:");
        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            const wethBalance = divDec(s.strategyWethBalance);
            const claimable = divDec(s.strategyClaimable);
            const pending = divDec(s.strategyPendingRevenue);
            const total = divDec(s.strategyTotalPotentialWeth);

            console.log(`    [${i}] Strategy ${i}          ${wethBalance.toFixed(6)} WETH (in contract)`);
            console.log(`        Claimable:       ${claimable.toFixed(6)} WETH`);
            console.log(`        Pending:         ${pending.toFixed(6)} WETH`);
            console.log(`        Total Potential: ${total.toFixed(6)} WETH`);
            console.log(`        Address:         ${s.strategy}`);
            console.log(`        Status:          ${s.isAlive ? "ACTIVE" : "KILLED"}`);
            console.log("");
        }

        // STRATEGY TOKENS
        console.log("----------------------------- STRATEGY TOKENS --------------------------------");
        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            const decimals = Number(s.paymentTokenDecimals);
            const symbol = s.paymentTokenSymbol;
            const bribeRouterBalance = divDec(s.bribeRouterTokenBalance, decimals);
            const bribeLeft = divDec(s.bribeTokensLeft, decimals);

            console.log(`  [${i}] Strategy ${i} (${symbol})`);
            console.log(`      Token Address:     ${s.paymentToken}`);
            console.log(`      Token Decimals:    ${decimals}`);
            console.log(`      BribeRouter:       ${bribeRouterBalance.toFixed(4)} ${symbol}`);
            console.log(`        Address:         ${s.bribeRouter}`);
            console.log(`      Bribe (left):      ${bribeLeft.toFixed(4)} ${symbol}`);
            console.log(`        Address:         ${s.bribe}`);
            console.log(`        Total Supply:    ${divDec(s.bribeTotalSupply).toFixed(4)} gDONUT`);
            console.log("");
        }

        // AUCTION STATUS
        console.log("------------------------------- AUCTION STATUS --------------------------------");
        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            const decimals = Number(s.paymentTokenDecimals);
            const symbol = s.paymentTokenSymbol;
            const initPrice = divDec(s.initPrice, decimals);
            const currentPrice = divDec(s.currentPrice, decimals);
            const revenueBalance = divDec(s.strategyWethBalance);
            const timeLeft = formatTime(Number(s.timeUntilAuctionEnd));
            const epochPeriod = formatTime(Number(s.epochPeriod));

            console.log(`  [${i}] Strategy ${i}`);
            console.log(`      Epoch ID:          ${s.epochId.toString()}`);
            console.log(`      Epoch Period:      ${epochPeriod}`);
            console.log(`      Time Until End:    ${timeLeft}`);
            console.log(`      Init Price:        ${initPrice.toFixed(4)} ${symbol}`);
            console.log(`      Current Price:     ${currentPrice.toFixed(4)} ${symbol}`);
            console.log(`      Revenue Available: ${revenueBalance.toFixed(6)} WETH`);
            console.log("");
        }

        // VOTING SUMMARY
        console.log("-------------------------------- VOTING SUMMARY -------------------------------");
        const totalWeight = divDec(system.totalWeight);
        const bribeSplit = Number(system.bribeSplit) / 100;
        const govTokenSupply = divDec(system.governanceTokenTotalSupply);

        console.log(`  Governance Token:      ${system.governanceToken}`);
        console.log(`  Underlying Token:      ${system.underlyingToken} (${system.underlyingTokenSymbol})`);
        console.log(`  Total Supply:          ${govTokenSupply.toFixed(4)} gDONUT`);
        console.log(`  Total Vote Weight:     ${totalWeight.toFixed(4)} gDONUT`);
        console.log(`  Bribe Split:           ${bribeSplit}%`);
        console.log("");

        console.log("  Vote Distribution:");
        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            const weight = divDec(s.strategyWeight);
            const percent = divDec(s.votePercent);
            const bar = "=".repeat(Math.floor(percent / 2));
            console.log(`    [${i}] Strategy ${i}          ${weight.toFixed(2).padStart(12)} gDONUT  ${percent.toFixed(2).padStart(6)}%  ${bar}`);
        }
        console.log("");

        // CONTRACT ADDRESSES
        console.log("------------------------------ CONTRACT ADDRESSES -----------------------------");
        console.log(`  Multicall:             ${multicall.address}`);
        console.log(`  Voter:                 ${system.voterAddress}`);
        console.log(`  RevenueRouter:         ${system.revenueRouter}`);
        console.log(`  GovernanceToken:       ${system.governanceToken}`);
        console.log("");

        console.log("================================================================================");
        console.log("                                 END OF DASHBOARD                              ");
        console.log("================================================================================\n");

        // Assertions to verify data is correct
        expect(system.strategyCount).to.equal(2);
        expect(system.revenueRouterWethBalance).to.equal(ethers.utils.parseEther("10"));
        expect(strategies.length).to.equal(2);
        expect(strategies[0].paymentTokenSymbol).to.equal("USDC");
        expect(strategies[1].paymentTokenSymbol).to.equal("cbBTC");
        expect(system.totalWeight).to.equal(ethers.utils.parseEther("15000")); // 10000 + 5000
    });
});
