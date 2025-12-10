const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());

  // =============================================================================
  // CONFIGURATION
  // =============================================================================

  // DONUT token on Base mainnet
  const DONUT_TOKEN = "0xae4a37d554c6d6f3e398546d8566b25052e0169c";

  // Revenue token - WETH on Base mainnet
  const WETH = "0x4200000000000000000000000000000000000006";

  // Treasury address - receives revenue when no votes exist
  // IMPORTANT: Set this to your desired treasury address before deploying
  const TREASURY = deployer.address; // Default to deployer, change as needed

  // DAO address - will receive ownership of contracts after deployment
  // IMPORTANT: Set this to your DAO/multisig address before deploying
  const DAO_ADDRESS = "0x0000000000000000000000000000000000000000"; // UPDATE THIS

  // Initial strategy (auction) configuration
  const STRATEGY_CONFIG = {
    paymentToken: DONUT_TOKEN, // Buy DONUT
    paymentReceiver: DAO_ADDRESS, // Send DONUT to DAO
    initPrice: ethers.utils.parseEther("1000000"), // Initial auction price (1M DONUT)
    epochPeriod: 7 * 24 * 60 * 60, // 7 days in seconds
    priceMultiplier: 11000, // 110% - price multiplier after successful auction
    minInitPrice: ethers.utils.parseEther("100000"), // Minimum price (100K DONUT)
  };

  // Governance token configuration
  const GOVERNANCE_TOKEN_NAME = "Governance Donut";
  const GOVERNANCE_TOKEN_SYMBOL = "gDONUT";

  // =============================================================================
  // DEPLOYMENT
  // =============================================================================

  console.log("\n--- Starting Deployment ---\n");

  // 1. Deploy BribeFactory
  console.log("1. Deploying BribeFactory...");
  const BribeFactory = await ethers.getContractFactory("BribeFactory");
  const bribeFactory = await BribeFactory.deploy();
  await bribeFactory.deployed();
  console.log("   BribeFactory deployed to:", bribeFactory.address);

  // 2. Deploy StrategyFactory
  console.log("2. Deploying StrategyFactory...");
  const StrategyFactory = await ethers.getContractFactory("StrategyFactory");
  const strategyFactory = await StrategyFactory.deploy();
  await strategyFactory.deployed();
  console.log("   StrategyFactory deployed to:", strategyFactory.address);

  // 3. Deploy GovernanceToken (gDONUT)
  console.log("3. Deploying GovernanceToken...");
  const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
  const governanceToken = await GovernanceToken.deploy(
    DONUT_TOKEN,
    GOVERNANCE_TOKEN_NAME,
    GOVERNANCE_TOKEN_SYMBOL
  );
  await governanceToken.deployed();
  console.log("   GovernanceToken deployed to:", governanceToken.address);

  // 4. Deploy Voter
  console.log("4. Deploying Voter...");
  const Voter = await ethers.getContractFactory("Voter");
  const voter = await Voter.deploy(
    governanceToken.address,
    WETH,
    TREASURY,
    bribeFactory.address,
    strategyFactory.address
  );
  await voter.deployed();
  console.log("   Voter deployed to:", voter.address);

  // 5. Set voter on GovernanceToken
  console.log("5. Setting voter on GovernanceToken...");
  const setVoterTx = await governanceToken.setVoter(voter.address);
  await setVoterTx.wait();
  console.log("   Voter set on GovernanceToken");

  // 6. Deploy RevenueRouter
  console.log("6. Deploying RevenueRouter...");
  const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
  const revenueRouter = await RevenueRouter.deploy(WETH, voter.address);
  await revenueRouter.deployed();
  console.log("   RevenueRouter deployed to:", revenueRouter.address);

  // 7. Set revenue source on Voter
  console.log("7. Setting revenue source on Voter...");
  const setRevenueSourceTx = await voter.setRevenueSource(revenueRouter.address);
  await setRevenueSourceTx.wait();
  console.log("   Revenue source set on Voter");

  // 8. Set bribe split to 20%
  console.log("8. Setting bribe split to 20%...");
  const setBribeSplitTx = await voter.setBribeSplit(2000); // 2000 = 20% in basis points
  await setBribeSplitTx.wait();
  console.log("   Bribe split set to 20%");

  // 9. Deploy Multicall (optional but recommended for frontend)
  console.log("9. Deploying Multicall...");
  const Multicall = await ethers.getContractFactory("Multicall");
  const multicall = await Multicall.deploy(voter.address);
  await multicall.deployed();
  console.log("   Multicall deployed to:", multicall.address);

  // 10. Add initial strategy (auction)
  console.log("10. Adding initial strategy (auction)...");
  const addStrategyTx = await voter.addStrategy(
    STRATEGY_CONFIG.paymentToken,
    STRATEGY_CONFIG.paymentReceiver,
    STRATEGY_CONFIG.initPrice,
    STRATEGY_CONFIG.epochPeriod,
    STRATEGY_CONFIG.priceMultiplier,
    STRATEGY_CONFIG.minInitPrice
  );
  const addStrategyReceipt = await addStrategyTx.wait();
  const strategyAddedEvent = addStrategyReceipt.events?.find(e => e.event === "Voter__StrategyAdded");
  const strategyAddress = strategyAddedEvent?.args?.strategy;
  const bribeAddress = strategyAddedEvent?.args?.bribe;
  const bribeRouterAddress = strategyAddedEvent?.args?.bribeRouter;
  console.log("   Strategy deployed to:", strategyAddress);
  console.log("   Bribe deployed to:", bribeAddress);
  console.log("   BribeRouter deployed to:", bribeRouterAddress);

  // 11. Transfer ownership to DAO
  if (DAO_ADDRESS !== "0x0000000000000000000000000000000000000000") {
    console.log("11. Transferring ownership to DAO...");

    // Transfer Voter ownership
    const transferVoterTx = await voter.transferOwnership(DAO_ADDRESS);
    await transferVoterTx.wait();
    console.log("   Voter ownership transferred to:", DAO_ADDRESS);

    // Transfer GovernanceToken ownership
    const transferGovTokenTx = await governanceToken.transferOwnership(DAO_ADDRESS);
    await transferGovTokenTx.wait();
    console.log("   GovernanceToken ownership transferred to:", DAO_ADDRESS);
  } else {
    console.log("11. Skipping ownership transfer (DAO_ADDRESS not set)");
    console.log("   WARNING: Update DAO_ADDRESS and transfer ownership manually!");
  }

  // =============================================================================
  // DEPLOYMENT SUMMARY
  // =============================================================================

  console.log("\n--- Deployment Complete ---\n");
  console.log("Contract Addresses:");
  console.log("==================");
  console.log("BribeFactory:     ", bribeFactory.address);
  console.log("StrategyFactory:  ", strategyFactory.address);
  console.log("GovernanceToken:  ", governanceToken.address);
  console.log("Voter:            ", voter.address);
  console.log("RevenueRouter:    ", revenueRouter.address);
  console.log("Multicall:        ", multicall.address);
  console.log("\nInitial Strategy:");
  console.log("==================");
  console.log("Strategy:         ", strategyAddress);
  console.log("Bribe:            ", bribeAddress);
  console.log("BribeRouter:      ", bribeRouterAddress);
  console.log("\nExternal Addresses:");
  console.log("==================");
  console.log("DONUT Token:      ", DONUT_TOKEN);
  console.log("Revenue Token:    ", WETH);
  console.log("Treasury:         ", TREASURY);
  console.log("DAO:              ", DAO_ADDRESS);

  console.log("\n--- Verification Commands ---\n");
  console.log(`npx hardhat verify --network mainnet ${bribeFactory.address}`);
  console.log(`npx hardhat verify --network mainnet ${strategyFactory.address}`);
  console.log(`npx hardhat verify --network mainnet ${governanceToken.address} "${DONUT_TOKEN}" "${GOVERNANCE_TOKEN_NAME}" "${GOVERNANCE_TOKEN_SYMBOL}"`);
  console.log(`npx hardhat verify --network mainnet ${voter.address} "${governanceToken.address}" "${WETH}" "${TREASURY}" "${bribeFactory.address}" "${strategyFactory.address}"`);
  console.log(`npx hardhat verify --network mainnet ${revenueRouter.address} "${WETH}" "${voter.address}"`);
  console.log(`npx hardhat verify --network mainnet ${multicall.address} "${voter.address}"`);

  return {
    bribeFactory: bribeFactory.address,
    strategyFactory: strategyFactory.address,
    governanceToken: governanceToken.address,
    voter: voter.address,
    revenueRouter: revenueRouter.address,
    multicall: multicall.address,
  };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
