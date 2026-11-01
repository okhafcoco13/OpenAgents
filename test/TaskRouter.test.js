const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TaskRouter Gas Sponsorship", function () {
  let agentRegistry, taskRouter;
  let owner, agentSigner, relayer, other;
  let agentId;

  beforeEach(async function () {
    [owner, agentSigner, relayer, other] = await ethers.getSigners();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await AgentRegistry.deploy(0);
    await agentRegistry.waitForDeployment();

    const TaskRouter = await ethers.getContractFactory("TaskRouter");
    taskRouter = await TaskRouter.deploy(await agentRegistry.getAddress(), 100); // 1% fee
    await taskRouter.waitForDeployment();

    // Register agent
    const tx = await agentRegistry.connect(agentSigner).registerAgent("TestAgent", "http://agent.endpoint");
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => {
      try {
        return agentRegistry.interface.parseLog(l).name === "AgentRegistered";
      } catch {
        return false;
      }
    });
    agentId = agentRegistry.interface.parseLog(event).args.agentId;
  });

  it("should allow agent to stake and execute on behalf via relayer", async function () {
    // Agent stakes ETH
    await taskRouter.connect(agentSigner).stake({ value: ethers.parseEther("1.0") });
    expect(await taskRouter.agentStakes(agentSigner.address)).to.equal(ethers.parseEther("1.0"));

    // Prepare createTask call data
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createTaskData = taskRouter.interface.encodeFunctionData("createTask", ["Test task description", deadline]);

    // Sign message
    const nonce = await taskRouter.nonces(agentSigner.address);
    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId;

    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "address", "bytes", "uint256", "uint256"],
      [await taskRouter.getAddress(), agentSigner.address, createTaskData, nonce, chainId]
    );
    const signature = await agentSigner.signMessage(ethers.getBytes(messageHash));

    const relayerBalanceBefore = await ethers.provider.getBalance(relayer.address);

    // Relayer executes on behalf
    const tx = await taskRouter.connect(relayer).executeOnBehalf(agentSigner.address, createTaskData, signature);
    await tx.wait();

    // Verify task created
    expect(await taskRouter.taskCount()).to.equal(1n);
    const task = await taskRouter.tasks(0);
    expect(task.creator).to.equal(agentSigner.address);
    expect(task.description).to.equal("Test task description");

    // Verify nonce incremented
    expect(await taskRouter.nonces(agentSigner.address)).to.equal(1n);
  });

  it("should prevent replay attacks with nonce", async function () {
    await taskRouter.connect(agentSigner).stake({ value: ethers.parseEther("1.0") });

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createTaskData = taskRouter.interface.encodeFunctionData("createTask", ["Replay test", deadline]);

    const nonce = await taskRouter.nonces(agentSigner.address);
    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId;

    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "address", "bytes", "uint256", "uint256"],
      [await taskRouter.getAddress(), agentSigner.address, createTaskData, nonce, chainId]
    );
    const signature = await agentSigner.signMessage(ethers.getBytes(messageHash));

    // First execution succeeds
    await taskRouter.connect(relayer).executeOnBehalf(agentSigner.address, createTaskData, signature);

    // Second execution with same signature/nonce should fail
    await expect(
      taskRouter.connect(relayer).executeOnBehalf(agentSigner.address, createTaskData, signature)
    ).to.be.revertedWith("Invalid signature");
  });

  it("should fail when agent has insufficient stake", async function () {
    // 0 stake
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createTaskData = taskRouter.interface.encodeFunctionData("createTask", ["Insufficient stake test", deadline]);

    const nonce = await taskRouter.nonces(agentSigner.address);
    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId;

    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "address", "bytes", "uint256", "uint256"],
      [await taskRouter.getAddress(), agentSigner.address, createTaskData, nonce, chainId]
    );
    const signature = await agentSigner.signMessage(ethers.getBytes(messageHash));

    await expect(
      taskRouter.connect(relayer).executeOnBehalf(agentSigner.address, createTaskData, signature)
    ).to.be.revertedWith("Insufficient stake for gas");
  });
});
