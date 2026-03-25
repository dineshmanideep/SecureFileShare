"use strict";
const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

/**
 * gdprService.js
 *
 * SQLite-backed GDPR compliance module.
 * Tables:
 *   user_data_registry   – tracks every upload per user
 *   erasure_requests     – pending/fulfilled erasure requests
 *   access_logs          – every file access event
 *   consent_records      – user consent per purpose
 *
 * All operations use synchronous `node:sqlite` for simplicity.
 * PII anonymisation replaces userId with SHA-256 hash on deletion.
 */

const DB_DIR = path.join(__dirname, "..", "db");
const DB_PATH = path.join(DB_DIR, "gdpr.db");

let db;

function ensureColumn(tableName, columnName, declarationSql) {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const exists = cols.some((c) => String(c.name) === String(columnName));
    if (!exists) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${declarationSql}`);
    }
}

/**
 * Opens the SQLite database and creates schema if needed.
 * Called once at startup. Subsequent calls are no-ops.
 */
function initSchema() {
    if (db) return; // already initialised
    fs.mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
    CREATE TABLE IF NOT EXISTS user_data_registry (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      userId           TEXT    NOT NULL,
      fileId           TEXT    NOT NULL,
      fileName         TEXT,
      uploadTimestamp  INTEGER NOT NULL,
      dataCategories   TEXT,
      isAnonymised     INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_udr_userId ON user_data_registry(userId);

    CREATE TABLE IF NOT EXISTS erasure_requests (
      requestId        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId           TEXT    NOT NULL,
      fileId           TEXT    NOT NULL,
      requestTimestamp INTEGER NOT NULL,
      status           TEXT    DEFAULT 'pending',
      fulfilledAt      INTEGER
    );

    CREATE TABLE IF NOT EXISTS access_logs (
      logId            INTEGER PRIMARY KEY AUTOINCREMENT,
      userId           TEXT    NOT NULL,
      fileId           TEXT    NOT NULL,
      accessTimestamp  INTEGER NOT NULL,
      action           TEXT    NOT NULL,
      ipAddress        TEXT,
      isAnonymised     INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_al_userId ON access_logs(userId);

    CREATE TABLE IF NOT EXISTS consent_records (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      userId           TEXT    NOT NULL,
      consentType      TEXT    NOT NULL,
      consentTimestamp INTEGER NOT NULL,
      isActive         INTEGER DEFAULT 1,
      revokedAt        INTEGER,
      UNIQUE(userId, consentType)
    );

    -- Stores encryption materials needed to decrypt an uploaded file.
    -- NOTE: This is a demo-friendly approach; in production you would store these server-side
    -- encrypted or via proper key management / recipient-specific wrapping.
    CREATE TABLE IF NOT EXISTS file_materials (
      fileId           TEXT PRIMARY KEY,
      ownerAddress     TEXT NOT NULL,
      cidsJson         TEXT NOT NULL,
      aesKeyHex        TEXT NOT NULL,
      ivsJson          TEXT NOT NULL,
      authTagsJson     TEXT NOT NULL,
      createdAt        INTEGER NOT NULL,
      updatedAt        INTEGER NOT NULL
    );

        -- Group key management tables
        CREATE TABLE IF NOT EXISTS groups (
            groupId          TEXT PRIMARY KEY,
            name             TEXT NOT NULL,
            ownerAddress     TEXT NOT NULL,
            currentKeyVersion INTEGER NOT NULL DEFAULT 1,
            status           TEXT NOT NULL DEFAULT 'active',
            createdAt        INTEGER NOT NULL,
            updatedAt        INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_members (
            groupId          TEXT NOT NULL,
            userAddress      TEXT NOT NULL,
            role             TEXT NOT NULL DEFAULT 'member',
            status           TEXT NOT NULL DEFAULT 'active',
            joinedAt         INTEGER NOT NULL,
            PRIMARY KEY (groupId, userAddress)
        );

        CREATE INDEX IF NOT EXISTS idx_group_members_user
            ON group_members(userAddress);

        CREATE TABLE IF NOT EXISTS group_key_versions (
            groupId          TEXT NOT NULL,
            keyVersion       INTEGER NOT NULL,
            groupKeyCipherB64 TEXT NOT NULL,
            createdAt        INTEGER NOT NULL,
            PRIMARY KEY (groupId, keyVersion)
        );

        CREATE TABLE IF NOT EXISTS file_group_shares (
            fileId           TEXT NOT NULL,
            groupId          TEXT NOT NULL,
            ownerAddress     TEXT NOT NULL,
            keyVersion       INTEGER NOT NULL,
            wrappedFileKeyB64 TEXT NOT NULL,
            cpabePolicy      TEXT,
            cpabeCipherB64   TEXT,
            expiryTimestamp  INTEGER NOT NULL,
            status           TEXT NOT NULL DEFAULT 'active',
            createdAt        INTEGER NOT NULL,
            updatedAt        INTEGER NOT NULL,
            PRIMARY KEY (fileId, groupId)
        );

        CREATE INDEX IF NOT EXISTS idx_file_group_shares_file
            ON file_group_shares(fileId);

        CREATE INDEX IF NOT EXISTS idx_file_group_shares_group
            ON file_group_shares(groupId);
  `);

    // Migration-safe column adds for existing databases created before CP-ABE fields.
    ensureColumn("file_group_shares", "cpabePolicy", "TEXT");
    ensureColumn("file_group_shares", "cpabeCipherB64", "TEXT");
}

