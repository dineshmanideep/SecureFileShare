"use strict";

const crypto = require("crypto");
const gdprSvc = require("./gdprService");
const cpabeSvc = require("./cpabeService");

function addr(v) {
    return String(v || "").toLowerCase();
}

function nowMs() {
    return Date.now();
}

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

function runInTransaction(db, work) {
    if (typeof db.transaction === "function") {
        return db.transaction(work)();
    }

    db.exec("BEGIN");
    try {
        const result = work();
        db.exec("COMMIT");
        return result;
    } catch (err) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // ignore rollback failure; original error is more useful to caller
        }
        throw err;
    }
}

function getMasterKey() {
    const seed = (
        process.env.GROUP_KMS_KEY_HEX ||
        process.env.GROUP_KEY_KMS_HEX ||
        process.env.group_kms_key_hex ||
        process.env.group_key_kms_hex ||
        ""
    ).trim();

    if (!seed) {
        throw new Error(
            "GROUP_KMS_KEY_HEX environment variable is not set. " +
            "(Accepted aliases: GROUP_KEY_KMS_HEX, group_kms_key_hex, group_key_kms_hex). " +
            "Generate a 64-character hex key (32 random bytes) and add it to your .env file."
        );
    }

    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
        throw new Error(
            "GROUP_KMS_KEY_HEX must be exactly 64 hex characters (32 bytes). " +
            "Current value has incorrect format."
        );
    }

    return Buffer.from(seed, "hex");
}

