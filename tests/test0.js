const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { execPath } = require("process");

const AddressZero = "0x0000000000000000000000000000000000000000";
const AddressDead = "0x000000000000000000000000000000000000dEaD";

let owner, multisig, treasury, user0, user1, user2, user3;
let weth, donut, miner, multicall;
let auction0, auction1;

describe("local: test0", function () {
  before("Initial set up", async function () {
    console.log("Begin Initialization");

    [owner, multisig, treasury, user0, user1, user2, user3] =
      await ethers.getSigners();

    const wethArtifact = await ethers.getContractFactory("Base");
    weth = await wethArtifact.deploy();
    console.log("- WETH Initialized");

    const minerArtifact = await ethers.getContractFactory("Miner");
    miner = await minerArtifact.deploy(weth.address, treasury.address);
    console.log("- Miner Initialized");

    donut = await ethers.getContractAt(
      "contracts/Miner.sol:Donut",
      await miner.donut()
    );
    console.log("- DONUT Initialized");

    const auctionArtifact = await ethers.getContractFactory("Auction");
    auction0 = await auctionArtifact.deploy(
      convert("0.001", 18),
      await miner.donut(),
      AddressZero,
      604800,
      convert("1.2", 18),
      convert("0.001", 18)
    );
    console.log("- Auction0 Initialized");
    auction1 = await auctionArtifact.deploy(
      convert("0.001", 18),
      await miner.donut(),
      AddressDead,
      604800,
      convert("1.2", 18),
      convert("0.001", 18)
    );
    console.log("- Auction1 Initialized");

    const multicallArtifact = await ethers.getContractFactory("Multicall");
    multicall = await multicallArtifact.deploy(miner.address);
    console.log("- Multicall Initialized");

    await multicall.transferOwnership(multisig.address);
    console.log("- ownership transferred to multisig");

    await multicall.connect(multisig).setAuction(auction0.address);
    console.log("- auction0 set to multicall");

    console.log("Initialization Complete");
    console.log();
  });

  it("transfer ownership to multisig", async function () {
    console.log("******************************************************");
    await miner.transferOwnership(multisig.address);
    console.log("- ownership transferred to multisig");
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user0.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        AddressZero,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user0.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("Forward time", async function () {
    console.log("******************************************************");
    await network.provider.send("evm_increaseTime", [604800]);
    await network.provider.send("evm_mine");
    console.log("- time forwarded");
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user0.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        AddressZero,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user0.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("Set treasury to auction", async function () {
    console.log("******************************************************");
    await miner.connect(multisig).setTreasury(auction0.address);
    console.log("- treasury set to auction0");
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        AddressZero,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        AddressZero,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        AddressZero,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user0.address);
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        AddressZero,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        user0.address,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user0.address);
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user0.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("Forward time", async function () {
    console.log("******************************************************");
    await network.provider.send("evm_increaseTime", [3000]);
    await network.provider.send("evm_mine");
    console.log("- time forwarded");
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user0.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("User1 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user1)
      .mine(
        AddressZero,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user1.address);
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user1.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("Forward time", async function () {
    console.log("******************************************************");
    await network.provider.send("evm_increaseTime", [3000]);
    await network.provider.send("evm_mine");
    console.log("- time forwarded");
  });

  it("User2 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user2)
      .mine(
        AddressZero,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user2.address);
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user2.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("Forward time", async function () {
    console.log("******************************************************");
    await network.provider.send("evm_increaseTime", [86400 * 30]);
    await network.provider.send("evm_mine");
    console.log("- time forwarded");
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user2.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        user1.address,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user0.address);
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user0.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("buy from auction", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(user0.address);
    console.log(res);
    await multicall.connect(user0).buy(res.epochId, 1861439882, 0);
  });

  it("Auction state", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(AddressZero);
    console.log(res);
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        user1.address,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user0.address);
  });

  it("Auction state", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(AddressZero);
    console.log(res);
  });

  it("buy from auction", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(user0.address);
    console.log(res);
    await donut.connect(user0).approve(multicall.address, res.price);
    await expect(
      multicall.connect(user0).buy(res.epochId, 1861439882, res.price)
    ).to.be.reverted;
  });

  it("Set treasury to auction", async function () {
    console.log("******************************************************");
    await miner.connect(multisig).setTreasury(auction1.address);
    await multicall.connect(multisig).setAuction(auction1.address);
    console.log("- auction set to auction1");
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        user1.address,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user0.address);
  });

  it("Auction state", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(AddressZero);
    console.log(res);
  });

  it("buy from auction", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(user0.address);
    console.log(res);
    await multicall.connect(user0).buy(res.epochId, 1861439882, 0);
  });

  it("Auction state", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(AddressZero);
    console.log(res);
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        user1.address,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user0.address);
  });

  it("Auction state", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(AddressZero);
    console.log(res);
  });

  it("buy from auction", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(user3.address);
    console.log(res);
    await donut.connect(user0).transfer(user3.address, res.price);
    await donut.connect(user3).approve(multicall.address, res.price);
    await multicall.connect(user3).buy(res.epochId, 1861439882, res.price);
  });

  it("Auction state", async function () {
    console.log("******************************************************");
    let res = await multicall.getAuction(AddressZero);
    console.log(res);
  });

  it("Donut balance in Dead Address", async function () {
    console.log("******************************************************");
    let res = await donut.balanceOf(AddressDead);
    console.log("Donut balance in Dead Address: ", divDec(res));
  });

  it("WETH balance in User3 Address", async function () {
    console.log("******************************************************");
    let res = await weth.balanceOf(user3.address);
    console.log("WETH balance in User3 Address: ", divDec(res));
  });

  it("Forward time", async function () {
    console.log("******************************************************");
    await network.provider.send("evm_increaseTime", [86400 * 500]);
    await network.provider.send("evm_mine");
    console.log("- time forwarded");
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        user1.address,
        res.epochId,
        1861439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user0.address);
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user0.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });

  it("Forward time", async function () {
    console.log("******************************************************");
    await network.provider.send("evm_increaseTime", [86400 * 1000]);
    await network.provider.send("evm_mine");
    console.log("- time forwarded");
  });

  it("User0 mines", async function () {
    console.log("******************************************************");
    let res = await multicall.getMiner(AddressZero);
    await multicall
      .connect(user0)
      .mine(
        user1.address,
        res.epochId,
        1961439882,
        res.price,
        "https://example.com",
        {
          value: res.price,
        }
      );
    res = await multicall.getMiner(AddressZero);
    expect(res.miner).to.equal(user0.address);
  });

  it("Miner state", async function () {
    console.log("******************************************************");
    const minerStateUser = await multicall.getMiner(user0.address);
    const minerStateTreasury = await multicall.getMiner(treasury.address);
    const { timestamp } = await ethers.provider.getBlock("latest");
    console.log("Day: ", (timestamp - (await miner.startTime())) / 86400);
    console.log("Price: ", divDec(minerStateUser.price));
    console.log("DPS: ", divDec(minerStateUser.nextDps));
    console.log("User DONUT balance: ", divDec(minerStateUser.donutBalance));
    console.log("User ETH balance: ", divDec(minerStateUser.ethBalance));
    console.log(
      "Treasury ETH balance: ",
      divDec(minerStateTreasury.ethBalance)
    );
  });
});