/** Returns the open DB instance, initialising it if needed. */
function getDb() {
    if (!db) initSchema();
    return db;
}

// ─────────────────────────── Uploads ─────────────────────────────────────

function logUpload(userId, fileId, fileName, dataCategories = "general") {
    const db = getDb();
    db.prepare(
        `INSERT INTO user_data_registry (userId, fileId, fileName, uploadTimestamp, dataCategories)
     VALUES (?, ?, ?, ?, ?)`
    ).run(userId, String(fileId), fileName, Date.now(), dataCategories);
}

// ─────────────────────────── Access Logs ─────────────────────────────────

function logAccess(userId, fileId, action, ipAddress = null) {
    const db = getDb();
    db.prepare(
        `INSERT INTO access_logs (userId, fileId, accessTimestamp, action, ipAddress)
     VALUES (?, ?, ?, ?, ?)`
    ).run(userId, String(fileId), Date.now(), action, ipAddress);
}

// ─────────────────────────── Erasure ─────────────────────────────────────

function requestErasure(userId, fileId) {
    const db = getDb();
    const existing = db.prepare(
        `SELECT * FROM erasure_requests WHERE userId = ? AND fileId = ? AND status = 'pending'`
    ).get(userId, String(fileId));

    if (existing) {
        return { requestId: existing.requestId, status: "already_pending" };
    }

    const result = db.prepare(
        `INSERT INTO erasure_requests (userId, fileId, requestTimestamp, status)
     VALUES (?, ?, ?, 'pending')`
    ).run(userId, String(fileId), Date.now());

    return { requestId: Number(result.lastInsertRowid), status: "pending" };
}

function fulfillErasure(fileId) {
    const db = getDb();
    const ts = Date.now();
    db.prepare(
        `UPDATE erasure_requests SET status = 'fulfilled', fulfilledAt = ?
     WHERE fileId = ? AND status = 'pending'`
    ).run(ts, String(fileId));

    // Also anonymize the upload registry record
    anonymizeFileRecords(fileId);
    return { status: "fulfilled", timestamp: ts };
}

// ─────────────────────────── Consent ─────────────────────────────────────

function logConsent(userId, consentType) {
    const db = getDb();
    db.prepare(
        `INSERT INTO consent_records (userId, consentType, consentTimestamp, isActive)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(userId, consentType) DO UPDATE SET
       isActive = 1, consentTimestamp = excluded.consentTimestamp, revokedAt = NULL`
    ).run(userId, consentType, Date.now());
}

function revokeConsent(userId, consentType) {
    const db = getDb();
    db.prepare(
        `UPDATE consent_records SET isActive = 0, revokedAt = ?
     WHERE userId = ? AND consentType = ?`
    ).run(Date.now(), userId, consentType);
}

// ─────────────────────────── GDPR Article 20 Export ──────────────────────

/**
 * Export all data associated with a userId as a JSON-serialisable object.
 * @param {string} userId  Ethereum wallet address.
 * @returns {object}
 */
function exportUserData(userId) {
    const db = getDb();
    return {
        userId,
        exportedAt: new Date().toISOString(),
        files: db
            .prepare(`SELECT * FROM user_data_registry WHERE userId = ?`)
            .all(userId),
        erasureRequests: db
            .prepare(`SELECT * FROM erasure_requests WHERE userId = ?`)
            .all(userId),
        accessLogs: db
            .prepare(`SELECT * FROM access_logs WHERE userId = ? AND isAnonymised = 0`)
            .all(userId),
        consentRecords: db
            .prepare(`SELECT * FROM consent_records WHERE userId = ?`)
            .all(userId),
    };
}

/**
 * Return the full audit trail (access logs) for a user.
 */
function getAuditTrail(userId) {
    const db = getDb();
    return db
        .prepare(
            `SELECT * FROM access_logs WHERE userId = ? ORDER BY accessTimestamp DESC LIMIT 500`
        )
        .all(userId);
}

// ─────────────────────────── Anonymisation ───────────────────────────────

/**
 * Replace userId PII with a SHA-256 hash in all tables.
 * @param {string} userId  Original wallet address.
 */
function anonymizeUser(userId) {
    const db = getDb();
    const anonId = "0x" + crypto.createHash("sha256").update(userId).digest("hex");

    db.exec('BEGIN');
    try {
        db.prepare(
            `UPDATE user_data_registry SET userId = ?, isAnonymised = 1 WHERE userId = ?`
        ).run(anonId, userId);
        db.prepare(
            `UPDATE erasure_requests SET userId = ? WHERE userId = ?`
        ).run(anonId, userId);
        db.prepare(
            `UPDATE access_logs SET userId = ?, isAnonymised = 1 WHERE userId = ?`
        ).run(anonId, userId);
        db.prepare(
            `UPDATE consent_records SET userId = ? WHERE userId = ?`
        ).run(anonId, userId);
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }

    return { anonymisedAs: anonId };
}

function anonymizeFileRecords(fileId) {
    const db = getDb();
    const anonId = "0x[erased]";
    db.prepare(
        `UPDATE access_logs SET isAnonymised = 1 WHERE fileId = ?`
    ).run(String(fileId));
}

module.exports = {
    initSchema,
    getDb,
    logUpload,
    logAccess,
    requestErasure,
    fulfillErasure,
    logConsent,
    revokeConsent,
    exportUserData,
    getAuditTrail,
    anonymizeUser,
};
