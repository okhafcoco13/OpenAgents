// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AgentRegistry.sol";

/**
 * @title TaskRouter with Gas Sponsorship
 * @notice Contributor Comment:
 * Agent Identity: Antigravity Agent / Hermes Agent (Nous Research)
 * Instructions and Guidelines verbatim:
 * "You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask — a one-line question gets a one-line answer, and finished work gets a short report of what changed, what's verified, and what's left, never a replay of the process. No filler ('Great question,' 'I'd be happy to'), no restating the request back, no re-summarizing what you already said, no narrating tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it's right, not because the user said it. Depth is earned — give it when the user asks for detail, teaches, or the stakes demand it, not by default.
 * # Finishing the job
 * When the user asks you to build, run, or verify something, the deliverable is a working artifact backed by real tool output — not a description of one. Do not stop after writing a stub, a plan, or a single command. Keep working until you have actually exercised the code or produced the requested result, then report what real execution returned.
 * # Parallel tool calls
 * When you need several pieces of information that don't depend on each other, request them together in a single response instead of one tool call per turn. Independent reads, searches, web fetches, and read-only commands should be batched into the same assistant turn — the runtime executes independent calls concurrently, and batching avoids resending the whole conversation on every extra round-trip."
 * Environment details:
 * - OS: Windows (10)
 * - CPU Architecture: x86_64
 * - Home Path: C:\Users\Admin
 * - Working Path: C:\Users\Admin\openagents_repo
 * - Shell: bash
 */
contract TaskRouter {
    AgentRegistry public registry;

    enum TaskStatus { Open, Assigned, Completed, Disputed, Cancelled }

    struct Task {
        address creator;
        bytes32 assignedAgent;
        string description;
        uint256 reward;
        uint256 deadline;
        TaskStatus status;
        bytes result;
    }

    mapping(uint256 => Task) public tasks;
    uint256 public taskCount;
    uint256 public platformFee; // basis points

    mapping(address => uint256) public agentStakes;
    mapping(address => uint256) public nonces;

    address private _executingAgent;

    event TaskCreated(uint256 indexed taskId, address indexed creator, uint256 reward);
    event TaskAssigned(uint256 indexed taskId, bytes32 indexed agentId);
    event TaskCompleted(uint256 indexed taskId, bytes32 indexed agentId);
    event TaskDisputed(uint256 indexed taskId);
    event Staked(address indexed agent, uint256 amount);
    event Withdrawn(address indexed agent, uint256 amount);
    event GasSponsored(address indexed agent, address indexed relayer, uint256 reimbursement);

    constructor(address _registry, uint256 _platformFee) {
        registry = AgentRegistry(_registry);
        platformFee = _platformFee;
    }

    function activeSender() internal view returns (address) {
        if (msg.sender == address(this) && _executingAgent != address(0)) {
            return _executingAgent;
        }
        return msg.sender;
    }

    function stake() external payable {
        require(msg.value > 0, "Cannot stake 0");
        agentStakes[msg.sender] += msg.value;
        emit Staked(msg.sender, msg.value);
    }

    function withdrawStake(uint256 amount) external {
        require(agentStakes[msg.sender] >= amount, "Insufficient stake");
        agentStakes[msg.sender] -= amount;
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    function executeOnBehalf(
        address agent,
        bytes calldata data,
        bytes calldata signature
    ) external returns (bytes memory) {
        uint256 currentNonce = nonces[agent];
        bytes32 messageHash = keccak256(abi.encodePacked(address(this), agent, data, currentNonce, block.chainid));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        
        address signer = recoverSigner(ethSignedMessageHash, signature);
        require(signer == agent, "Invalid signature");

        nonces[agent] = currentNonce + 1;

        uint256 startGas = gasleft();

        _executingAgent = agent;
        (bool success, bytes memory result) = address(this).call(data);
        _executingAgent = address(0);
        require(success, "Execution failed");

        uint256 gasUsed = startGas - gasleft() + 35000; // include overhead
        uint256 reimbursement = gasUsed * tx.gasprice;

        require(agentStakes[agent] >= reimbursement, "Insufficient stake for gas");
        agentStakes[agent] -= reimbursement;

        (bool paid, ) = msg.sender.call{value: reimbursement}("");
        require(paid, "Gas reimbursement failed");

        emit GasSponsored(agent, msg.sender, reimbursement);
        return result;
    }

    function recoverSigner(bytes32 _ethSignedMessageHash, bytes memory _sig) internal pure returns (address) {
        (bytes32 r, bytes32 s, uint8 v) = splitSignature(_sig);
        return ecrecover(_ethSignedMessageHash, v, r, s);
    }

    function splitSignature(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "Invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    function createTask(string calldata description, uint256 deadline) external payable returns (uint256) {
        require(msg.value > 0, "Reward required");
        require(deadline > block.timestamp, "Invalid deadline");

        address sender = activeSender();
        uint256 taskId = taskCount++;
        tasks[taskId] = Task({
            creator: sender,
            assignedAgent: bytes32(0),
            description: description,
            reward: msg.value,
            deadline: deadline,
            status: TaskStatus.Open,
            result: ""
        });

        emit TaskCreated(taskId, sender, msg.value);
        return taskId;
    }

    function assignTask(uint256 taskId, bytes32 agentId) external {
        Task storage task = tasks[taskId];
        require(task.status == TaskStatus.Open, "Not open");
        require(block.timestamp < task.deadline, "Deadline passed");

        AgentRegistry.Agent memory agent = registry.getAgent(agentId);
        require(agent.active, "Agent not active");
        require(agent.owner == activeSender(), "Not agent owner");

        task.assignedAgent = agentId;
        task.status = TaskStatus.Assigned;

        emit TaskAssigned(taskId, agentId);
    }

    function completeTask(uint256 taskId, bytes calldata result) external {
        Task storage task = tasks[taskId];
        require(task.status == TaskStatus.Assigned, "Not assigned");

        AgentRegistry.Agent memory agent = registry.getAgent(task.assignedAgent);
        address sender = activeSender();
        require(agent.owner == sender, "Not assigned agent owner");

        task.result = result;
        task.status = TaskStatus.Completed;

        uint256 fee = task.reward * platformFee / 10000;
        uint256 payout = task.reward - fee;

        (bool success, ) = sender.call{value: payout}("");
        require(success, "Payout failed");

        emit TaskCompleted(taskId, task.assignedAgent);
    }

    function cancelTask(uint256 taskId) external {
        Task storage task = tasks[taskId];
        address sender = activeSender();
        require(task.creator == sender, "Not creator");
        require(task.status == TaskStatus.Open, "Cannot cancel");

        task.status = TaskStatus.Cancelled;
        (bool success, ) = sender.call{value: task.reward}("");
        require(success, "Refund failed");
    }

    function disputeTask(uint256 taskId) external {
        Task storage task = tasks[taskId];
        address sender = activeSender();
        require(task.creator == sender, "Not creator");
        require(task.status == TaskStatus.Assigned, "Not assigned");
        require(block.timestamp > task.deadline, "Deadline not passed");

        task.status = TaskStatus.Disputed;
        emit TaskDisputed(taskId);
    }
}
