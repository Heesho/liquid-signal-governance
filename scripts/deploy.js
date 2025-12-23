const { ethers } = require("hardhat");
const hre = require("hardhat");

// Constants
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const one = convert("1", 18);
const onePointTwo = convert("1.2", 18);
const oneThousand = convert("1000", 18);
const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";

// External Addresses (Base Mainnet)
const DAO_ADDRESS = "0x7a8C895E7826F66e1094532cB435Da725dc3868f";
const GLAZE_CORP_ADDRESS = "";

// Token Addresses (Base Mainnet)
const DONUT = "0xae4a37d554c6d6f3e398546d8566b25052e0169c";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const DONUT_ETH_LP = "0xD1DbB2E56533C55C3A637D13C53aeEf65c5D5703";

// Deployed Contract Addresses (paste after deployment)
const BRIBE_FACTORY = "";
const STRATEGY_FACTORY = "";
const GOVERNANCE_TOKEN = "";
const VOTER = "";
const REVENUE_ROUTER = "";
const MULTICALL = "";

// STRATEGY 0
// Buy DONUT and send to DAO
const STRATEGY_DESCRIPTION_0 = "Buy DONUT and send to DAO";
const PAYMENT_TOKEN_0 = DONUT;
const PAYMENT_RECEIVER_0 = DAO_ADDRESS;
const INIT_PRICE_0 = convert("5000", 18); // 5000 DONUT
const EPOCH_PERIOD_0 = 24 * 60 * 60; // 1 Day
const PRICE_MULTIPLIER_0 = convert("1.2", 18); // 120%
const MIN_INIT_PRICE_0 = convert("5000", 18); // 5000 DONUT
const STRATEGY_0 = "";
const BRIBE_0 = "";
const BRIBE_ROUTER_0 = "";

// STRATEGY 1
// Buy DONUT-ETH LP and send to DAO
const STRATEGY_DESCRIPTION_1 = "Buy DONUT-ETH LP and send to DAO";
const PAYMENT_TOKEN_1 = DONUT_ETH_LP;
const PAYMENT_RECEIVER_1 = DAO_ADDRESS;
const INIT_PRICE_1 = convert("2", 18); // 2 DONUT-ETH LP
const EPOCH_PERIOD_1 = 24 * 60 * 60; // 1 Day
const PRICE_MULTIPLIER_1 = convert("1.2", 18); // 120%
const MIN_INIT_PRICE_1 = convert("2", 18); // 2 DONUT-ETH LP
const STRATEGY_1 = "";
const BRIBE_1 = "";
const BRIBE_ROUTER_1 = "";

// STRATEGY 2
// Buy USDC and send to DAO
const STRATEGY_DESCRIPTION_2 = "Buy USDC and send to DAO";
const PAYMENT_TOKEN_2 = USDC;
const PAYMENT_RECEIVER_2 = DAO_ADDRESS;
const INIT_PRICE_2 = convert("100", 6); // 2 USDC
const EPOCH_PERIOD_2 = 24 * 60 * 60; // 1 Day
const PRICE_MULTIPLIER_2 = convert("1.2", 18); // 120%
const MIN_INIT_PRICE_2 = convert("100", 6); // 2 USDC
const STRATEGY_2 = "";
const BRIBE_2 = "";
const BRIBE_ROUTER_2 = "";

// STRATEGY 3
// Buy USDC and send to DAO
const STRATEGY_DESCRIPTION_3 = "Buy cbBTC and send to DAO";
const PAYMENT_TOKEN_3 = CBBTC;
const PAYMENT_RECEIVER_3 = DAO_ADDRESS;
const INIT_PRICE_3 = convert("100", 18); // 100 CBBTC
const EPOCH_PERIOD_3 = 24 * 60 * 60; // 1 Day
const PRICE_MULTIPLIER_3 = convert("1.2", 18); // 120%
const MIN_INIT_PRICE_3 = convert("100", 18); // 100 CBBTC
const STRATEGY_3 = "";
const BRIBE_3 = "";
const BRIBE_ROUTER_3 = "";

// Default Strategy and Bribe
const PAYMENT_TOKEN = PAYMENT_TOKEN_2;
const PAYMENT_RECEIVER = PAYMENT_RECEIVER_2;
const INIT_PRICE = INIT_PRICE_2;
const EPOCH_PERIOD = EPOCH_PERIOD_2;
const PRICE_MULTIPLIER = PRICE_MULTIPLIER_2;
const MIN_INIT_PRICE = MIN_INIT_PRICE_2;
const STRATEGY = STRATEGY_2;
const BRIBE = BRIBE_2;
const BRIBE_ROUTER = BRIBE_ROUTER_2;

// Contract Variables
let bribeFactory, strategyFactory;
let governanceToken, voter;
let revenueRouter, multicall;
let strategy, bribe, bribeRouter;

