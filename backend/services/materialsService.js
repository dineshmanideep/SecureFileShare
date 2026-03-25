"use strict";

const gdprSvc = require("./gdprService");

// ─── Pending materials store ──────────────────────────────────────────────────
// After upload, materials are held here (keyed by fileHashHex) until the client
// confirms the on-chain fileId via /api/materials/register.  The AES key never
// leaves the backend: the client only exchanges the hash.
// Each entry expires after 30 minutes to prevent unbounded growth.
const PENDING_TTL_MS = 30 * 60 * 1000;
const _pendingStore = new Map(); // fileHashHex → { materials, expiresAt }

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _pendingStore) {
        if (now > v.expiresAt) _pendingStore.delete(k);
    }
}, 5 * 60 * 1000).unref();

function storePendingMaterials(fileHashHex, materials) {
    _pendingStore.set(fileHashHex.toLowerCase(), {
        materials,
        expiresAt: Date.now() + PENDING_TTL_MS,
    });
}

function promotePendingToFileId(fileHashHex, fileId, ownerAddress) {
    const entry = _pendingStore.get(fileHashHex.toLowerCase());
    if (!entry) return false;
    const m = entry.materials;
    upsertFileMaterials({
        fileId,
        ownerAddress,
        cids: m.cids,
        aesKeyHex: m.aesKeyHex,
        ivs: m.ivs,
        authTags: m.authTags,
    });
    _pendingStore.delete(fileHashHex.toLowerCase());
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────

function upsertFileMaterials({
    fileId,
    ownerAddress,
    cids,
    aesKeyHex,
    ivs,
    authTags,
}) {
    const db = gdprSvc.getDb();
    const now = Date.now();
    const stmt = db.prepare(`
    INSERT INTO file_materials (fileId, ownerAddress, cidsJson, aesKeyHex, ivsJson, authTagsJson, createdAt, updatedAt)
    VALUES (@fileId, @ownerAddress, @cidsJson, @aesKeyHex, @ivsJson, @authTagsJson, @now, @now)
    ON CONFLICT(fileId) DO UPDATE SET
      ownerAddress = excluded.ownerAddress,
      cidsJson = excluded.cidsJson,
      aesKeyHex = excluded.aesKeyHex,
      ivsJson = excluded.ivsJson,
      authTagsJson = excluded.authTagsJson,
      updatedAt = excluded.updatedAt
  `);

    stmt.run({
        fileId: String(fileId),
        ownerAddress: ownerAddress.toLowerCase(),
        cidsJson: JSON.stringify(cids || []),
        aesKeyHex,
        ivsJson: JSON.stringify(ivs || []),
        authTagsJson: JSON.stringify(authTags || []),
        now,
    });
}

function getFileMaterials(fileId) {
    const db = gdprSvc.getDb();
    const row = db
        .prepare(`SELECT * FROM file_materials WHERE fileId = ?`)
        .get(String(fileId));
    if (!row) return null;
    return {
        fileId: row.fileId,
        ownerAddress: row.ownerAddress,
        cids: JSON.parse(row.cidsJson || "[]"),
        aesKeyHex: row.aesKeyHex,
        ivs: JSON.parse(row.ivsJson || "[]"),
        authTags: JSON.parse(row.authTagsJson || "[]"),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

module.exports = { storePendingMaterials, promotePendingToFileId, upsertFileMaterials, getFileMaterials };

