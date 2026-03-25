"use strict";

const express = require("express");
const path = require("path");
const { authMiddleware } = require("../middleware/auth");
const materialsSvc = require("../services/materialsService");
const { ethers } = require("ethers");

const router = express.Router();

// Helpers copied (lightly) from routes/access.js
function getReadProvider() {
    const rpcUrl = process.env.HARDHAT_RPC_URL || "http://127.0.0.1:8545";
    return new ethers.providers.JsonRpcProvider(rpcUrl);
}

function getContractAt(address, abiPath, provider) {
    const artifact = require(abiPath);
    return new ethers.Contract(address, artifact.abi || artifact, provider);
}

const ARTIFACTS_ROOT = path.join(__dirname, "..", "..", "blockchain", "artifacts", "contracts");
const ADDRESSES = require("../../blockchain/deployed_addresses.json").contracts;

/**
 * POST /api/materials/register
 * Links a pending upload (identified by fileHashHex) to its on-chain fileId.
 * The AES key is never sent from the client — only the hash is used as a lookup key.
 *
 * Body:
 *  - fileId      (number|string) – on-chain file ID from FileRegistry.uploadFile()
 *  - fileHashHex (string)        – SHA-256 hex of the original file (from /api/upload response)
 */
router.post("/register", authMiddleware, async (req, res) => {
    try {
        const { fileId, fileHashHex } = req.body || {};
        if (fileId === undefined || fileId === null) {
            return res.status(400).json({ error: "fileId required" });
        }
        if (!Number.isInteger(Number(fileId)) || Number(fileId) < 0) {
            return res.status(400).json({ error: "fileId must be a non-negative integer" });
        }
        if (!fileHashHex || typeof fileHashHex !== "string" || !/^[0-9a-f]{64}$/i.test(fileHashHex)) {
            return res.status(400).json({ error: "fileHashHex required (must be 64 hex characters)" });
        }

        // Authorize: only the on-chain owner can register materials for this fileId.
        const provider = getReadProvider();
        const accessControl = getContractAt(
            ADDRESSES.FileAccessControl,
            path.join(ARTIFACTS_ROOT, "AccessControl.sol", "FileAccessControl.json"),
            provider
        );
        const owner = await accessControl.getFileOwner(fileId);
        if (!owner || owner.toLowerCase() !== req.verifiedAddress.toLowerCase()) {
            console.warn(`[materials/register] Authorization denied: user=${req.verifiedAddress} file=${fileId}`);
            return res.status(403).json({ error: "Only file owner can register materials" });
        }

        // Promote pending materials to permanent record
        const promoted = materialsSvc.promotePendingToFileId(fileHashHex, fileId, owner);
        if (!promoted) {
            return res.status(404).json({
                error: "No pending upload found for this fileHashHex. It may have expired (>30 min) or already been registered.",
            });
        }

        return res.json({ success: true });
    } catch (err) {
        // Log error details server-side only
        if (err.message.includes("RPC") || err.message.includes("Contract")) {
            console.error("[materials/register] Contract/RPC error (stack logged server-side)");
            return res.status(500).json({ error: "Contract verification failed. Check RPC connection." });
        }
        console.error("[materials/register] Processing error (stack logged server-side)");
        return res.status(500).json({ error: "Material registration failed. Please try again." });
    }
});

module.exports = router;

