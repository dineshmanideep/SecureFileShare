"use strict";

const express = require("express");
const path = require("path");
const { ethers } = require("ethers");

const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

const ADDRESSES = require("../../blockchain/deployed_addresses.json").contracts;

function getProvider() {
    const rpcUrl = process.env.HARDHAT_RPC_URL || "http://127.0.0.1:8545";
    return new ethers.providers.JsonRpcProvider(rpcUrl);
}

function getSemaphore(providerOrSigner) {
    const artifactPath = path.join(
        __dirname,
        "..",
        "..",
        "blockchain",
        "artifacts",
        "@semaphore-protocol",
        "contracts",
        "Semaphore.sol",
        "Semaphore.json"
    );
    const artifact = require(artifactPath);
    return new ethers.Contract(ADDRESSES.Semaphore, artifact.abi || artifact, providerOrSigner);
}

function getFileRegistry(providerOrSigner) {
    const artifactPath = path.join(
        __dirname,
        "..",
        "..",
        "blockchain",
        "artifacts",
        "contracts",
        "FileRegistry.sol",
        "FileRegistry.json"
    );
    const artifact = require(artifactPath);
    return new ethers.Contract(ADDRESSES.FileRegistry, artifact.abi || artifact, providerOrSigner);
}

function getAccessControl(providerOrSigner) {
    const artifactPath = path.join(
        __dirname,
        "..",
        "..",
        "blockchain",
        "artifacts",
        "contracts",
        "AccessControl.sol",
        "FileAccessControl.json"
    );
    const artifact = require(artifactPath);
    return new ethers.Contract(ADDRESSES.FileAccessControl, artifact.abi || artifact, providerOrSigner);
}

function normalizeProof(proof) {
    if (!proof || typeof proof !== "object") {
        throw new Error("proof is required");
    }

    const points = Array.isArray(proof.points) ? proof.points.map((p) => String(p)) : [];
    if (points.length !== 8) {
        throw new Error("proof.points must contain 8 values");
    }

    return {
        merkleTreeDepth: Number(proof.merkleTreeDepth),
        merkleTreeRoot: String(proof.merkleTreeRoot),
        nullifier: String(proof.nullifier),
        message: String(proof.message),
        scope: String(proof.scope),
        points,
    };
}

router.post("/validate-proof", authMiddleware, async (req, res) => {
    try {
        const relayerPrivateKey = (
            process.env.ZK_RELAYER_PRIVATE_KEY ||
            process.env.RELAYER_PRIVATE_KEY ||
            ""
        ).trim();

        if (!relayerPrivateKey) {
            return res.status(503).json({
                error: "ZK relayer is not configured (missing ZK_RELAYER_PRIVATE_KEY)",
            });
        }

        const { groupId, proof, fileId } = req.body || {};

        if (!/^\d+$/.test(String(groupId || ""))) {
            return res.status(400).json({ error: "groupId must be a uint256 numeric string" });
        }
        if (fileId === undefined || fileId === null || !Number.isInteger(Number(fileId)) || Number(fileId) < 0) {
            return res.status(400).json({ error: "fileId must be a non-negative integer" });
        }

        const normalizedProof = normalizeProof(proof);

        const expectedMessage = ethers.BigNumber.from(
            ethers.utils.solidityKeccak256(["uint256"], [Number(fileId)])
        ).toString();
        if (String(normalizedProof.message) !== expectedMessage) {
            return res.status(400).json({ error: "proof.message does not match expected file-bound payload" });
        }
        if (String(normalizedProof.scope) === "0") {
            return res.status(400).json({ error: "proof.scope must be non-zero" });
        }

        let wallet;
        try {
            wallet = new ethers.Wallet(relayerPrivateKey, getProvider());
        } catch {
            return res.status(500).json({ error: "Invalid relayer private key format" });
        }

        const semaphore = getSemaphore(wallet);
        const tx = await semaphore.validateProof(ethers.BigNumber.from(String(groupId)), normalizedProof);
        const receipt = await tx.wait();

        return res.json({
            success: true,
            txHash: tx.hash,
            blockNumber: receipt?.blockNumber || null,
            relayedBy: wallet.address,
        });
    } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("insufficient funds")) {
            return res.status(503).json({ error: "Relayer has insufficient funds" });
        }
        if (msg.includes("nullifier") || msg.includes("already")) {
            return res.status(400).json({ error: "Proof rejected (nullifier already used or invalid)" });
        }
        return res.status(500).json({ error: "Relayer proof validation failed" });
    }
});

