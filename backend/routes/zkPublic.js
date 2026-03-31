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
    return String(fileHashHex || "").trim().toLowerCase().replace(/^0x/, "");
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

function getFileRegistryContract(provider) {
    const abiPath = path.join(ARTIFACTS_ROOT, "FileRegistry.sol", "FileRegistry.json");
    return getContractAt(ADDRESSES.FileRegistry, abiPath, provider);
}

function getAccessControlContract(provider) {
    const abiPath = path.join(ARTIFACTS_ROOT, "AccessControl.sol", "FileAccessControl.json");
    return getContractAt(ADDRESSES.FileAccessControl, abiPath, provider);
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

async function getLatestEnabledZkFiles(accessControl) {
    const events = await accessControl.queryFilter(accessControl.filters.ZkPolicyDefined(), 0, "latest");
    const latestByFile = new Map();

    for (const ev of events) {
        const fileIdBN = ev?.args?.fileId;
        if (fileIdBN === undefined) continue;
        const fileId = fileIdBN.toString();
        const prev = latestByFile.get(fileId);
        if (
            !prev ||
            ev.blockNumber > prev.blockNumber ||
            (ev.blockNumber === prev.blockNumber && (ev.logIndex || 0) > (prev.logIndex || 0))
        ) {
            latestByFile.set(fileId, ev);
        }
    }

    const result = [];
    for (const [fileId, ev] of latestByFile.entries()) {
        const enabled = Boolean(ev?.args?.enabled);
        if (!enabled) continue;
        const groupIdBN = ev?.args?.groupId;
        if (groupIdBN === undefined) continue;
        result.push({ fileId, groupId: groupIdBN.toString() });
    }
    return result;
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
            message: "ZK-public upload prepared. Complete on-chain FileRegistry + ZK policy, then call /api/zk-public/register.",
        });
    } catch {
        return res.status(500).json({ error: "ZK-public upload failed" });
    }
});

router.post("/register", authMiddleware, async (req, res) => {
    try {
        const { fileHashHex, fileId } = req.body || {};

        if (!fileHashHex || !/^[0-9a-f]{64}$/i.test(String(fileHashHex))) {
            return res.status(400).json({ error: "fileHashHex must be a 64-char hex string" });
        }
        if (fileId === undefined || fileId === null || !/^\d+$/.test(String(fileId))) {
            return res.status(400).json({ error: "fileId must be a valid on-chain file id" });
        }

        const key = normalizeHash(fileHashHex);
        const pending = pendingZkUploads.get(key);
        if (!pending) {
            return res.status(404).json({ error: "No pending ZK-public upload found for this file hash" });
        }

        const provider = getReadProvider();
        const fileRegistry = getFileRegistryContract(provider);
        const accessControl = getAccessControlContract(provider);

        let fileData;
        try {
            fileData = await fileRegistry.getFile(Number(fileId));
        } catch {
            return res.status(400).json({ error: "On-chain fileId not found in FileRegistry" });
        }

        const onChainHash = normalizeHash(fileData?.fileHash?.toString?.() || "");
        if (!onChainHash || onChainHash !== key) {
            return res.status(400).json({ error: "On-chain fileHash does not match uploaded file hash" });
        }

        const [zkEnabled] = await accessControl.getZkPolicy(Number(fileId));
        if (!Boolean(zkEnabled)) {
            return res.status(400).json({ error: "ZK policy is not enabled on-chain for this fileId" });
        }

        upsertZkPublicMaterials({
            fileId: String(fileId),
            cids: pending.materials.cids,
            aesKeyHex: pending.materials.aesKeyHex,
            ivs: pending.materials.ivs,
            authTags: pending.materials.authTags,
        });

        pendingZkUploads.delete(key);
        return res.json({ success: true, fileId: String(fileId) });
    } catch {
        return res.status(500).json({ error: "ZK-public registration failed" });
    }
});

