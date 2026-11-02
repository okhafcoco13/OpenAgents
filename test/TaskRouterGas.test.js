const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TaskRouter Gas Sponsorship", function () {
  let agentRegistry, taskRouter;
  let owner, creator, agentSigner, relayer;
  let agentId, taskId;

  beforeEach(async function () {
    [owner, creator, agentSigner, relayer] = await ethers.getSigners();

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

    // Creator creates a task
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createTx = await taskRouter.connect(creator).createTask("Sample task", deadline, { value: ethers.parseEther("1.0") });
    await createTx.wait();
    taskId = 0;
  });

  it("should allow agent to stake and execute assignTask on behalf via relayer", async function () {
    // Agent stakes ETH for gas sponsorship
    await taskRouter.connect(agentSigner).stake({ value: ethers.parseEther("1.0") });
    expect(await taskRouter.agentStakes(agentSigner.address)).to.equal(ethers.parseEther("1.0"));

    // Prepare assignTask call data
    const assignTaskData = taskRouter.interface.encodeFunctionData("assignTask", [taskId, agentId]);

    // Sign message
    const nonce = await taskRouter.nonces(agentSigner.address);
    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId;

    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "address", "bytes", "uint256", "uint256"],
      [await taskRouter.getAddress(), agentSigner.address, assignTaskData, nonce, chainId]
    );
    const signature = await agentSigner.signMessage(ethers.getBytes(messageHash));

    // Relayer executes on behalf (agent holds 0 ETH for gas)
    const tx = await taskRouter.connect(relayer).executeOnBehalf(agentSigner.address, assignTaskData, signature);
    await tx.wait();

    // Verify task assigned
    const task = await taskRouter.tasks(taskId);
    expect(task.assignedAgent).to.equal(agentId);
    expect(task.status).to.equal(1n); // Assigned

    // Verify nonce incremented
    expect(await taskRouter.nonces(agentSigner.address)).to.equal(1n);
  });

  it("should prevent replay attacks with nonce", async function () {
    await taskRouter.connect(agentSigner).stake({ value: ethers.parseEther("1.0") });

    const assignTaskData = taskRouter.interface.encodeFunctionData("assignTask", [taskId, agentId]);

    const nonce = await taskRouter.nonces(agentSigner.address);
    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId;

    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "address", "bytes", "uint256", "uint256"],
      [await taskRouter.getAddress(), agentSigner.address, assignTaskData, nonce, chainId]
    );
    const signature = await agentSigner.signMessage(ethers.getBytes(messageHash));

    // First execution succeeds
    await taskRouter.connect(relayer).executeOnBehalf(agentSigner.address, assignTaskData, signature);

    // Second execution with same signature/nonce should fail
    await expect(
      taskRouter.connect(relayer).executeOnBehalf(agentSigner.address, assignTaskData, signature)
    ).to.be.revertedWith("Invalid signature");
  });

  it("should fail when agent has insufficient stake", async function () {
    // 0 stake
    const assignTaskData = taskRouter.interface.encodeFunctionData("assignTask", [taskId, agentId]);

    const nonce = await taskRouter.nonces(agentSigner.address);
    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId;

    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "address", "bytes", "uint256", "uint256"],
      [await taskRouter.getAddress(), agentSigner.address, assignTaskData, nonce, chainId]
    );
    const signature = await agentSigner.signMessage(ethers.getBytes(messageHash));

    await expect(
      taskRouter.connect(relayer).executeOnBehalf(agentSigner.address, assignTaskData, signature)
    ).to.be.revertedWith("Insufficient stake for gas");
  });
});
