"use strict";
const express = require("express");
const router = express.Router();
const { ethers } = require("ethers");
const path = require("path");

const { authMiddleware } = require("../middleware/auth");
const encSvc = require("../services/encryptionService");
const ipfsSvc = require("../services/ipfsService");
const gdprSvc = require("../services/gdprService");
const groupSvc = require("../services/groupKeyService");
const materialsSvc = require("../services/materialsService");

function hasAllPolicyAttributes(userAttrs, filePolicy) {
    if (!Array.isArray(filePolicy) || filePolicy.length === 0) return true;
    const userSet = new Set((Array.isArray(userAttrs) ? userAttrs : []).map((a) => String(a).toLowerCase()));
    for (const needed of filePolicy) {
        if (!userSet.has(String(needed).toLowerCase())) return false;
    }
    return true;
}

function normalizeAddr(value) {
    return String(value || "").trim().toLowerCase();
}

function getReadProvider() {
    const rpcUrl = process.env.HARDHAT_RPC_URL || "http://127.0.0.1:8545";
    return new ethers.providers.JsonRpcProvider(rpcUrl);
}

function getContractAt(address, abiPath, provider) {
    const artifact = require(abiPath);
    return new ethers.Contract(address, artifact.abi || artifact, provider);
}

const ARTIFACTS_ROOT = path.join(
    __dirname, "..", "..", "blockchain", "artifacts", "contracts"
);
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
    const artifact = require(abiPath);
    return new ethers.Contract(ADDRESSES.Semaphore, artifact.abi || artifact, provider);
}

async function verifyZkProofTxForFile({ provider, fileId, groupId, proofTxHash, proofScope }) {
    if (!proofTxHash || !/^0x([A-Fa-f0-9]{64})$/.test(String(proofTxHash))) {
        throw new Error("ZK proof required: provide zkProofTxHash");
    }
    if (proofScope === undefined || proofScope === null || !/^\d+$/.test(String(proofScope))) {
        throw new Error("ZK proof required: provide zkProofScope as uint256");
    }

    const semaphore = getSemaphoreContract(provider);
    const receipt = await provider.getTransactionReceipt(String(proofTxHash));
    if (!receipt || receipt.status !== 1) {
        throw new Error("ZK proof transaction not found or failed");
    }
    if (String(receipt.to || "").toLowerCase() !== String(semaphore.address).toLowerCase()) {
        throw new Error("ZK proof transaction target is not Semaphore");
    }

    const expectedMessage = ethers.BigNumber.from(
        ethers.utils.solidityKeccak256(["uint256"], [Number(fileId)])
    ).toString();
    const expectedScope = ethers.BigNumber.from(String(proofScope)).toString();
    const expectedGroupId = ethers.BigNumber.from(String(groupId)).toString();

    const eventTopic = semaphore.interface.getEventTopic("ProofValidated");
    for (const log of receipt.logs || []) {
        if (String(log.address || "").toLowerCase() !== String(semaphore.address).toLowerCase()) continue;
        if (!Array.isArray(log.topics) || log.topics[0] !== eventTopic) continue;
        const parsed = semaphore.interface.parseLog(log);
        const groupIdLogged = parsed?.args?.groupId?.toString?.() || "";
        const messageLogged = parsed?.args?.message?.toString?.() || "";
        const scopeLogged = parsed?.args?.scope?.toString?.() || "";
        if (
            groupIdLogged === expectedGroupId &&
            messageLogged === expectedMessage &&
            scopeLogged === expectedScope
        ) {
            return true;
        }
    }

    throw new Error("Valid Semaphore proof event not found for file policy");
}

/**
 * POST /api/share
 * Grant file access: log share intent + time-bound metadata (on-chain calls delegated to frontend).
 * Requires authentication — ownerAddress is derived from the verified signature.
 */