async function getContracts() {
  if (BRIBE_FACTORY) {
    bribeFactory = await ethers.getContractAt(
      "contracts/BribeFactory.sol:BribeFactory",
      BRIBE_FACTORY
    );
  }
  if (STRATEGY_FACTORY) {
    strategyFactory = await ethers.getContractAt(
      "contracts/StrategyFactory.sol:StrategyFactory",
      STRATEGY_FACTORY
    );
  }
  if (GOVERNANCE_TOKEN) {
    governanceToken = await ethers.getContractAt(
      "contracts/GovernanceToken.sol:GovernanceToken",
      GOVERNANCE_TOKEN
    );
  }
  if (VOTER) {
    voter = await ethers.getContractAt("contracts/Voter.sol:Voter", VOTER);
  }
  if (REVENUE_ROUTER) {
    revenueRouter = await ethers.getContractAt(
      "contracts/RevenueRouter.sol:RevenueRouter",
      REVENUE_ROUTER
    );
  }
  if (MULTICALL) {
    multicall = await ethers.getContractAt(
      "contracts/Multicall.sol:Multicall",
      MULTICALL
    );
  }
  if (STRATEGY) {
    strategy = await ethers.getContractAt(
      "contracts/Strategy.sol:Strategy",
      STRATEGY
    );
  }
  if (BRIBE) {
    bribe = await ethers.getContractAt("contracts/Bribe.sol:Bribe", BRIBE);
  }
  if (BRIBE_ROUTER) {
    bribeRouter = await ethers.getContractAt(
      "contracts/BribeRouter.sol:BribeRouter",
      BRIBE_ROUTER
    );
  }

  console.log("Contracts Retrieved");
}

// =============================================================================
// DEPLOY FUNCTIONS
// =============================================================================

async function deployBribeFactory() {
  console.log("Starting BribeFactory Deployment");
  const bribeFactoryArtifact = await ethers.getContractFactory("BribeFactory");
  const bribeFactoryContract = await bribeFactoryArtifact.deploy({
    gasPrice: ethers.gasPrice,
  });
  bribeFactory = await bribeFactoryContract.deployed();
  await sleep(5000);
  console.log("BribeFactory Deployed at:", bribeFactory.address);
}

async function verifyBribeFactory() {
  console.log("Starting BribeFactory Verification");
  await hre.run("verify:verify", {
    address: bribeFactory.address,
    contract: "contracts/BribeFactory.sol:BribeFactory",
  });
  console.log("BribeFactory Verified");
}

async function deployStrategyFactory() {
  console.log("Starting StrategyFactory Deployment");
  const strategyFactoryArtifact = await ethers.getContractFactory(
    "StrategyFactory"
  );
  const strategyFactoryContract = await strategyFactoryArtifact.deploy({
    gasPrice: ethers.gasPrice,
  });
  strategyFactory = await strategyFactoryContract.deployed();
  await sleep(5000);
  console.log("StrategyFactory Deployed at:", strategyFactory.address);
}

async function verifyStrategyFactory() {
  console.log("Starting StrategyFactory Verification");
  await hre.run("verify:verify", {
    address: strategyFactory.address,
    contract: "contracts/StrategyFactory.sol:StrategyFactory",
  });
  console.log("StrategyFactory Verified");
}

async function deployGovernanceToken() {
  console.log("Starting GovernanceToken Deployment");
  const governanceTokenArtifact = await ethers.getContractFactory(
    "GovernanceToken"
  );
  const governanceTokenContract = await governanceTokenArtifact.deploy(
    DONUT,
    "Governance Donut",
    "gDONUT",
    { gasPrice: ethers.gasPrice }
  );
  governanceToken = await governanceTokenContract.deployed();
  await sleep(5000);
  console.log("GovernanceToken Deployed at:", governanceToken.address);
}

async function verifyGovernanceToken() {
  console.log("Starting GovernanceToken Verification");
  await hre.run("verify:verify", {
    address: governanceToken.address,
    contract: "contracts/GovernanceToken.sol:GovernanceToken",
    constructorArguments: [DONUT, "Governance Donut", "gDONUT"],
  });
  console.log("GovernanceToken Verified");
}

async function deployVoter() {
  console.log("Starting Voter Deployment");
  const voterArtifact = await ethers.getContractFactory("Voter");
  const voterContract = await voterArtifact.deploy(
    governanceToken.address,
    WETH,
    DAO_ADDRESS,
    bribeFactory.address,
    strategyFactory.address,
    { gasPrice: ethers.gasPrice }
  );
  voter = await voterContract.deployed();
  await sleep(5000);
  console.log("Voter Deployed at:", voter.address);
}