function sealGroupKey(groupKey) {
    const key = getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(groupKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
}

function openGroupKey(cipherB64) {
    const key = getMasterKey();
    const buf = Buffer.from(cipherB64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function isGcmAuthFailure(err) {
    const msg = String(err?.message || "").toLowerCase();
    return msg.includes("unable to authenticate data") || msg.includes("unsupported state");
}

function wrapFileKeyWithGroupKey(fileKey, groupKey) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", groupKey, iv);
    const enc = Buffer.concat([cipher.update(fileKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
}

function unwrapFileKeyWithGroupKey(wrappedB64, groupKey) {
    const buf = Buffer.from(wrappedB64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", groupKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function getGroupById(groupId) {
    const db = gdprSvc.getDb();
    return db.prepare("SELECT * FROM groups WHERE groupId = ?").get(String(groupId));
}

function listGroupMembers(groupId) {
    const db = gdprSvc.getDb();
    return db
        .prepare(
            `SELECT userAddress, role, status, joinedAt
             FROM group_members
             WHERE groupId = ?
             ORDER BY joinedAt ASC`
        )
        .all(String(groupId));
}

function listGroupsForUser(userAddress) {
    const db = gdprSvc.getDb();
    return db
        .prepare(
            `SELECT g.groupId, g.name, g.ownerAddress, g.currentKeyVersion, g.status, g.createdAt,
                    gm.role,
                    (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.groupId = g.groupId AND gm2.status = 'active') AS memberCount
             FROM groups g
             JOIN group_members gm ON gm.groupId = g.groupId
             WHERE gm.userAddress = ? AND gm.status = 'active' AND g.status = 'active'
             ORDER BY g.createdAt DESC`
        )
        .all(addr(userAddress));
}

function ensureOwner(groupId, requesterAddress) {
    const g = getGroupById(groupId);
    if (!g) throw new Error("Group not found");
    if (addr(g.ownerAddress) !== addr(requesterAddress)) {
        throw new Error("Only group owner can perform this action");
    }
    if (g.status !== "active") throw new Error("Group is not active");
    return g;
}

function ensureActiveMember(groupId, requesterAddress) {
    const g = getGroupById(groupId);
    if (!g) throw new Error("Group not found");
    if (g.status !== "active") throw new Error("Group is not active");

    const db = gdprSvc.getDb();
    const membership = db
        .prepare(
            `SELECT status
             FROM group_members
             WHERE groupId = ? AND userAddress = ?`
        )
        .get(String(groupId), addr(requesterAddress));

    if (!membership || membership.status !== "active") {
        throw new Error("Only active group members can share files to this group");
    }

    return g;
}

function getGroupKey(groupId, version) {
    const db = gdprSvc.getDb();
    const row = db
        .prepare(
            `SELECT groupKeyCipherB64
             FROM group_key_versions
             WHERE groupId = ? AND keyVersion = ?`
        )
        .get(String(groupId), Number(version));

    if (!row) throw new Error("Group key version not found");
    try {
        return openGroupKey(row.groupKeyCipherB64);
    } catch (err) {
        if (isGcmAuthFailure(err)) {
            throw new Error(
                "Group key decryption failed. The server KMS key may have changed since this group was created."
            );
        }
        throw err;
    }
}

function recoverGroupKeyForWrites(groupId) {
    const db = gdprSvc.getDb();
    const nextVersionRow = db
        .prepare(
            `SELECT COALESCE(MAX(keyVersion), 0) + 1 AS nextVersion
             FROM group_key_versions
             WHERE groupId = ?`
        )
        .get(String(groupId));

    const nextVersion = Number(nextVersionRow?.nextVersion || 1);
    const newGroupKey = crypto.randomBytes(32);
    const sealed = sealGroupKey(newGroupKey);
    const ts = nowMs();

    runInTransaction(db, () => {
        db.prepare(
            `INSERT INTO group_key_versions (groupId, keyVersion, groupKeyCipherB64, createdAt)
             VALUES (?, ?, ?, ?)`
        ).run(String(groupId), nextVersion, sealed, ts);

        db.prepare(
            `UPDATE groups
             SET currentKeyVersion = ?, updatedAt = ?
             WHERE groupId = ?`
        ).run(nextVersion, ts, String(groupId));

        // Existing shares tied to broken key material are deactivated to avoid
        // repeated decryption failures for recipients.
        db.prepare(
            `UPDATE file_group_shares
             SET status = 'inactive', updatedAt = ?
             WHERE groupId = ? AND status = 'active'`
        ).run(ts, String(groupId));
    });

    return { groupKey: newGroupKey, keyVersion: nextVersion, recovered: true };
}

function rotateGroupKey(groupId, requesterAddress) {
    const db = gdprSvc.getDb();
    const group = ensureOwner(groupId, requesterAddress);

    const oldVersion = Number(group.currentKeyVersion || 1);
    const oldGroupKey = getGroupKey(groupId, oldVersion);

    const newVersion = oldVersion + 1;
    const newGroupKey = crypto.randomBytes(32);
    const sealed = sealGroupKey(newGroupKey);

    runInTransaction(db, () => {
        db.prepare(
            `INSERT INTO group_key_versions (groupId, keyVersion, groupKeyCipherB64, createdAt)
             VALUES (?, ?, ?, ?)`
        ).run(String(groupId), newVersion, sealed, nowMs());

        db.prepare(
            `UPDATE groups
             SET currentKeyVersion = ?, updatedAt = ?
             WHERE groupId = ?`
        ).run(newVersion, nowMs(), String(groupId));

        const shares = db
            .prepare(
                `SELECT fileId, wrappedFileKeyB64
                 FROM file_group_shares
                 WHERE groupId = ? AND status = 'active'`
            )
            .all(String(groupId));

        const activeMembers = db
            .prepare(
                `SELECT userAddress
                 FROM group_members
                 WHERE groupId = ? AND status = 'active'`
            )
            .all(String(groupId))
            .map((m) => m.userAddress);

        const cpabePolicy = cpabeSvc.isEnabled() ? cpabeSvc.groupMemberPolicy(activeMembers) : null;

        const updateShare = db.prepare(
            `UPDATE file_group_shares
             SET wrappedFileKeyB64 = ?, cpabePolicy = ?, cpabeCipherB64 = ?, keyVersion = ?, updatedAt = ?
             WHERE groupId = ? AND fileId = ?`
        );

        for (const s of shares) {
            const plainFileKey = unwrapFileKeyWithGroupKey(s.wrappedFileKeyB64, oldGroupKey);
            const rewrapped = wrapFileKeyWithGroupKey(plainFileKey, newGroupKey);
            const cpabeCipherB64 = cpabeSvc.isEnabled()
                ? cpabeSvc.encryptAesKeyHexForPolicy(plainFileKey.toString("hex"), cpabePolicy)
                : null;
            updateShare.run(
                rewrapped,
                cpabePolicy,
                cpabeCipherB64,
                newVersion,
                nowMs(),
                String(groupId),
                String(s.fileId)
            );
        }
    });

    return { success: true, keyVersion: newVersion };
}

function createGroup({ ownerAddress, name, members }) {
    const db = gdprSvc.getDb();
    const owner = addr(ownerAddress);
    if (!name || !String(name).trim()) throw new Error("Group name is required");

    const groupId = crypto.randomUUID();
    const ts = nowMs();

    const uniqueMembers = new Map();
    uniqueMembers.set(owner, { userAddress: owner, role: "owner" });

    for (const m of members || []) {
        const rawAddress = typeof m === "string"
            ? m
            : (m?.userAddress || m?.address);
        const userAddress = addr(rawAddress);
        if (!userAddress) continue;
        const role = String((typeof m === "object" && m?.role) ? m.role : "member").toLowerCase();
        uniqueMembers.set(userAddress, { userAddress, role: role === "owner" ? "member" : role });
    }

    const groupKey = crypto.randomBytes(32);
    const sealed = sealGroupKey(groupKey);

    runInTransaction(db, () => {
        db.prepare(
            `INSERT INTO groups (groupId, name, ownerAddress, currentKeyVersion, status, createdAt, updatedAt)
             VALUES (?, ?, ?, 1, 'active', ?, ?)`
        ).run(groupId, String(name).trim(), owner, ts, ts);

        const insertMember = db.prepare(
            `INSERT INTO group_members (groupId, userAddress, role, status, joinedAt)
             VALUES (?, ?, ?, 'active', ?)
             ON CONFLICT(groupId, userAddress) DO UPDATE SET
               role = excluded.role,
               status = 'active'`
        );

        for (const m of uniqueMembers.values()) {
            insertMember.run(groupId, m.userAddress, m.role, ts);
        }

        db.prepare(
            `INSERT INTO group_key_versions (groupId, keyVersion, groupKeyCipherB64, createdAt)
             VALUES (?, 1, ?, ?)`
        ).run(groupId, sealed, ts);
    });

    return {
        groupId,
        name: String(name).trim(),
        ownerAddress: owner,
        currentKeyVersion: 1,
        memberCount: uniqueMembers.size,
    };
}

function addMember({ groupId, requesterAddress, memberAddress, role }) {
    const db = gdprSvc.getDb();
    ensureOwner(groupId, requesterAddress);
    const member = addr(memberAddress);
    if (!member) throw new Error("memberAddress required");

    const normalizedRole = String(role || "member").toLowerCase();
    db.prepare(
        `INSERT INTO group_members (groupId, userAddress, role, status, joinedAt)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT(groupId, userAddress) DO UPDATE SET
           role = excluded.role,
           status = 'active'`
    ).run(String(groupId), member, normalizedRole === "owner" ? "member" : normalizedRole, nowMs());

    return rotateGroupKey(groupId, requesterAddress);
}

function removeMember({ groupId, requesterAddress, memberAddress }) {
    const db = gdprSvc.getDb();
    const group = ensureOwner(groupId, requesterAddress);
    const member = addr(memberAddress);
    if (!member) throw new Error("memberAddress required");
    if (member === addr(group.ownerAddress)) throw new Error("Owner cannot be removed from group");

    const result = db
        .prepare(
            `UPDATE group_members
             SET status = 'inactive'
             WHERE groupId = ? AND userAddress = ?`
        )
        .run(String(groupId), member);

    if (result.changes === 0) throw new Error("Member not found");

    return rotateGroupKey(groupId, requesterAddress);
}

function shareFileToGroup({ groupId, fileId, ownerAddress, aesKeyHex, expiryDurationSeconds }) {
    const db = gdprSvc.getDb();
    const group = ensureActiveMember(groupId, ownerAddress);
    if (!aesKeyHex || typeof aesKeyHex !== "string") throw new Error("aesKeyHex required");

    let keyVersion = Number(group.currentKeyVersion || 1);
    let groupKey;
    let recoveredGroupKey = false;
    try {
        groupKey = getGroupKey(groupId, keyVersion);
    } catch (err) {
        if (String(err?.message || "").includes("Group key decryption failed")) {
            const recovered = recoverGroupKeyForWrites(groupId);
            keyVersion = recovered.keyVersion;
            groupKey = recovered.groupKey;
            recoveredGroupKey = true;
        } else {
            throw err;
        }
    }
    const fileKey = Buffer.from(aesKeyHex, "hex");
    const wrappedFileKeyB64 = wrapFileKeyWithGroupKey(fileKey, groupKey);
    const members = listGroupMembers(groupId)
        .filter((m) => m.status === "active")
        .map((m) => m.userAddress);

    const cpabePolicy = cpabeSvc.isEnabled() ? cpabeSvc.groupMemberPolicy(members) : null;
    const cpabeCipherB64 = cpabeSvc.isEnabled()
        ? cpabeSvc.encryptAesKeyHexForPolicy(fileKey.toString("hex"), cpabePolicy)
        : null;

    const expiry = nowSec() + Number(expiryDurationSeconds || 3600);

    db.prepare(
                `INSERT INTO file_group_shares (fileId, groupId, ownerAddress, keyVersion, wrappedFileKeyB64, cpabePolicy, cpabeCipherB64, expiryTimestamp, status, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(fileId, groupId) DO UPDATE SET
           ownerAddress = excluded.ownerAddress,
           keyVersion = excluded.keyVersion,
           wrappedFileKeyB64 = excluded.wrappedFileKeyB64,
                     cpabePolicy = excluded.cpabePolicy,
                     cpabeCipherB64 = excluded.cpabeCipherB64,
           expiryTimestamp = excluded.expiryTimestamp,
           status = 'active',
           updatedAt = excluded.updatedAt`
        ).run(
                String(fileId),
                String(groupId),
                addr(ownerAddress),
                keyVersion,
                wrappedFileKeyB64,
                cpabePolicy,
                cpabeCipherB64,
                expiry,
                nowMs(),
                nowMs()
        );

    const memberCount = db
        .prepare(
            `SELECT COUNT(*) AS c FROM group_members WHERE groupId = ? AND status = 'active'`
        )
        .get(String(groupId)).c;

    return {
        fileId: String(fileId),
        groupId: String(groupId),
        keyVersion,
        expiryTimestamp: expiry,
        memberCount,
        recoveredGroupKey,
    };
}

function resolveGroupAccessForUser(fileId, userAddress) {
    const db = gdprSvc.getDb();
    const row = db
        .prepare(
            `SELECT fgs.fileId, fgs.groupId, fgs.ownerAddress, fgs.keyVersion, fgs.wrappedFileKeyB64,
                    fgs.cpabePolicy, fgs.cpabeCipherB64, fgs.expiryTimestamp
             FROM file_group_shares fgs
             JOIN group_members gm ON gm.groupId = fgs.groupId
             JOIN groups g ON g.groupId = fgs.groupId
             WHERE fgs.fileId = ?
               AND gm.userAddress = ?
               AND gm.status = 'active'
               AND fgs.status = 'active'
               AND g.status = 'active'
               AND fgs.expiryTimestamp > ?
             ORDER BY fgs.updatedAt DESC
             LIMIT 1`
        )
        .get(String(fileId), addr(userAddress), nowSec());

    if (!row) return null;

    let aesKeyHex;
    if (cpabeSvc.isEnabled() && row.cpabeCipherB64) {
        try {
            aesKeyHex = cpabeSvc.decryptAesKeyHexWithAttributes(row.cpabeCipherB64, [
                cpabeSvc.attrFromAddress(userAddress),
            ]);
        } catch (err) {
            console.warn(`[group-share] CP-ABE decrypt failed, falling back to wrapped key path: ${err.message}`);
            aesKeyHex = null;
        }
    }

    if (!aesKeyHex) {
        const groupKey = getGroupKey(row.groupId, row.keyVersion);
        const fileKey = unwrapFileKeyWithGroupKey(row.wrappedFileKeyB64, groupKey);
        aesKeyHex = fileKey.toString("hex");
    }

    return {
        fileId: row.fileId,
        groupId: row.groupId,
        ownerAddress: row.ownerAddress,
        expiryTimestamp: Number(row.expiryTimestamp) * 1000,
        aesKeyHex,
    };
}

function listGroupSharesForUser(userAddress) {
    const db = gdprSvc.getDb();
    const now = nowSec();
    return db
        .prepare(
            `SELECT fgs.fileId, fgs.groupId, fgs.ownerAddress, fgs.expiryTimestamp,
                    CASE WHEN fgs.expiryTimestamp > ? THEN 1 ELSE 0 END AS isAccessValid
             FROM file_group_shares fgs
             JOIN group_members gm ON gm.groupId = fgs.groupId
             JOIN groups g ON g.groupId = fgs.groupId
             WHERE gm.userAddress = ?
               AND gm.status = 'active'
               AND fgs.status = 'active'
               AND g.status = 'active'
             ORDER BY fgs.updatedAt DESC`
        )
        .all(now, addr(userAddress))
        .map((r) => ({
            fileId: Number(r.fileId),
            groupId: r.groupId,
            ownerAddress: r.ownerAddress,
            expiryTimestamp: Number(r.expiryTimestamp) * 1000,
            isAccessValid: Boolean(r.isAccessValid),
        }));
}

module.exports = {
    createGroup,
    listGroupsForUser,
    listGroupMembers,
    addMember,
    removeMember,
    shareFileToGroup,
    resolveGroupAccessForUser,
    listGroupSharesForUser,
};