router.post("/register-zk-file", authMiddleware, async (req, res) => {
    try {
        const relayerPrivateKey = (
            process.env.ZK_RELAYER_PRIVATE_KEY ||
            process.env.RELAYER_PRIVATE_KEY ||
            ""
        ).trim();

        if (!relayerPrivateKey) {
            return res.status(503).json({
                error: "ZK relayer is not configured (missing ZK_RELAYER_PRIVATE_KEY)",
            });
        }

        const { cids, fileHashHex, fileName, fileSize, groupId } = req.body || {};

        if (!Array.isArray(cids) || cids.length === 0) {
            return res.status(400).json({ error: "cids must be a non-empty array" });
        }
        if (!fileHashHex || !/^(0x)?[0-9a-fA-F]{64}$/.test(String(fileHashHex))) {
            return res.status(400).json({ error: "fileHashHex must be a 32-byte hex string" });
        }
        if (!fileName || !String(fileName).trim()) {
            return res.status(400).json({ error: "fileName is required" });
        }
        if (!Number.isInteger(Number(fileSize)) || Number(fileSize) < 0) {
            return res.status(400).json({ error: "fileSize must be a non-negative integer" });
        }
        if (!/^\d+$/.test(String(groupId || ""))) {
            return res.status(400).json({ error: "groupId must be a uint256 numeric string" });
        }

        let wallet;
        try {
            wallet = new ethers.Wallet(relayerPrivateKey, getProvider());
        } catch {
            return res.status(500).json({ error: "Invalid relayer private key format" });
        }

        const fileRegistry = getFileRegistry(wallet);
        const accessControl = getAccessControl(wallet);
        const normalizedHash = String(fileHashHex).startsWith("0x")
            ? String(fileHashHex)
            : `0x${String(fileHashHex)}`;

        const uploadTx = await fileRegistry.uploadFile(
            cids,
            normalizedHash,
            String(fileName),
            Number(fileSize)
        );
        const uploadReceipt = await uploadTx.wait();
        const uploadedEvent = uploadReceipt?.events?.find?.((e) => e.event === "FileUploaded");
        const fileId = uploadedEvent?.args?.fileId?.toString?.();
        if (!fileId) {
            return res.status(500).json({ error: "Relayer upload did not emit fileId" });
        }

        const ownerTx = await accessControl.registerFileOwner(fileId);
        await ownerTx.wait();

        const zkPolicyTx = await accessControl.defineZkPolicy(fileId, String(groupId), true);
        await zkPolicyTx.wait();

        return res.json({
            success: true,
            fileId,
            uploadTxHash: uploadTx.hash,
            registerOwnerTxHash: ownerTx.hash,
            defineZkPolicyTxHash: zkPolicyTx.hash,
            relayedBy: wallet.address,
        });
    } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("insufficient funds")) {
            return res.status(503).json({ error: "Relayer has insufficient funds" });
        }
        return res.status(500).json({ error: "Relayer ZK file registration failed" });
    }
});

