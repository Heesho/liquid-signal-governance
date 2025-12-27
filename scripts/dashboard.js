const { ethers } = require("hardhat");

// Helper functions
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

const formatAddress = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

const padRight = (str, len) => str.toString().padEnd(len);
const padLeft = (str, len) => str.toString().padStart(len);

// Contract Addresses (Base Mainnet)
const MULTICALL = "0x210bB58735C7EE245ad94D5A90D3d11D6912133a";

// Strategy descriptions
const STRATEGY_NAMES = {
  "0xfb02712c5daa614f7d331D7bcbB8Be254A3ecc3F": "DONUT Buyback",
  "0x26799141c31B051f13A239324c26ef72d82413E5": "DONUT-ETH LP Buyback",
  "0xdc4c547EDef2156875E9C1632D00a0B456cfc834": "USDC Buyback",
  "0x4eBa1Ee0A1DAdbd2CdFfc4056fe1e20330A9806A": "cbBTC Buyback",
};

async function main() {
  console.log("\n");
  console.log(
    "================================================================================"
  );
  console.log(
    "                    LIQUID SIGNAL GOVERNANCE - SYSTEM DASHBOARD                 "
  );
  console.log(
    "================================================================================"
  );
  console.log(`                          ${new Date().toUTCString()}`);
  console.log(
    "================================================================================\n"
  );

  // Get Multicall contract
  const multicall = await ethers.getContractAt(
    "contracts/Multicall.sol:Multicall",
    MULTICALL
  );

  // Fetch all data in one call
  const [system, strategies] = await multicall.getFullSystemView();

  // ==================== EPOCH COUNTDOWN ====================
  console.log(
    "-------------------------------- EPOCH STATUS ---------------------------------"
  );
  console.log(
    `  Voting Epoch Flip:     ${formatTime(Number(system.timeUntilNextEpoch))}`
  );
  console.log(
    `  Current Epoch Start:   ${new Date(Number(system.currentEpochStart) * 1000).toUTCString()}`
  );
  console.log(
    `  Next Epoch Start:      ${new Date(Number(system.nextEpochStart) * 1000).toUTCString()}`
  );
  console.log("");

  // ==================== WETH DISTRIBUTION ====================
  console.log(
    "------------------------------ WETH DISTRIBUTION ------------------------------"
  );

  // Revenue Router
  const routerWeth = divDec(system.revenueRouterWethBalance);
  console.log(`  Revenue Router:        ${routerWeth.toFixed(6)} WETH`);
  console.log(`    Address:             ${system.revenueRouter}`);
  console.log("");

  // Voter
  const voterClaimable = divDec(system.voterTotalClaimable);
  console.log(`  Voter (Claimable):     ${voterClaimable.toFixed(6)} WETH`);
  console.log(`    Address:             ${system.voterAddress}`);
  console.log("");

  // Strategies WETH
  let totalStrategyWeth = 0;
  console.log("  Strategies:");
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const name = STRATEGY_NAMES[s.strategy] || `Strategy ${i}`;
    const wethBalance = divDec(s.strategyWethBalance);
    const claimable = divDec(s.strategyClaimable);
    const pending = divDec(s.strategyPendingRevenue);
    const total = divDec(s.strategyTotalPotentialWeth);
    totalStrategyWeth += wethBalance;

    console.log(
      `    [${i}] ${padRight(name, 22)} ${wethBalance.toFixed(6)} WETH (in contract)`
    );
    console.log(
      `        Claimable:       ${claimable.toFixed(6)} WETH`
    );
    console.log(
      `        Pending:         ${pending.toFixed(6)} WETH`
    );
    console.log(
      `        Total Potential: ${total.toFixed(6)} WETH`
    );
    console.log(`        Address:         ${s.strategy}`);
    console.log(`        Status:          ${s.isAlive ? "ACTIVE" : "KILLED"}`);
    console.log("");
  }

  // WETH Summary
  const totalSystemWeth = routerWeth + voterClaimable + totalStrategyWeth;
  console.log(
    "  -------------------------------------------------------------------------"
  );
  console.log(`  TOTAL WETH IN SYSTEM:  ${totalSystemWeth.toFixed(6)} WETH`);
  console.log("");

  // ==================== STRATEGY TOKENS ====================
  console.log(
    "----------------------------- STRATEGY TOKENS --------------------------------"
  );

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const name = STRATEGY_NAMES[s.strategy] || `Strategy ${i}`;
    const decimals = Number(s.paymentTokenDecimals);
    const symbol = s.paymentTokenSymbol;

    const bribeRouterBalance = divDec(s.bribeRouterTokenBalance, decimals);
    const bribeLeft = divDec(s.bribeTokensLeft, decimals);

    console.log(`  [${i}] ${name} (${symbol})`);
    console.log(`      Token Address:     ${s.paymentToken}`);
    console.log(`      Token Decimals:    ${decimals}`);
    console.log("");
    console.log(
      `      BribeRouter:       ${bribeRouterBalance.toFixed(decimals > 6 ? 4 : 2)} ${symbol}`
    );
    console.log(`        Address:         ${s.bribeRouter}`);
    console.log("");
    console.log(
      `      Bribe (left):      ${bribeLeft.toFixed(decimals > 6 ? 4 : 2)} ${symbol}`
    );
    console.log(`        Address:         ${s.bribe}`);
    console.log(
      `        Total Supply:    ${divDec(s.bribeTotalSupply).toFixed(4)} gDONUT (virtual votes)`
    );
    console.log("");
  }

  // ==================== AUCTION STATUS ====================
  console.log(
    "------------------------------- AUCTION STATUS --------------------------------"
  );

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const name = STRATEGY_NAMES[s.strategy] || `Strategy ${i}`;
    const decimals = Number(s.paymentTokenDecimals);
    const symbol = s.paymentTokenSymbol;

    const initPrice = divDec(s.initPrice, decimals);
    const currentPrice = divDec(s.currentPrice, decimals);
    const revenueBalance = divDec(s.strategyWethBalance);
    const timeLeft = formatTime(Number(s.timeUntilAuctionEnd));
    const epochPeriod = formatTime(Number(s.epochPeriod));

    console.log(`  [${i}] ${name}`);
    console.log(`      Epoch ID:          ${s.epochId.toString()}`);
    console.log(`      Epoch Period:      ${epochPeriod}`);
    console.log(`      Time Until End:    ${timeLeft}`);
    console.log(`      Init Price:        ${initPrice.toFixed(decimals > 6 ? 4 : 2)} ${symbol}`);
    console.log(
      `      Current Price:     ${currentPrice.toFixed(decimals > 6 ? 4 : 2)} ${symbol}`
    );
    console.log(`      Revenue Available: ${revenueBalance.toFixed(6)} WETH`);
    console.log("");
  }

  // ==================== VOTING SUMMARY ====================
  console.log(
    "-------------------------------- VOTING SUMMARY -------------------------------"
  );

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
    const name = STRATEGY_NAMES[s.strategy] || `Strategy ${i}`;
    const weight = divDec(s.strategyWeight);
    const percent = divDec(s.votePercent);
    const status = s.isAlive ? "" : " [KILLED]";

    const bar = "=".repeat(Math.floor(percent / 2));
    console.log(
      `    [${i}] ${padRight(name, 22)} ${padLeft(weight.toFixed(2), 12)} gDONUT  ${padLeft(percent.toFixed(2), 6)}%  ${bar}${status}`
    );
  }
  console.log("");

  // ==================== CONTRACT ADDRESSES ====================
  console.log(
    "------------------------------ CONTRACT ADDRESSES -----------------------------"
  );
  console.log(`  Multicall:             ${MULTICALL}`);
  console.log(`  Voter:                 ${system.voterAddress}`);
  console.log(`  RevenueRouter:         ${system.revenueRouter}`);
  console.log(`  GovernanceToken:       ${system.governanceToken}`);
  console.log("");

  console.log(
    "================================================================================"
  );
  console.log(
    "                                 END OF DASHBOARD                              "
  );
  console.log(
    "================================================================================\n"
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