router.post("/share", authMiddleware, async (req, res) => {
    try {
        const {
            fileId,
            recipientAddress,
            expiryDurationSeconds,
        } = req.body;

        if (fileId === undefined || fileId === null || !recipientAddress)
            return res.status(400).json({ error: "fileId and recipientAddress required" });

        let recipient;
        try {
            recipient = ethers.utils.getAddress(recipientAddress);
        } catch {
            return res.status(400).json({ error: "Invalid recipientAddress format (must be valid Ethereum address)" });
        }

        if (!Number.isInteger(Number(fileId)) || Number(fileId) < 0) {
            return res.status(400).json({ error: "fileId must be a non-negative integer" });
        }

        if (expiryDurationSeconds !== undefined && (typeof expiryDurationSeconds !== "number" || expiryDurationSeconds < 0)) {
            return res.status(400).json({ error: "expiryDurationSeconds must be a non-negative number" });
        }

        const expiryTs = Math.floor(Date.now() / 1000) + (expiryDurationSeconds || 3600);

        gdprSvc.logAccess(
            req.verifiedAddress,
            String(fileId),
            "SHARE_GRANTED",
            null
        );

        return res.json({
            success: true,
            fileId,
            recipientAddress: recipient,
            expiryTimestamp: expiryTs,
            message:
                "Direct share prepared. Call AccessControl.grantAccess() and TimeBoundPermissions.grantTimedAccess() on-chain.",
        });
    } catch {
        console.error("[share] Processing error (stack logged server-side)");
        res.status(500).json({ error: "Share request failed" });
    }
});

/**
 * GET /api/access/:fileId
 * Retrieve and decrypt a file. Authentication required.
 */
