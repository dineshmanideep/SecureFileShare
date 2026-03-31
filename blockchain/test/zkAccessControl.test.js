const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FileAccessControl ZK policy (Semaphore-gated)", function () {
  it("validates proof without persisting per-wallet ZK state", async function () {
    const [owner, issuer, recipient] = await ethers.getSigners();

    const MockSemaphore = await ethers.getContractFactory("MockSemaphore");
    const mockSemaphore = await MockSemaphore.deploy();
    await mockSemaphore.waitForDeployment();

    const FileAccessControl = await ethers.getContractFactory("FileAccessControl");
    const ac = await FileAccessControl.deploy(await mockSemaphore.getAddress());
    await ac.waitForDeployment();

    // Make issuer a trusted issuer (for completeness; not required for this test).
    await (await ac.setTrustedIssuer(issuer.address, true)).wait();

    // Owner registers file ownership.
    const fileId = 1;
    await (await ac.connect(owner).registerFileOwner(fileId)).wait();

    // Owner grants explicit access to recipient.
    await (await ac.connect(owner).grantAccess(fileId, recipient.address, [])).wait();

    // Enable ZK policy on the file (groupId arbitrary in mock).
    await (await ac.connect(owner).defineZkPolicy(fileId, 0, true)).wait();

    // Access control no longer depends on persisted per-wallet ZK verification state.
    expect(await ac.checkAccess(recipient.address, fileId)).to.equal(true);

    // Build a dummy proof with file-bound message and arbitrary non-zero scope.
    const expectedMessage = ethers.keccak256(
      ethers.solidityPacked(["uint256"], [fileId])
    );

    const proof = {
      merkleTreeDepth: 20,
      merkleTreeRoot: 1,
      nullifier: 123,
      message: BigInt(expectedMessage).toString(),
      scope: 999,
      points: [0, 0, 0, 0, 0, 0, 0, 0],
    };

    await (await ac.connect(recipient).verifyZkAccess(fileId, proof)).wait();

    // Access state remains unchanged (still requires explicit grant/ABAC rules).
    expect(await ac.checkAccess(recipient.address, fileId)).to.equal(true);
  });
});

