const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Tests for ERC20Votes functionality in GovernanceToken
 * Verifies compatibility with Aragon, Tally, and other DAO frameworks
 */
describe("GovernanceToken - ERC20Votes Compatibility", function () {
    let owner, user1, user2, user3;
    let underlying, governanceToken;

    const parseEther = ethers.utils.parseEther;

    beforeEach(async function () {
        [owner, user1, user2, user3] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        underlying = await MockERC20.deploy("Underlying Token", "UNDER", 18);

        const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
        governanceToken = await GovernanceToken.deploy(underlying.address, "Staked Token", "sTOKEN");

        await underlying.mint(user1.address, parseEther("1000"));
        await underlying.mint(user2.address, parseEther("1000"));
        await underlying.mint(user3.address, parseEther("1000"));
    });

    async function stakeTokens(user, amount) {
        await underlying.connect(user).approve(governanceToken.address, amount);
        await governanceToken.connect(user).stake(amount);
    }

    describe("ERC20Votes Interface", function () {
        it("should have getVotes function", async function () {
            expect(governanceToken.getVotes).to.not.be.undefined;

            await stakeTokens(user1, parseEther("100"));

            // Must self-delegate to activate voting power
            await governanceToken.connect(user1).delegate(user1.address);

            const votes = await governanceToken.getVotes(user1.address);
            expect(votes).to.equal(parseEther("100"));
        });

        it("should have delegate function", async function () {
            expect(governanceToken.delegate).to.not.be.undefined;

            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user2.address);

            expect(await governanceToken.delegates(user1.address)).to.equal(user2.address);
            expect(await governanceToken.getVotes(user2.address)).to.equal(parseEther("100"));
            expect(await governanceToken.getVotes(user1.address)).to.equal(0);
        });

        it("should have delegates function", async function () {
            expect(governanceToken.delegates).to.not.be.undefined;

            await stakeTokens(user1, parseEther("100"));

            // Before delegation, delegates returns zero address
            expect(await governanceToken.delegates(user1.address)).to.equal(ethers.constants.AddressZero);

            await governanceToken.connect(user1).delegate(user1.address);
            expect(await governanceToken.delegates(user1.address)).to.equal(user1.address);
        });

        it("should have getPastVotes function for historical voting power", async function () {
            expect(governanceToken.getPastVotes).to.not.be.undefined;

            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user1.address);

            const blockBefore = await ethers.provider.getBlockNumber();

            // Stake more tokens
            await stakeTokens(user1, parseEther("50"));

            // Mine a block
            await ethers.provider.send("evm_mine");

            // Check historical voting power
            const pastVotes = await governanceToken.getPastVotes(user1.address, blockBefore);
            expect(pastVotes).to.equal(parseEther("100"));

            // Current votes should be higher
            const currentVotes = await governanceToken.getVotes(user1.address);
            expect(currentVotes).to.equal(parseEther("150"));
        });

        it("should have getPastTotalSupply function", async function () {
            expect(governanceToken.getPastTotalSupply).to.not.be.undefined;

            await stakeTokens(user1, parseEther("100"));
            const blockBefore = await ethers.provider.getBlockNumber();

            await stakeTokens(user2, parseEther("200"));
            await ethers.provider.send("evm_mine");

            const pastSupply = await governanceToken.getPastTotalSupply(blockBefore);
            expect(pastSupply).to.equal(parseEther("100"));

            const currentSupply = await governanceToken.totalSupply();
            expect(currentSupply).to.equal(parseEther("300"));
        });

        it("should have numCheckpoints function", async function () {
            expect(governanceToken.numCheckpoints).to.not.be.undefined;

            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user1.address);

            expect(await governanceToken.numCheckpoints(user1.address)).to.equal(1);

            await stakeTokens(user1, parseEther("50"));
            expect(await governanceToken.numCheckpoints(user1.address)).to.equal(2);
        });

        it("should have checkpoints function", async function () {
            expect(governanceToken.checkpoints).to.not.be.undefined;

            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user1.address);

            const checkpoint = await governanceToken.checkpoints(user1.address, 0);
            expect(checkpoint.votes).to.equal(parseEther("100"));
        });
    });

    describe("ERC20Permit Interface (Gasless Approvals)", function () {
        it("should have DOMAIN_SEPARATOR", async function () {
            expect(governanceToken.DOMAIN_SEPARATOR).to.not.be.undefined;
            const domainSeparator = await governanceToken.DOMAIN_SEPARATOR();
            expect(domainSeparator).to.not.equal(ethers.constants.HashZero);
        });

        it("should have nonces function", async function () {
            expect(governanceToken.nonces).to.not.be.undefined;
            expect(await governanceToken.nonces(user1.address)).to.equal(0);
        });
    });

    describe("Delegation Scenarios", function () {
        it("should allow self-delegation", async function () {
            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user1.address);

            expect(await governanceToken.getVotes(user1.address)).to.equal(parseEther("100"));
        });

        it("should allow delegating to another user", async function () {
            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user2.address);

            expect(await governanceToken.getVotes(user1.address)).to.equal(0);
            expect(await governanceToken.getVotes(user2.address)).to.equal(parseEther("100"));
        });

        it("should allow changing delegation", async function () {
            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user2.address);

            expect(await governanceToken.getVotes(user2.address)).to.equal(parseEther("100"));

            await governanceToken.connect(user1).delegate(user3.address);

            expect(await governanceToken.getVotes(user2.address)).to.equal(0);
            expect(await governanceToken.getVotes(user3.address)).to.equal(parseEther("100"));
        });

        it("should aggregate delegations from multiple users", async function () {
            await stakeTokens(user1, parseEther("100"));
            await stakeTokens(user2, parseEther("200"));

            await governanceToken.connect(user1).delegate(user3.address);
            await governanceToken.connect(user2).delegate(user3.address);

            expect(await governanceToken.getVotes(user3.address)).to.equal(parseEther("300"));
        });

        it("should update votes when staking more after delegation", async function () {
            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user1.address);

            expect(await governanceToken.getVotes(user1.address)).to.equal(parseEther("100"));

            await stakeTokens(user1, parseEther("50"));

            expect(await governanceToken.getVotes(user1.address)).to.equal(parseEther("150"));
        });

        it("should update votes when unstaking after delegation", async function () {
            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user1.address);

            expect(await governanceToken.getVotes(user1.address)).to.equal(parseEther("100"));

            await governanceToken.connect(user1).unstake(parseEther("30"));

            expect(await governanceToken.getVotes(user1.address)).to.equal(parseEther("70"));
        });
    });

    describe("Non-transferability preserved", function () {
        it("should still prevent transfers", async function () {
            await stakeTokens(user1, parseEther("100"));

            await expect(
                governanceToken.connect(user1).transfer(user2.address, parseEther("50"))
            ).to.be.revertedWith("GovernanceToken__TransferDisabled");
        });

        it("should still prevent transferFrom", async function () {
            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).approve(user2.address, parseEther("100"));

            await expect(
                governanceToken.connect(user2).transferFrom(user1.address, user2.address, parseEther("50"))
            ).to.be.revertedWith("GovernanceToken__TransferDisabled");
        });
    });

    describe("Aragon/Tally Compatibility Check", function () {
        it("should pass Tally compatibility requirements", async function () {
            // Tally requires:
            // 1. ERC20 interface ✓
            // 2. getVotes(address) ✓
            // 3. getPastVotes(address, uint256) ✓
            // 4. delegates(address) ✓
            // 5. delegate(address) ✓

            await stakeTokens(user1, parseEther("100"));
            await governanceToken.connect(user1).delegate(user1.address);

            // All required functions exist and work
            expect(await governanceToken.name()).to.equal("Staked Token");
            expect(await governanceToken.symbol()).to.equal("sTOKEN");
            expect(await governanceToken.decimals()).to.equal(18);
            expect(await governanceToken.totalSupply()).to.equal(parseEther("100"));
            expect(await governanceToken.balanceOf(user1.address)).to.equal(parseEther("100"));
            expect(await governanceToken.getVotes(user1.address)).to.equal(parseEther("100"));
            expect(await governanceToken.delegates(user1.address)).to.equal(user1.address);

            const block = await ethers.provider.getBlockNumber();
            await ethers.provider.send("evm_mine");
            expect(await governanceToken.getPastVotes(user1.address, block)).to.equal(parseEther("100"));
        });

        it("should support delegateBySig for gasless delegation", async function () {
            expect(governanceToken.delegateBySig).to.not.be.undefined;
        });
    });
});