router.get("/access/:fileId", authMiddleware, async (req, res) => {
    try {
        const { fileId } = req.params;
        const userAddress = req.verifiedAddress;

        const stored = materialsSvc.getFileMaterials(fileId);
        if (!stored) {
            return res.status(400).json({
                error: "Missing decryption materials for this fileId.",
                fix: "Uploader must re-upload (if needed) and call /api/materials/register after chain confirmation.",
            });
        }

        const provider = getReadProvider();
        const accessControl = getContractAt(
            ADDRESSES.FileAccessControl,
            path.join(ARTIFACTS_ROOT, "AccessControl.sol", "FileAccessControl.json"),
            provider
        );
        const fileRegistry = getContractAt(
            ADDRESSES.FileRegistry,
            path.join(ARTIFACTS_ROOT, "FileRegistry.sol", "FileRegistry.json"),
            provider
        );
        const timeBound = getContractAt(
            ADDRESSES.TimeBoundPermissions,
            path.join(ARTIFACTS_ROOT, "TimeBoundPermissions.sol", "TimeBoundPermissions.json"),
            provider
        );

        const allowed = await accessControl.checkAccess(userAddress, fileId);
        const [zkEnabled, zkGroupIdBN] = await accessControl.getZkPolicy(fileId);
        const zkPolicyEnabled = Boolean(zkEnabled);
        const zkGroupId = zkGroupIdBN?.toString ? zkGroupIdBN.toString() : String(zkGroupIdBN || "");

        const filePolicy = await accessControl.getFilePolicy(fileId);
        const hasAttributePolicy = Array.isArray(filePolicy) && filePolicy.length > 0;
        const fileGrantees = await accessControl.getFileGrantees(fileId);
        const hasExplicitDirectGrants = Array.isArray(fileGrantees) && fileGrantees.length > 0;

        const requester = normalizeAddr(userAddress);
        const accessControlOwner = normalizeAddr(await accessControl.getFileOwner(fileId));
        let fileRegistryOwner = "";
        try {
            const fileData = await fileRegistry.getFile(fileId);
            fileRegistryOwner = normalizeAddr(fileData.owner);
        } catch {
            fileRegistryOwner = "";
        }
        const storedOwner = normalizeAddr(stored.ownerAddress);
        const zeroAddr = "0x0000000000000000000000000000000000000000";
        const isOwnerByAccessControl = accessControlOwner && accessControlOwner !== zeroAddr && accessControlOwner === requester;
        const isOwnerByRegistry = fileRegistryOwner && fileRegistryOwner !== zeroAddr && fileRegistryOwner === requester;
        const isOwnerByStoredMaterials = storedOwner && storedOwner === requester;
        const isRequesterOwner = isOwnerByAccessControl || isOwnerByRegistry || isOwnerByStoredMaterials;

        if (zkPolicyEnabled && !isRequesterOwner) {
            const proofTxHash = req.query.zkProofTxHash;
            const proofScope = req.query.zkProofScope;
            try {
                await verifyZkProofTxForFile({
                    provider,
                    fileId,
                    groupId: zkGroupId,
                    proofTxHash,
                    proofScope,
                });
            } catch (zkErr) {
                return res.status(403).json({ error: zkErr.message || "ZK proof required for this file" });
            }
        }

        let hasActiveTimedDirectAccess = false;
        if (allowed) {
            try {
                hasActiveTimedDirectAccess = await timeBound.isAccessValid(userAddress, fileId);
            } catch {
                hasActiveTimedDirectAccess = false;
            }
        }

        let hasPolicyOnlyRoleAccess = false;
        if (!allowed && hasAttributePolicy && !hasExplicitDirectGrants) {
            try {
                const userAttrs = await accessControl.getUserAttributes(userAddress);
                hasPolicyOnlyRoleAccess = hasAllPolicyAttributes(userAttrs, filePolicy);
            } catch {
                hasPolicyOnlyRoleAccess = false;
            }
        }

        const cidsArr = stored.cids;
        const ivsHexArr = stored.ivs;
        const tagsHexArr = stored.authTags;
        let aesKeyHexResolved;

        if (isRequesterOwner) {
            aesKeyHexResolved = stored.aesKeyHex;
        } else if (allowed && hasActiveTimedDirectAccess) {
            aesKeyHexResolved = stored.aesKeyHex;
        } else if (hasPolicyOnlyRoleAccess) {
            aesKeyHexResolved = stored.aesKeyHex;
        } else {
            const groupAccess = groupSvc.resolveGroupAccessForUser(fileId, userAddress);
            if (!groupAccess) {
                const deniedReason = allowed && !hasActiveTimedDirectAccess
                    ? "expired_direct_permission"
                    : "no_grant_or_group";
                console.warn(`[access] Authorization denied: user=${userAddress} file=${fileId} reason=${deniedReason}`);
                return res.status(403).json({ error: "Access denied (no direct grant or active group share)" });
            }
            if (hasAttributePolicy) {
                const userAttrs = await accessControl.getUserAttributes(userAddress);
                const abacAllowedForGroup = hasAllPolicyAttributes(userAttrs, filePolicy);
                if (!abacAllowedForGroup) {
                    console.warn(`[access] Authorization denied: user=${userAddress} file=${fileId} reason=abac_policy`);
                    return res.status(403).json({
                        error: "Access denied by ABAC policy for this group share",
                    });
                }
            }
            aesKeyHexResolved = groupAccess.aesKeyHex;
        }

        const looksLikeRealCid = (cid) => {
            if (typeof cid !== "string" || cid.length < 20) return false;
            if (cid.startsWith("MOCKCID_")) return false;
            if (cid.includes("chunk")) return false;
            const cidV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
            const cidV1 = /^b[a-z2-7]{20,}$/;
            return cidV0.test(cid) || cidV1.test(cid);
        };
        if (!Array.isArray(cidsArr) || cidsArr.length === 0) {
            return res.status(400).json({ error: "cids must be a non-empty JSON array" });
        }
        const badCid = cidsArr.find((cid) => !looksLikeRealCid(cid));
        if (badCid) {
            return res.status(400).json({
                error: "Invalid CID stored for this file. This file was likely uploaded while IPFS/Pinata was failing.",
                badCid,
                fix:
                    "Configure PINATA_API_KEY/PINATA_API_SECRET, re-upload the file to generate real CIDs, then re-share.",
            });
        }

        const ivsArr = Array.isArray(ivsHexArr) ? ivsHexArr.map((v) => Buffer.from(v, "hex")) : [];
        const tagsArr = Array.isArray(tagsHexArr) ? tagsHexArr.map((v) => Buffer.from(v, "hex")) : [];
        const aesKey = Buffer.from(aesKeyHexResolved, "hex");

        let encryptedChunks;
        try {
            encryptedChunks = await ipfsSvc.retrieveChunks(cidsArr);
        } catch (ipfsErr) {
            return res.status(503).json({
                error: "IPFS unavailable",
                detail: ipfsErr.response?.status ? `HTTP ${ipfsErr.response.status}` : ipfsErr.message,
            });
        }

        const plainBuffer = encSvc.decryptFile(encryptedChunks, aesKey, ivsArr, tagsArr);

        gdprSvc.logAccess(userAddress.toLowerCase(), String(fileId), "FILE_ACCESS", req.ip);

        res.set("Content-Type", "application/octet-stream");
        res.set("Content-Disposition", `attachment; filename="file_${fileId}"`);
        res.send(plainBuffer);
    } catch (err) {
        if (err instanceof RangeError || err.message.includes("buffers")) {
            console.error("[access] Decryption failed (buffer size mismatch or auth tag failed)");
            return res.status(422).json({ error: "File decryption failed (corrupted data)" });
        }
        console.error("[access] Processing error (stack logged server-side)");
        res.status(500).json({ error: "File access failed" });
    }
});