router.post("/create-zk-group", authMiddleware, async (req, res) => {
    try {
        const relayerPrivateKey = (
            process.env.ZK_RELAYER_PRIVATE_KEY ||
            process.env.RELAYER_PRIVATE_KEY ||
            ""
        ).trim();

        if (!relayerPrivateKey) {
            return res.status(503).json({
                error: "ZK relayer is not configured (missing ZK_RELAYER_PRIVATE_KEY)",
            });
        }

        const { merkleTreeDuration, leaderCommitment } = req.body || {};

        if (!Number.isInteger(Number(merkleTreeDuration)) || Number(merkleTreeDuration) <= 0) {
            return res.status(400).json({ error: "merkleTreeDuration must be a positive integer" });
        }
        if (!/^\d+$/.test(String(leaderCommitment || ""))) {
            return res.status(400).json({ error: "leaderCommitment must be a uint256 numeric string" });
        }

        let wallet;
        try {
            wallet = new ethers.Wallet(relayerPrivateKey, getProvider());
        } catch {
            return res.status(500).json({ error: "Invalid relayer private key format" });
        }

        const accessControl = getAccessControl(wallet);
        const tx = await accessControl.createZkGroupWithLeader(
            Number(merkleTreeDuration),
            String(leaderCommitment)
        );
        const receipt = await tx.wait();

        const event = receipt?.events?.find?.((e) => e.event === "ZkGroupCreated");
        const groupId = event?.args?.groupId?.toString?.();

        if (!groupId) {
            return res.status(500).json({ error: "Relayer create group did not emit groupId" });
        }

        return res.json({
            success: true,
            groupId,
            txHash: tx.hash,
            blockNumber: receipt?.blockNumber || null,
            relayedBy: wallet.address,
        });
    } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("insufficient funds")) {
            return res.status(503).json({ error: "Relayer has insufficient funds" });
        }
        return res.status(500).json({ error: "Relayer create ZK group failed" });
    }
});

router.post("/add-zk-member", authMiddleware, async (req, res) => {
    try {
        const relayerPrivateKey = (
            process.env.ZK_RELAYER_PRIVATE_KEY ||
            process.env.RELAYER_PRIVATE_KEY ||
            ""
        ).trim();

        if (!relayerPrivateKey) {
            return res.status(503).json({
                error: "ZK relayer is not configured (missing ZK_RELAYER_PRIVATE_KEY)",
            });
        }

        const { groupId, identityCommitment, leaderProof, nonce, deadline } = req.body || {};

        if (!/^\d+$/.test(String(groupId || ""))) {
            return res.status(400).json({ error: "groupId must be a uint256 numeric string" });
        }
        if (!/^\d+$/.test(String(identityCommitment || ""))) {
            return res.status(400).json({ error: "identityCommitment must be a uint256 numeric string" });
        }
        if (!/^\d+$/.test(String(nonce || ""))) {
            return res.status(400).json({ error: "nonce must be a uint256 numeric string" });
        }
        if (!/^\d+$/.test(String(deadline || ""))) {
            return res.status(400).json({ error: "deadline must be a uint256 unix timestamp" });
        }

        const normalizedProof = normalizeProof(leaderProof);

        let wallet;
        try {
            wallet = new ethers.Wallet(relayerPrivateKey, getProvider());
        } catch {
            return res.status(500).json({ error: "Invalid relayer private key format" });
        }

        const accessControl = getAccessControl(wallet);
        const tx = await accessControl.relayedAddZkGroupMember(
            String(groupId),
            String(identityCommitment),
            normalizedProof,
            String(nonce),
            String(deadline)
        );
        const receipt = await tx.wait();

        return res.json({
            success: true,
            txHash: tx.hash,
            blockNumber: receipt?.blockNumber || null,
            relayedBy: wallet.address,
        });
    } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("insufficient funds")) {
            return res.status(503).json({ error: "Relayer has insufficient funds" });
        }
        if (msg.includes("leader proof") || msg.includes("relayer") || msg.includes("configured") || msg.includes("used")) {
            return res.status(400).json({ error: msg });
        }
        return res.status(500).json({ error: "Relayer add member failed" });
    }
});

module.exports = router;