async function verifyVoter() {
  console.log("Starting Voter Verification");
  await hre.run("verify:verify", {
    address: voter.address,
    contract: "contracts/Voter.sol:Voter",
    constructorArguments: [
      governanceToken.address,
      WETH,
      DAO_ADDRESS,
      bribeFactory.address,
      strategyFactory.address,
    ],
  });
  console.log("Voter Verified");
}

async function deployRevenueRouter() {
  console.log("Starting RevenueRouter Deployment");
  const revenueRouterArtifact = await ethers.getContractFactory(
    "RevenueRouter"
  );
  const revenueRouterContract = await revenueRouterArtifact.deploy(
    WETH,
    voter.address,
    { gasPrice: ethers.gasPrice }
  );
  revenueRouter = await revenueRouterContract.deployed();
  await sleep(5000);
  console.log("RevenueRouter Deployed at:", revenueRouter.address);
}

async function verifyRevenueRouter() {
  console.log("Starting RevenueRouter Verification");
  await hre.run("verify:verify", {
    address: revenueRouter.address,
    contract: "contracts/RevenueRouter.sol:RevenueRouter",
    constructorArguments: [WETH, voter.address],
  });
  console.log("RevenueRouter Verified");
}

async function deployMulticall() {
  console.log("Starting Multicall Deployment");
  const multicallArtifact = await ethers.getContractFactory("Multicall");
  const multicallContract = await multicallArtifact.deploy(voter.address, {
    gasPrice: ethers.gasPrice,
  });
  multicall = await multicallContract.deployed();
  await sleep(5000);
  console.log("Multicall Deployed at:", multicall.address);
}

async function verifyMulticall() {
  console.log("Starting Multicall Verification");
  await hre.run("verify:verify", {
    address: multicall.address,
    contract: "contracts/Multicall.sol:Multicall",
    constructorArguments: [voter.address],
  });
  console.log("Multicall Verified");
}

// =============================================================================
// CONFIGURATION FUNCTIONS
// =============================================================================

async function setVoterOnGovernanceToken() {
  console.log("Setting Voter on GovernanceToken...");
  const tx = await governanceToken.setVoter(voter.address);
  await tx.wait();
  console.log("Voter set on GovernanceToken");
}

async function setRevenueSource() {
  console.log("Setting Revenue Source on Voter...");
  const tx = await voter.setRevenueSource(revenueRouter.address);
  await tx.wait();
  console.log("Revenue Source set on Voter");
}

async function setBribeSplit() {
  console.log("Setting Bribe Split to 20%...");
  const tx = await voter.setBribeSplit(2000); // 2000 = 20% in basis points
  await tx.wait();
  console.log("Bribe Split set to 20%");
}

async function addStrategy() {
  console.log("Adding Strategy (Auction)...");
  const tx = await voter.addStrategy(
    PAYMENT_TOKEN, // paymentToken
    PAYMENT_RECEIVER, // paymentReceiver
    INIT_PRICE, // initPrice
    EPOCH_PERIOD, // epochPeriod
    PRICE_MULTIPLIER, // priceMultiplier
    MIN_INIT_PRICE // minInitPrice
  );
  const receipt = await tx.wait();
  const event = receipt.events?.find((e) => e.event === "Voter__StrategyAdded");
  strategy = await ethers.getContractAt(
    "contracts/Strategy.sol:Strategy",
    event?.args?.strategy
  );
  bribe = await ethers.getContractAt(
    "contracts/Bribe.sol:Bribe",
    event?.args?.bribe
  );
  bribeRouter = await ethers.getContractAt(
    "contracts/BribeRouter.sol:BribeRouter",
    event?.args?.bribeRouter
  );
  console.log("Strategy Deployed at:", strategy.address);
  console.log("Bribe Deployed at:", bribe.address);
  console.log("BribeRouter Deployed at:", bribeRouter.address);
}

async function transferOwnershipToDAO() {
  console.log("Transferring Voter ownership to DAO...");
  const tx1 = await voter.transferOwnership(DAO_ADDRESS);
  await tx1.wait();
  console.log("Voter ownership transferred to:", DAO_ADDRESS);

  console.log("Transferring GovernanceToken ownership to DAO...");
  const tx2 = await governanceToken.transferOwnership(DAO_ADDRESS);
  await tx2.wait();
  console.log("GovernanceToken ownership transferred to:", DAO_ADDRESS);
}

async function killStrategy(strategyAddress) {
  console.log("Killing Strategy:", strategyAddress);
  const tx = await voter.killStrategy(strategyAddress);
  await tx.wait();
  console.log("Strategy Killed:", strategyAddress);
}

// =============================================================================
// PRINT FUNCTIONS
// =============================================================================

