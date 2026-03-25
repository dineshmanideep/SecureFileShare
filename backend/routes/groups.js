"use strict";

const express = require("express");
const path = require("path");
const router = express.Router();
const { ethers } = require("ethers");

const { authMiddleware } = require("../middleware/auth");
const groupSvc = require("../services/groupKeyService");
const materialsSvc = require("../services/materialsService");
const gdprSvc = require("../services/gdprService");

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

// Helper: validate Ethereum address format
function validateAddress(addr) {
    try {
        return ethers.utils.getAddress(addr);
    } catch {
        throw new Error(`Invalid Ethereum address format: ${String(addr).slice(0, 20)}...`);
    }
}

function normalizeMemberAddress(member) {
    if (typeof member === "string") return member;
    if (member && typeof member === "object" && typeof member.address === "string") {
        return member.address;
    }
    return member;
}

router.get("/", authMiddleware, (req, res) => {
    try {
        const groups = groupSvc.listGroupsForUser(req.verifiedAddress);
        return res.json({ success: true, groups });
    } catch (err) {
        console.error("[groups/list] Processing error (stack logged server-side)");
        return res.status(500).json({ error: "Failed to list groups" });
    }
});

router.post("/", authMiddleware, (req, res) => {
    try {
        const { name, members } = req.body || {};
        
        // Input validation
        if (!name || typeof name !== "string" || name.trim().length === 0) {
            return res.status(400).json({ error: "Group name is required (non-empty string)" });
        }
        if (name.length > 255) {
            return res.status(400).json({ error: "Group name too long (max 255 characters)" });
        }
        
        // Validate member addresses
        const memberList = Array.isArray(members) ? members : [];
        const validatedMembers = [];
        for (const m of memberList) {
            try {
                const normalized = normalizeMemberAddress(m);
                validatedMembers.push(validateAddress(normalized));
            } catch (er) {
                return res.status(400).json({ error: `Invalid member address: ${er.message}` });
            }
        }

        const group = groupSvc.createGroup({
            ownerAddress: req.verifiedAddress,
            name: name.trim(),
            members: validatedMembers,
        });
        return res.json({ success: true, group });
    } catch (err) {
        const msg = err?.message || "Failed to create group";
        console.error(`[groups/create] ${msg}`);
        const status = msg.includes("GROUP_KMS_KEY_HEX") ? 500 : 400;
        return res.status(status).json({ error: msg });
    }
});

router.get("/:groupId/members", authMiddleware, (req, res) => {
    try {
        const { groupId } = req.params;
        if (!groupId || groupId.trim().length === 0) {
            return res.status(400).json({ error: "groupId is required" });
        }

        const groups = groupSvc.listGroupsForUser(req.verifiedAddress);
        const inGroup = groups.some((g) => g.groupId === String(groupId));
        if (!inGroup) return res.status(403).json({ error: "Not a member of this group" });

        const members = groupSvc.listGroupMembers(groupId);
        return res.json({ success: true, members });
    } catch (err) {
        console.error("[groups/members/list] Processing error (stack logged server-side)");
        return res.status(500).json({ error: "Failed to list group members" });
    }
});

router.post("/:groupId/members", authMiddleware, (req, res) => {
    try {
        const { groupId } = req.params;
        const { memberAddress, role } = req.body || {};

        if (!groupId || groupId.trim().length === 0) {
            return res.status(400).json({ error: "groupId is required" });
        }
        if (!memberAddress) {
            return res.status(400).json({ error: "memberAddress is required" });
        }

        // Validate address format
        let validatedAddr;
        try {
            validatedAddr = validateAddress(memberAddress);
        } catch (er) {
            return res.status(400).json({ error: er.message });
        }

        if (role && (typeof role !== "string" || role.trim().length === 0)) {
            return res.status(400).json({ error: "role must be a non-empty string if provided" });
        }

        const result = groupSvc.addMember({
            groupId,
            requesterAddress: req.verifiedAddress,
            memberAddress: validatedAddr,
            role: role ? role.trim() : undefined,
        });
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error("[groups/members/add] Processing error (stack logged server-side)");
        return res.status(400).json({ error: "Failed to add group member" });
    }
});

router.delete("/:groupId/members/:memberAddress", authMiddleware, (req, res) => {
    try {
        const { groupId, memberAddress } = req.params;

        if (!groupId || groupId.trim().length === 0) {
            return res.status(400).json({ error: "groupId is required" });
        }
        if (!memberAddress) {
            return res.status(400).json({ error: "memberAddress is required" });
        }

        // Validate address format
        let validatedAddr;
        try {
            validatedAddr = validateAddress(memberAddress);
        } catch (er) {
            return res.status(400).json({ error: er.message });
        }

        const result = groupSvc.removeMember({
            groupId,
            requesterAddress: req.verifiedAddress,
            memberAddress: validatedAddr,
        });
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error("[groups/members/remove] Processing error (stack logged server-side)");
        return res.status(400).json({ error: "Failed to remove group member" });
    }
});

