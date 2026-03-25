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

        // Validate recipientAddress format
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
    } catch (err) {
        // Log error details server-side only
        console.error("[share] Processing error (stack logged server-side)");
        res.status(500).json({ error: "Share request failed" });
    }
});

/**
 * GET /api/access/:fileId
 * Retrieve and decrypt a file. Authentication required.
 * Decryption materials are always loaded from the server-side DB — keys are never
 * accepted from the client via query string or request body.
 */
router.get("/access/:fileId", authMiddleware, async (req, res) => {
    try {
        const { fileId } = req.params;
        const userAddress = req.verifiedAddress;

        // Decryption materials are ALWAYS loaded from the server-side DB.
        // Accepting keys via query string or request body is explicitly disallowed.
        const stored = materialsSvc.getFileMaterials(fileId);
        if (!stored) {
            return res.status(400).json({
                error: "Missing decryption materials for this fileId.",
                fix: "Uploader must re-upload (if needed) and call /api/materials/register after chain confirmation.",
            });
        }

        // Authorize against on-chain AccessControl.checkAccess(user, fileId)
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

        // Owner bypass: the file owner always has access to their own decryption materials.
        // This is checked first so a chain reset (which clears on-chain checkAccess state) never
        // locks the uploader out of their own files.
        if (isRequesterOwner) {
            aesKeyHexResolved = stored.aesKeyHex;
        } else if (allowed && hasActiveTimedDirectAccess) {
            aesKeyHexResolved = stored.aesKeyHex;
        } else if (hasPolicyOnlyRoleAccess) {
            aesKeyHexResolved = stored.aesKeyHex;
        } else {
            // Fallback: group key access path (server-managed group KEK + membership)
            const groupAccess = groupSvc.resolveGroupAccessForUser(fileId, userAddress);
            if (!groupAccess) {
                // Log failed authorization attempt for audit
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
                    // Log attribute policy denial
                    console.warn(`[access] Authorization denied: user=${userAddress} file=${fileId} reason=abac_policy`);
                    return res.status(403).json({
                        error: "Access denied by ABAC policy for this group share",
                    });
                }
            }
            aesKeyHexResolved = groupAccess.aesKeyHex;
        }

        // Detect obviously invalid / mock CIDs early to avoid confusing "IPFS unavailable" errors.
        // Real CIDs are typically base58btc (CIDv0 starts with Qm...) or base32 (CIDv1 starts with b...).
        const looksLikeRealCid = (cid) => {
            if (typeof cid !== "string" || cid.length < 20) return false;
            if (cid.startsWith("MOCKCID_")) return false;
            if (cid.includes("chunk")) return false; // legacy mock pattern from older uploads
            // CIDv0: base58btc, usually starts with Qm + 44 chars total (46)
            const cidV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
            // CIDv1: base32 lower-case, starts with b...
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

        // Fetch encrypted chunks from IPFS
        let encryptedChunks;
        try {
            encryptedChunks = await ipfsSvc.retrieveChunks(cidsArr);
        } catch (ipfsErr) {
            return res.status(503).json({
                error: "IPFS unavailable",
                detail: ipfsErr.response?.status ? `HTTP ${ipfsErr.response.status}` : ipfsErr.message,
            });
        }

        // Decrypt
        const plainBuffer = encSvc.decryptFile(encryptedChunks, aesKey, ivsArr, tagsArr);

        // Log access
        gdprSvc.logAccess(userAddress.toLowerCase(), String(fileId), "FILE_ACCESS", req.ip);

        res.set("Content-Type", "application/octet-stream");
        res.set("Content-Disposition", `attachment; filename="file_${fileId}"`);
        res.send(plainBuffer);
    } catch (err) {
        // Log error details server-side only
        if (err instanceof RangeError || err.message.includes("buffers")) {
            console.error("[access] Decryption failed (buffer size mismatch or auth tag failed)");
            return res.status(422).json({ error: "File decryption failed (corrupted data)" });
        }
        console.error("[access] Processing error (stack logged server-side)");
        res.status(500).json({ error: "File access failed" });
    }
});

module.exports = { accessRouter: router };

// ─── Lazy-load helper for reading contracts from the local Hardhat node ───────

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

/**
 * GET /api/received-shares
 * Returns files that other accounts have explicitly shared (AccessGranted event)
 * to the requesting authenticated user, along with file metadata from FileRegistry.
 * Requires authentication — uses verified address from signature.
 */
const receivedSharesRouter = express.Router();

receivedSharesRouter.get("/received-shares", authMiddleware, async (req, res) => {
    try {
        // Use the cryptographically verified address — never trust a query parameter for identity.
        const userAddress = req.verifiedAddress;

        const provider = getReadProvider();

        // Load AccessControl contract
        const accessControl = getContractAt(
            ADDRESSES.FileAccessControl,
            path.join(ARTIFACTS_ROOT, "AccessControl.sol", "FileAccessControl.json"),
            provider
        );

        // Load FileRegistry contract
        const fileRegistry = getContractAt(
            ADDRESSES.FileRegistry,
            path.join(ARTIFACTS_ROOT, "FileRegistry.sol", "FileRegistry.json"),
            provider
        );

        // Load TimeBoundPermissions contract
        const timeBound = getContractAt(
            ADDRESSES.TimeBoundPermissions,
            path.join(ARTIFACTS_ROOT, "TimeBoundPermissions.sol", "TimeBoundPermissions.json"),
            provider
        );

        // Query AccessGranted events where recipient = userAddress
        const filter = accessControl.filters.AccessGranted(null, userAddress);
        const events = await accessControl.queryFilter(filter, 0, "latest");

        // Deduplicate file IDs
        const fileIds = [...new Set(events.map((e) => e.args.fileId.toNumber()))];

        const files = await Promise.all(
            fileIds.map(async (id) => {
                try {
                    const currentlyAllowed = await accessControl.checkAccess(userAddress, id);
                    if (!currentlyAllowed) return null;

                    const data = await fileRegistry.getFile(id);
                    if (data.isDeleted) return null;

                    // Get owner
                    const owner = await accessControl.getFileOwner(id);

                    // Check time-bound access validity
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
                        // Time-bound record may not exist
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
                    };
                } catch {
                    return null;
                }
            })
        );

        const validFiles = files.filter(Boolean);

        // Merge group-shared files (server-managed group key sharing)
        const groupShares = groupSvc.listGroupSharesForUser(userAddress);
        const existingIds = new Set(validFiles.map((f) => Number(f.id)));

        const groupFiles = await Promise.all(
            groupShares
                .filter((s) => !existingIds.has(Number(s.fileId)))
                .map(async (s) => {
                    try {
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
        // Log error details server-side only
        if (err.message.includes("Contract") || err.message.includes("address")) {
            console.error("[received-shares] Contract loading error (check deployed_addresses.json and RPC)");
            return res.status(500).json({ error: "Contract configuration error" });
        }
        console.error("[received-shares] Processing error (stack logged server-side)");
        res.status(500).json({ error: "Failed to load shared files" });
    }
});

module.exports = { accessRouter: router, receivedSharesRouter };
