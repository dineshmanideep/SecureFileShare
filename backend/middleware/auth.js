"use strict";
const { ethers } = require("ethers");

/**
 * auth.js – Ethereum signature-based authentication middleware.
 *
 * Every protected route must include the following headers:
 *   x-user-address   : Ethereum address e.g. "0xABCD..."
 *   x-signature      : ethers.utils.signMessage result
 *   x-message        : The plaintext message that was signed
 *
 * The message format is: `SecureFileShare:${timestamp}:${userAddress}:${nonce}`
 * where timestamp is a Unix timestamp (seconds) within ±5 minutes of server time.
 *
 * Replay protection: each signed message may only be used ONCE within
 * the validity window.  A compact in-memory nonce store tracks seen tokens and
 * flushes expired entries every minute.
 */

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 minutes

// ─── Nonce / Replay-protection store ─────────────────────────────────────────
// Key: `keccak256(message)` → expiresAt (ms)
const _seenNonces = new Map();

function _pruneNonces() {
    const now = Date.now();
    for (const [key, expiresAt] of _seenNonces) {
        if (now > expiresAt) _seenNonces.delete(key);
    }
}
// Flush stale nonces every 60 seconds to prevent unbounded growth.
setInterval(_pruneNonces, 60_000).unref();

// ─────────────────────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
    try {
        const address = req.headers["x-user-address"];
        const signature = req.headers["x-signature"];
        const message = req.headers["x-message"];

        if (!address || !signature || !message) {
            return res.status(401).json({
                error: "Authentication required: x-user-address, x-signature, x-message headers",
            });
        }

        // Validate Ethereum address format
        let normalizedAddress;
        try {
            normalizedAddress = ethers.utils.getAddress(address).toLowerCase();
        } catch {
            return res.status(401).json({ error: "Invalid Ethereum address format" });
        }

        // Parse and validate timestamp in message
        const parts = message.split(":");
        if (parts.length < 4 || parts[0] !== "SecureFileShare") {
            return res.status(401).json({ error: "Invalid message format" });
        }

        const msgTimestampSec = parseInt(parts[1], 10);
        if (!Number.isInteger(msgTimestampSec)) {
            return res.status(401).json({ error: "Invalid timestamp in message" });
        }

        let messageAddress;
        try {
            messageAddress = ethers.utils.getAddress(parts[2]).toLowerCase();
        } catch {
            return res.status(401).json({ error: "Invalid address in signed message" });
        }

        if (messageAddress !== normalizedAddress) {
            return res.status(403).json({ error: "Address mismatch in signed message" });
        }

        const msgTimestampMs = msgTimestampSec * 1000;
        if (Math.abs(Date.now() - msgTimestampMs) > MAX_TIMESTAMP_SKEW_MS) {
            return res.status(401).json({ error: "Signature expired (>5 minutes)" });
        }

        // Replay protection: reject re-use of the same signed message.
        const nonceKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(message));
        if (_seenNonces.has(nonceKey)) {
            return res.status(401).json({ error: "Replayed signature rejected" });
        }

        // Verify the Ethereum signature
        const recoveredAddress = ethers.utils.verifyMessage(message, signature);
        if (recoveredAddress.toLowerCase() !== normalizedAddress) {
            return res.status(403).json({ error: "Signature verification failed" });
        }

        // Record nonce so the same (address, timestamp) cannot be replayed.
        _seenNonces.set(nonceKey, msgTimestampMs + MAX_TIMESTAMP_SKEW_MS);

        // Attach verified address to request
        req.verifiedAddress = normalizedAddress;
        next();
    } catch (err) {
        // Never leak internal error details
        res.status(401).json({ error: "Authentication failed" });
    }
}

module.exports = { authMiddleware };
