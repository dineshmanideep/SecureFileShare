"use strict";

const express = require("express");
const multer = require("multer");
const path = require("path");
const { ethers } = require("ethers");

const { authMiddleware } = require("../middleware/auth");
const encSvc = require("../services/encryptionService");
const ipfsSvc = require("../services/ipfsService");
const gdprSvc = require("../services/gdprService");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const PENDING_TTL_MS = 30 * 60 * 1000;
const pendingZkUploads = new Map(); // fileHashHex -> { materials, metadata, expiresAt }

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pendingZkUploads) {
        if (now > entry.expiresAt) pendingZkUploads.delete(key);
    }
}, 5 * 60 * 1000).unref();

function normalizeHash(fileHashHex) {
    return String(fileHashHex || "").trim().toLowerCase();
}

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

function getSemaphoreContract(provider) {
    const abiPath = path.join(
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
    return getContractAt(ADDRESSES.Semaphore, abiPath, provider);
}

function upsertZkPublicFile({ fileId, fileName, fileSize, groupId, fileHashHex }) {
    const db = gdprSvc.getDb();
    const now = Date.now();
    db.prepare(`
            INSERT INTO zk_public_files (fileId, fileName, fileSize, groupId, fileHashHex, createdAt, updatedAt)
            VALUES (@fileId, @fileName, @fileSize, @groupId, @fileHashHex, @now, @now)
      ON CONFLICT(fileId) DO UPDATE SET
        fileName = excluded.fileName,
        fileSize = excluded.fileSize,
                groupId = excluded.groupId,
        fileHashHex = excluded.fileHashHex,
        updatedAt = excluded.updatedAt
    `).run({
        fileId: String(fileId),
        fileName: String(fileName || `file_${fileId}`),
        fileSize: Number(fileSize || 0),
                groupId: String(groupId || ""),
        fileHashHex: normalizeHash(fileHashHex),
        now,
    });
}

function upsertZkPublicMaterials({ fileId, cids, aesKeyHex, ivs, authTags }) {
    const db = gdprSvc.getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO zk_public_materials (fileId, cidsJson, aesKeyHex, ivsJson, authTagsJson, createdAt, updatedAt)
      VALUES (@fileId, @cidsJson, @aesKeyHex, @ivsJson, @authTagsJson, @now, @now)
      ON CONFLICT(fileId) DO UPDATE SET
        cidsJson = excluded.cidsJson,
        aesKeyHex = excluded.aesKeyHex,
        ivsJson = excluded.ivsJson,
        authTagsJson = excluded.authTagsJson,
        updatedAt = excluded.updatedAt
    `).run({
        fileId: String(fileId),
        cidsJson: JSON.stringify(cids || []),
        aesKeyHex: String(aesKeyHex || ""),
        ivsJson: JSON.stringify(ivs || []),
        authTagsJson: JSON.stringify(authTags || []),
        now,
    });
}

function getZkPublicMaterials(fileId) {
    const db = gdprSvc.getDb();
    const row = db.prepare(`SELECT * FROM zk_public_materials WHERE fileId = ?`).get(String(fileId));
    if (!row) return null;
    return {
        fileId: row.fileId,
        cids: JSON.parse(row.cidsJson || "[]"),
        aesKeyHex: row.aesKeyHex,
        ivs: JSON.parse(row.ivsJson || "[]"),
        authTags: JSON.parse(row.authTagsJson || "[]"),
    };
}

router.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file provided" });

        const { fileName } = req.body || {};
        const fileBuffer = req.file.buffer;
        const displayName = String(fileName || req.file.originalname || "unknown");

        const { encryptedChunks, aesKey, hashes, ivs, authTags } = encSvc.encryptFile(fileBuffer);
        const fileHashHex = encSvc.sha256(fileBuffer);

        let cids;
        try {
            cids = await ipfsSvc.uploadChunks(encryptedChunks);
        } catch {
            return res.status(503).json({
                error: "File storage (IPFS/Pinata) unavailable. Check Pinata config and retry.",
            });
        }

        const key = normalizeHash(fileHashHex);
        pendingZkUploads.set(key, {
            materials: {
                cids,
                aesKeyHex: aesKey.toString("hex"),
                ivs: ivs.map((iv) => iv.toString("hex")),
                authTags: authTags.map((t) => t.toString("hex")),
            },
            metadata: {
                fileName: displayName,
                fileSize: Number(req.file.size || 0),
                fileHashHex: key,
            },
            expiresAt: Date.now() + PENDING_TTL_MS,
        });

        return res.json({
            success: true,
            cids,
            fileHashHex: key,
            hashes,
            ivs: ivs.map((iv) => iv.toString("hex")),
            authTags: authTags.map((t) => t.toString("hex")),
            fileName: displayName,
            fileSize: Number(req.file.size || 0),
            message: "ZK-public upload prepared. Complete on-chain steps, then call /api/zk-public/register.",
        });
    } catch {
        return res.status(500).json({ error: "ZK-public upload failed" });
    }
});

router.post("/register", authMiddleware, async (req, res) => {
    try {
        const { fileHashHex, fileName, fileSize, groupId } = req.body || {};

        if (!fileHashHex || !/^[0-9a-f]{64}$/i.test(String(fileHashHex))) {
            return res.status(400).json({ error: "fileHashHex must be a 64-char hex string" });
        }
        if (!groupId || !/^\d+$/.test(String(groupId))) {
            return res.status(400).json({ error: "groupId must be a valid Semaphore group id" });
        }

        const key = normalizeHash(fileHashHex);
        const pending = pendingZkUploads.get(key);
        if (!pending) {
            return res.status(404).json({ error: "No pending ZK-public upload found for this file hash" });
        }

        const db = gdprSvc.getDb();
        
        // Generate a unique fileId for this ZK file (auto-increment, separate from FileRegistry)
        const maxRow = db.prepare(`SELECT MAX(CAST(fileId AS INTEGER)) as maxId FROM zk_public_files`).get();
        const nextFileId = ((maxRow?.maxId || 0) + 1).toString();

        const safeFileName = String(fileName || pending.metadata.fileName || `file_${nextFileId}`);
        const safeFileSize = Number(fileSize ?? pending.metadata.fileSize ?? 0);

        upsertZkPublicMaterials({
            fileId: nextFileId,
            cids: pending.materials.cids,
            aesKeyHex: pending.materials.aesKeyHex,
            ivs: pending.materials.ivs,
            authTags: pending.materials.authTags,
        });

        upsertZkPublicFile({
            fileId: nextFileId,
            fileName: safeFileName,
            fileSize: safeFileSize,
            groupId: String(groupId),
            fileHashHex: key,
        });

        pendingZkUploads.delete(key);
        return res.json({ success: true, fileId: nextFileId });
    } catch {
        return res.status(500).json({ error: "ZK-public registration failed" });
    }
});

router.get("/files", async (_req, res) => {
    try {
        const db = gdprSvc.getDb();
        const rows = db.prepare(`
                    SELECT fileId, fileName, fileSize, groupId, fileHashHex, createdAt
          FROM zk_public_files
          ORDER BY createdAt DESC
        `).all();

        return res.json({
            success: true,
            files: (rows || []).map((r) => ({
                id: Number(r.fileId),
                fileId: Number(r.fileId),
                fileName: r.fileName,
                fileSize: Number(r.fileSize || 0),
                groupId: String(r.groupId || ""),
                fileHashHex: String(r.fileHashHex || ""),
                createdAt: Number(r.createdAt || 0),
            })),
        });
    } catch {
        return res.status(500).json({ error: "Failed to list ZK-public files" });
    }
});

router.post("/verify-proof", authMiddleware, async (req, res) => {
    try {
        const { fileId, proofTxHash, proofScope } = req.body || {};
        const userAddress = String(req.verifiedAddress || "").toLowerCase();

        if (fileId === undefined || fileId === null || !Number.isInteger(Number(fileId)) || Number(fileId) < 0) {
            return res.status(400).json({ error: "fileId must be a non-negative integer" });
        }
        if (!proofTxHash || !/^0x([A-Fa-f0-9]{64})$/.test(String(proofTxHash))) {
            return res.status(400).json({ error: "proofTxHash must be a valid transaction hash" });
        }
        if (proofScope !== undefined && proofScope !== null && !/^\d+$/.test(String(proofScope))) {
            return res.status(400).json({ error: "proofScope must be a uint256 numeric string" });
        }

        const db = gdprSvc.getDb();
        const fileRow = db.prepare(`SELECT groupId FROM zk_public_files WHERE fileId = ?`).get(String(fileId));
        if (!fileRow) {
            return res.status(404).json({ error: "File not found in ZK-public listing" });
        }

        const provider = getReadProvider();
        const semaphore = getSemaphoreContract(provider);

        const receipt = await provider.getTransactionReceipt(String(proofTxHash));
        if (!receipt || receipt.status !== 1) {
            return res.status(400).json({ error: "Proof transaction not found or failed" });
        }
        if (String(receipt.to || "").toLowerCase() !== String(semaphore.address).toLowerCase()) {
            return res.status(400).json({ error: "Transaction is not a Semaphore proof validation tx" });
        }

        const expectedMessage = ethers.BigNumber.from(
            ethers.utils.solidityKeccak256(["uint256", "address"], [Number(fileId), userAddress])
        ).toString();
        const expectedScope = (proofScope !== undefined && proofScope !== null)
            ? ethers.BigNumber.from(String(proofScope)).toString()
            : ethers.BigNumber.from(Number(fileId)).toString();
        const expectedGroupId = ethers.BigNumber.from(String(fileRow.groupId)).toString();

        const eventTopic = semaphore.interface.getEventTopic("ProofValidated");
        let matched = false;
        for (const log of receipt.logs || []) {
            if (String(log.address || "").toLowerCase() !== String(semaphore.address).toLowerCase()) continue;
            if (!Array.isArray(log.topics) || log.topics[0] !== eventTopic) continue;
            const parsed = semaphore.interface.parseLog(log);
            const groupId = parsed?.args?.groupId?.toString?.() || "";
            const message = parsed?.args?.message?.toString?.() || "";
            const scope = parsed?.args?.scope?.toString?.() || "";
            if (groupId === expectedGroupId && message === expectedMessage && scope === expectedScope) {
                matched = true;
                break;
            }
        }

        if (!matched) {
            return res.status(403).json({ error: "Valid Semaphore proof event not found for this file/user" });
        }

        db.prepare(`
          INSERT INTO zk_public_access (fileId, userAddress, verifiedAt)
          VALUES (?, ?, ?)
          ON CONFLICT(fileId, userAddress) DO UPDATE SET
            verifiedAt = excluded.verifiedAt
        `).run(String(fileId), userAddress, Date.now());

        return res.json({ success: true });
    } catch {
        return res.status(500).json({ error: "Proof verification failed" });
    }
});

router.get("/download/:fileId", authMiddleware, async (req, res) => {
    try {
        const { fileId } = req.params;
        const userAddress = req.verifiedAddress;

        if (!Number.isInteger(Number(fileId)) || Number(fileId) < 0) {
            return res.status(400).json({ error: "fileId must be a non-negative integer" });
        }

        const materials = getZkPublicMaterials(fileId);
        if (!materials) {
            return res.status(404).json({ error: "File materials not found" });
        }

        const db = gdprSvc.getDb();
        const accessRow = db.prepare(`
          SELECT verifiedAt FROM zk_public_access WHERE fileId = ? AND userAddress = ?
        `).get(String(fileId), String(userAddress).toLowerCase());
        if (!accessRow) {
            return res.status(403).json({ error: "ZK proof required for this file. Submit proof first." });
        }

        const cidsArr = materials.cids;
        const ivsArr = materials.ivs.map((v) => Buffer.from(v, "hex"));
        const tagsArr = materials.authTags.map((v) => Buffer.from(v, "hex"));
        const aesKey = Buffer.from(materials.aesKeyHex, "hex");

        const encryptedChunks = await ipfsSvc.retrieveChunks(cidsArr);
        const plainBuffer = encSvc.decryptFile(encryptedChunks, aesKey, ivsArr, tagsArr);

        gdprSvc.logAccess(String(userAddress).toLowerCase(), String(fileId), "ZK_PUBLIC_FILE_ACCESS", req.ip);

        res.set("Content-Type", "application/octet-stream");
        res.set("Content-Disposition", `attachment; filename="file_${fileId}"`);
        return res.send(plainBuffer);
    } catch {
        return res.status(500).json({ error: "ZK-public download failed" });
    }
});

module.exports = router;