router.get("/files", async (_req, res) => {
    try {
        const provider = getReadProvider();
        const fileRegistry = getFileRegistryContract(provider);
        const accessControl = getAccessControlContract(provider);

        const zkFiles = await getLatestEnabledZkFiles(accessControl);

        const files = [];
        for (const item of zkFiles) {
            try {
                const data = await fileRegistry.getFile(Number(item.fileId));
                if (data?.isDeleted) continue;
                files.push({
                    id: Number(item.fileId),
                    fileId: Number(item.fileId),
                    fileName: data.fileName,
                    fileSize: Number(data.fileSize?.toString?.() || 0),
                    groupId: String(item.groupId),
                    fileHashHex: normalizeHash(data.fileHash?.toString?.() || ""),
                    createdAt: Number(data.timestamp?.toString?.() || 0) * 1000,
                });
            } catch {
                // Ignore files no longer resolvable on-chain.
            }
        }

        files.sort((a, b) => b.createdAt - a.createdAt);
        return res.json({ success: true, files });
    } catch {
        return res.status(500).json({ error: "Failed to list ZK-public files" });
    }
});

router.get("/download/:fileId", authMiddleware, async (req, res) => {
    try {
        const { fileId } = req.params;
        const { zkProofTxHash, zkProofScope } = req.query;

        if (!Number.isInteger(Number(fileId)) || Number(fileId) < 0) {
            return res.status(400).json({ error: "fileId must be a non-negative integer" });
        }
        if (!zkProofTxHash || !/^0x([A-Fa-f0-9]{64})$/.test(String(zkProofTxHash))) {
            return res.status(403).json({ error: "ZK proof required: provide zkProofTxHash" });
        }
        if (zkProofScope === undefined || zkProofScope === null || !/^\d+$/.test(String(zkProofScope))) {
            return res.status(403).json({ error: "ZK proof required: provide zkProofScope as uint256" });
        }

        const materials = getZkPublicMaterials(fileId);
        if (!materials) {
            return res.status(404).json({ error: "File materials not found" });
        }

        const provider = getReadProvider();
        const semaphore = getSemaphoreContract(provider);
        const accessControl = getAccessControlContract(provider);

        const [zkEnabled, groupIdBN] = await accessControl.getZkPolicy(Number(fileId));
        if (!Boolean(zkEnabled)) {
            return res.status(404).json({ error: "ZK policy not enabled for this file" });
        }

        const receipt = await provider.getTransactionReceipt(String(zkProofTxHash));
        if (!receipt || receipt.status !== 1) {
            return res.status(403).json({ error: "ZK proof transaction not found or failed" });
        }
        if (String(receipt.to || "").toLowerCase() !== String(semaphore.address).toLowerCase()) {
            return res.status(403).json({ error: "Transaction is not a Semaphore proof validation tx" });
        }

        const expectedMessage = ethers.BigNumber.from(
            ethers.utils.solidityKeccak256(["uint256"], [Number(fileId)])
        ).toString();
        const expectedScope = ethers.BigNumber.from(String(zkProofScope)).toString();
        const expectedGroupId = ethers.BigNumber.from(groupIdBN.toString()).toString();
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
            return res.status(403).json({ error: "Valid Semaphore proof event not found for this file" });
        }

        const cidsArr = materials.cids;
        const ivsArr = materials.ivs.map((v) => Buffer.from(v, "hex"));
        const tagsArr = materials.authTags.map((v) => Buffer.from(v, "hex"));
        const aesKey = Buffer.from(materials.aesKeyHex, "hex");

        const encryptedChunks = await ipfsSvc.retrieveChunks(cidsArr);
        const plainBuffer = encSvc.decryptFile(encryptedChunks, aesKey, ivsArr, tagsArr);

        gdprSvc.logAccess(String(req.verifiedAddress).toLowerCase(), String(fileId), "ZK_PUBLIC_FILE_ACCESS", req.ip);

        res.set("Content-Type", "application/octet-stream");
        res.set("Content-Disposition", `attachment; filename="file_${fileId}"`);
        return res.send(plainBuffer);
    } catch {
        return res.status(500).json({ error: "ZK-public download failed" });
    }
});

module.exports = router;