/**
 * GET /api/received-shares
 */
const receivedSharesRouter = express.Router();

receivedSharesRouter.get("/received-shares", authMiddleware, async (req, res) => {
    try {
        const userAddress = req.verifiedAddress;
        const provider = getReadProvider();

        const accessControl = getContractAt(
            ADDRESSES.FileAccessControl,
            path.join(ARTIFACTS_ROOT, "AccessControl.sol", "FileAccessControl.json"),
            provider
        );
        const fileRegistry = getContractAt(
            ADDRESSES.FileRegistry,
            path.join(ARTIFACTS_ROOT, "FileRegistry.sol", "FileRegistry.json"),
            provider
        );
        const timeBound = getContractAt(
            ADDRESSES.TimeBoundPermissions,
            path.join(ARTIFACTS_ROOT, "TimeBoundPermissions.sol", "TimeBoundPermissions.json"),
            provider
        );

        const grantFilter = accessControl.filters.AccessGranted(null, userAddress);
        const revokeFilter = accessControl.filters.AccessRevoked(null, userAddress);
        const grantEvents = await accessControl.queryFilter(grantFilter, 0, "latest");
        const revokeEvents = await accessControl.queryFilter(revokeFilter, 0, "latest");

        const latestGrantByFile = new Map();
        for (const ev of grantEvents) {
            const id = ev?.args?.fileId?.toNumber?.();
            if (id === undefined) continue;
            const prev = latestGrantByFile.get(id);
            if (
                !prev ||
                ev.blockNumber > prev.blockNumber ||
                (ev.blockNumber === prev.blockNumber && (ev.logIndex || 0) > (prev.logIndex || 0))
            ) {
                latestGrantByFile.set(id, ev);
            }
        }

        const latestRevokeByFile = new Map();
        for (const ev of revokeEvents) {
            const id = ev?.args?.fileId?.toNumber?.();
            if (id === undefined) continue;
            const prev = latestRevokeByFile.get(id);
            if (
                !prev ||
                ev.blockNumber > prev.blockNumber ||
                (ev.blockNumber === prev.blockNumber && (ev.logIndex || 0) > (prev.logIndex || 0))
            ) {
                latestRevokeByFile.set(id, ev);
            }
        }

        const fileIds = [...latestGrantByFile.keys()].filter((id) => {
            const grantEv = latestGrantByFile.get(id);
            const revokeEv = latestRevokeByFile.get(id);
            if (!grantEv) return false;
            if (!revokeEv) return true;
            if (grantEv.blockNumber > revokeEv.blockNumber) return true;
            if (grantEv.blockNumber < revokeEv.blockNumber) return false;
            return (grantEv.logIndex || 0) > (revokeEv.logIndex || 0);
        });

        const files = await Promise.all(
            fileIds.map(async (id) => {
                try {
                    const [zkEnabled] = await accessControl.getZkPolicy(id);
                    const zkPolicyEnabled = Boolean(zkEnabled);
                    const currentlyAllowed = await accessControl.checkAccess(userAddress, id);

                    const filePolicy = await accessControl.getFilePolicy(id);
                    const hasAttributePolicy = Array.isArray(filePolicy) && filePolicy.length > 0;
                    if (hasAttributePolicy) {
                        const userAttrs = await accessControl.getUserAttributes(userAddress);
                        const abacAllowed = hasAllPolicyAttributes(userAttrs, filePolicy);
                        if (!abacAllowed) return null;
                    }

                    if (!currentlyAllowed && !zkPolicyEnabled) return null;

                    const data = await fileRegistry.getFile(id);
                    if (data.isDeleted) return null;

                    const owner = await accessControl.getFileOwner(id);

                    let expiryTimestamp = null;
                    let isAccessValid = false;
                    try {
                        isAccessValid = await timeBound.isAccessValid(userAddress, id);
                        if (isAccessValid) {
                            const perm = await timeBound.getPermissionForUserFile(userAddress, id);
                            const expTs = perm.expiryTimestamp.toNumber();
                            if (expTs > 0) expiryTimestamp = expTs * 1000;
                        }
                    } catch {
                    }

                    return {
                        id,
                        owner,
                        fileName: data.fileName,
                        fileSize: data.fileSize.toNumber(),
                        cids: data.cids,
                        fileHash: data.fileHash,
                        uploadTimestamp: data.timestamp.toNumber() * 1000,
                        isAccessValid,
                        expiryTimestamp,
                        requiresZkProof: zkPolicyEnabled,
                    };
                } catch {
                    return null;
                }
            })
        );

        const validFiles = files.filter(Boolean);

        const groupShares = groupSvc.listGroupSharesForUser(userAddress);
        const existingIds = new Set(validFiles.map((f) => Number(f.id)));

        const groupFiles = await Promise.all(
            groupShares
                .filter((s) => !existingIds.has(Number(s.fileId)))
                .map(async (s) => {
                    try {
                        const [zkEnabled] = await accessControl.getZkPolicy(s.fileId);
                        const zkPolicyEnabled = Boolean(zkEnabled);
                        const filePolicy = await accessControl.getFilePolicy(s.fileId);
                        const hasAttributePolicy = Array.isArray(filePolicy) && filePolicy.length > 0;
                        if (hasAttributePolicy) {
                            const userAttrs = await accessControl.getUserAttributes(userAddress);
                            const abacAllowedForGroup = hasAllPolicyAttributes(userAttrs, filePolicy);
                            if (!abacAllowedForGroup) return null;
                        }

                        const data = await fileRegistry.getFile(s.fileId);
                        if (data.isDeleted) return null;
                        return {
                            id: s.fileId,
                            owner: s.ownerAddress,
                            fileName: data.fileName,
                            fileSize: data.fileSize.toNumber(),
                            cids: data.cids,
                            fileHash: data.fileHash,
                            uploadTimestamp: data.timestamp.toNumber() * 1000,
                            isAccessValid: s.isAccessValid,
                            expiryTimestamp: s.expiryTimestamp,
                            sharedVia: "group",
                            groupId: s.groupId,
                            requiresAbac: hasAttributePolicy,
                            requiresZkProof: zkPolicyEnabled,
                        };
                    } catch {
                        return null;
                    }
                })
        );

        return res.json({
            success: true,
            files: [...validFiles, ...groupFiles.filter(Boolean)],
        });
    } catch (err) {
        if (err.message.includes("Contract") || err.message.includes("address")) {
            console.error("[received-shares] Contract loading error (check deployed_addresses.json and RPC)");
            return res.status(500).json({ error: "Contract configuration error" });
        }
        console.error("[received-shares] Processing error (stack logged server-side)");
        res.status(500).json({ error: "Failed to load shared files" });
    }
});

module.exports = { accessRouter: router, receivedSharesRouter };