async function handleGroupShare(req, res, groupIdFromPath) {
    try {
        const body = req.body || {};
        const groupId = groupIdFromPath || body.groupId;
        const { fileId, expiryDurationSeconds } = body;

        // Input validation
        if (!groupId || groupId.trim().length === 0) {
            return res.status(400).json({ error: "groupId is required" });
        }
        if (fileId === undefined || fileId === null) {
            return res.status(400).json({ error: "fileId is required" });
        }
        if (!Number.isInteger(Number(fileId)) || Number(fileId) < 0) {
            return res.status(400).json({ error: "fileId must be a non-negative integer" });
        }
        if (expiryDurationSeconds !== undefined && (typeof expiryDurationSeconds !== "number" || expiryDurationSeconds < 0)) {
            return res.status(400).json({ error: "expiryDurationSeconds must be a non-negative number" });
        }

        const materials = materialsSvc.getFileMaterials(fileId);
        if (!materials) {
            return res.status(400).json({
                error: "Missing decryption materials for this fileId",
                fix: "Ensure uploader completed /api/materials/register for this file",
            });
        }

        const provider = getReadProvider();
        const accessControl = getContractAt(
            ADDRESSES.FileAccessControl,
            path.join(ARTIFACTS_ROOT, "AccessControl.sol", "FileAccessControl.json"),
            provider
        );
        const chainOwner = String(await accessControl.getFileOwner(fileId) || "").toLowerCase();
        const requester = req.verifiedAddress.toLowerCase();

        if (!chainOwner || chainOwner === ethers.constants.AddressZero.toLowerCase() || chainOwner !== requester) {
            console.warn(`[groups/share] Authorization denied: user=${req.verifiedAddress} file=${fileId} reason=not_owner`);
            return res.status(403).json({ error: "Only file owner can share to groups" });
        }

        const requesterGroups = groupSvc.listGroupsForUser(req.verifiedAddress);
        const isActiveMember = requesterGroups.some((g) => g.groupId === String(groupId));
        if (!isActiveMember) {
            console.warn(`[groups/share] Authorization denied: user=${req.verifiedAddress} group=${groupId} reason=not_group_member`);
            return res.status(403).json({ error: "Only active group members can share files to this group" });
        }

        // Self-heal stale owner metadata without changing encrypted content.
        if (String(materials.ownerAddress || "").toLowerCase() !== chainOwner) {
            materialsSvc.upsertFileMaterials({
                fileId,
                ownerAddress: chainOwner,
                cids: materials.cids,
                aesKeyHex: materials.aesKeyHex,
                ivs: materials.ivs,
                authTags: materials.authTags,
            });
        }

        const share = groupSvc.shareFileToGroup({
            groupId,
            fileId,
            ownerAddress: req.verifiedAddress,
            aesKeyHex: materials.aesKeyHex,
            expiryDurationSeconds,
        });

        gdprSvc.logAccess(req.verifiedAddress, String(fileId), "GROUP_SHARE_GRANTED", null);

        return res.json({
            success: true,
            share,
            message: share.recoveredGroupKey
                ? "Group share created. Group key was automatically recovered; previous active group shares were invalidated."
                : "Group share created. Active members can access until expiry.",
        });
    } catch (err) {
        if (String(err?.message || "").includes("Group key decryption failed")) {
            console.error("[groups/share] Group key decryption failed (check GROUP_KMS_KEY_HEX consistency)");
            return res.status(500).json({
                error: "Group key decryption failed. Ensure GROUP_KMS_KEY_HEX is consistent with the key used when this group was created.",
            });
        }
        if (String(err?.message || "").includes("Contract") || String(err?.message || "").includes("RPC")) {
            console.error("[groups/share] Contract/RPC error (stack logged server-side)");
            return res.status(500).json({ error: "Contract verification failed. Check RPC connection." });
        }
        console.error("[groups/share] Processing error (stack logged server-side)");
        return res.status(400).json({ error: err?.message || "Failed to share file with group" });
    }
}

router.post("/share", authMiddleware, async (req, res) => {
    return handleGroupShare(req, res, null);
});

router.post("/:groupId/share", authMiddleware, async (req, res) => {
    return handleGroupShare(req, res, req.params.groupId);
});

module.exports = router;