async function printCoreAddresses() {
  console.log("**************************************************************");
  console.log("BribeFactory:     ", bribeFactory.address);
  console.log("StrategyFactory:  ", strategyFactory.address);
  console.log("GovernanceToken:  ", governanceToken.address);
  console.log("Voter:            ", voter.address);
  console.log("RevenueRouter:    ", revenueRouter.address);
  console.log("Multicall:        ", multicall.address);
  console.log("**************************************************************");
}

async function printStrategyAddresses() {
  console.log("**************************************************************");
  console.log("Strategy:         ", strategy?.address || "Not deployed");
  console.log("Bribe:            ", bribe?.address || "Not deployed");
  console.log("BribeRouter:      ", bribeRouter?.address || "Not deployed");
  console.log("**************************************************************");
}

async function printExternalAddresses() {
  console.log("**************************************************************");
  console.log("DONUT:            ", DONUT);
  console.log("WETH:             ", WETH);
  console.log("USDC:             ", USDC);
  console.log("DONUT_ETH_LP:     ", DONUT_ETH_LP);
  console.log("DAO:              ", DAO_ADDRESS);
  console.log("**************************************************************");
}

async function printAllAddresses() {
  console.log(
    "\n==================== LIQUID SIGNAL DEPLOYMENT ====================\n"
  );

  console.log("--- External Addresses ---");
  console.log("DAO:              ", DAO_ADDRESS);
  console.log("DONUT:            ", DONUT);
  console.log("WETH:             ", WETH);
  console.log("USDC:             ", USDC);
  console.log("DONUT_ETH_LP:     ", DONUT_ETH_LP);

  console.log("\n--- Core Contracts ---");
  console.log("BribeFactory:     ", BRIBE_FACTORY);
  console.log("StrategyFactory:  ", STRATEGY_FACTORY);
  console.log("GovernanceToken:  ", GOVERNANCE_TOKEN);
  console.log("Voter:            ", VOTER);
  console.log("RevenueRouter:    ", REVENUE_ROUTER);
  console.log("Multicall:        ", MULTICALL);

  console.log("\n--- Strategy 0: " + STRATEGY_DESCRIPTION_0 + " ---");
  console.log("Strategy:         ", STRATEGY_0);
  console.log("Bribe:            ", BRIBE_0);
  console.log("BribeRouter:      ", BRIBE_ROUTER_0);

  console.log("\n--- Strategy 1: " + STRATEGY_DESCRIPTION_1 + " ---");
  console.log("Strategy:         ", STRATEGY_1);
  console.log("Bribe:            ", BRIBE_1);
  console.log("BribeRouter:      ", BRIBE_ROUTER_1);

  console.log("\n--- Strategy 2: " + STRATEGY_DESCRIPTION_2 + " ---");
  console.log("Strategy:         ", STRATEGY_2);
  console.log("Bribe:            ", BRIBE_2);
  console.log("BribeRouter:      ", BRIBE_ROUTER_2);

  console.log(
    "\n===================================================================\n"
  );
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Using wallet:", wallet.address);
  console.log("Account balance:", (await wallet.getBalance()).toString());

  await getContracts();

  //===================================================================
  // Deploy Core Contracts
  //===================================================================

  // console.log("Starting Core Deployment");
  // await deployBribeFactory();
  // await deployStrategyFactory();
  // await deployGovernanceToken();
  // await deployVoter();
  // await deployRevenueRouter();
  // await deployMulticall();
  // await printCoreAddresses();

  //===================================================================
  // Verify Core Contracts
  //===================================================================

  // console.log("Starting Core Verification");
  // await verifyBribeFactory();
  // await verifyStrategyFactory();
  // await verifyGovernanceToken();
  // await verifyVoter();
  // await verifyRevenueRouter();
  // await verifyMulticall();
  // console.log("Core Contracts Verified");

  //===================================================================
  // Configure Contracts
  //===================================================================

  // console.log("Starting Configuration");
  // await setVoterOnGovernanceToken();
  // await setRevenueSource();
  // await setBribeSplit();
  // console.log("Configuration Complete");

  //===================================================================
  // Add Strategy
  //===================================================================

  // console.log("Starting Strategy Deployment");
  // await addStrategy();
  // await printStrategyAddresses();

  //===================================================================
  // Transfer Ownership
  //===================================================================

  // console.log("Starting Ownership Transfer");
  // await transferOwnershipToDAO();
  // console.log("Ownership Transfer Complete");

  //===================================================================
  // Kill Strategy
  //===================================================================

  // await killStrategy(STRATEGY_0); // Kill DONUT strategy
  // await killStrategy(STRATEGY_1); // Kill DONUT-ETH LP strategy
  // await killStrategy(STRATEGY_2); // Kill USDC strategy

  //===================================================================
  // Print Deployment
  //===================================================================

  await printAllAddresses();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
