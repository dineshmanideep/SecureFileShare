"use strict";
const crypto = require("crypto");

/**
 * encryptionService.js
 *
 * AES-256-GCM file encryption, SHA-256 chunk integrity, and ECDH key wrapping.
 * All operations use Node.js built-in `crypto` module — no external deps.
 */

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks

// ─────────────────────────── Key Pair ─────────────────────────────────────

/**
 * Generate an ECDH key pair (P-256 curve).
 * @returns {{ privateKey: string, publicKey: string }}  PEM-encoded keys
 */
function generateKeyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
        namedCurve: "P-256",
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    return { privateKey, publicKey };
}

// ─────────────────────────── AES-256-GCM Encrypt ──────────────────────────

/**
 * Encrypt a file buffer in 64 KB chunks using AES-256-GCM.
 * @param {Buffer} buffer  Raw file content.
 * @returns {{ encryptedChunks: Buffer[], aesKey: Buffer, hashes: string[], ivs: Buffer[] }}
 */
function encryptFile(buffer) {
    const aesKey = crypto.randomBytes(32); // 256-bit key
    const encryptedChunks = [];
    const hashes = [];
    const ivs = [];
    const authTags = [];

    for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
        const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);

        // AES-256-GCM
        const iv = crypto.randomBytes(12); // 96-bit IV for GCM
        const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
        const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
        const authTag = cipher.getAuthTag();

        // SHA-256 of the plaintext chunk for integrity
        const hash = crypto.createHash("sha256").update(chunk).digest("hex");

        encryptedChunks.push(encrypted);
        ivs.push(iv);
        authTags.push(authTag);
        hashes.push(hash);
    }

    return { encryptedChunks, aesKey, hashes, ivs, authTags };
}

/**
 * Decrypt chunks produced by encryptFile().
 * @param {Buffer[]} encryptedChunks
 * @param {Buffer}   aesKey
 * @param {Buffer[]} ivs
 * @param {Buffer[]} authTags
 * @returns {Buffer}  Reassembled plaintext buffer.
 */
function decryptFile(encryptedChunks, aesKey, ivs, authTags) {
    const parts = [];
    for (let i = 0; i < encryptedChunks.length; i++) {
        const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, ivs[i]);
        decipher.setAuthTag(authTags[i]);
        const decrypted = Buffer.concat([
            decipher.update(encryptedChunks[i]),
            decipher.final(),
        ]);
        parts.push(decrypted);
    }
    return Buffer.concat(parts);
}

// ─────────────────────────── Key Wrapping ─────────────────────────────────

/**
 * Wrap an AES key with the recipient's public key using ECDH + AES-256-GCM.
 * @param {Buffer} aesKey              The key to wrap.
 * @param {string} recipientPublicKeyPem  Recipient ECDH public key (PEM).
 * @returns {{ wrappedKey: string, ephemeralPublicKey: string }}  Base64-encoded.
 */
function wrapKey(aesKey, recipientPublicKeyPem) {
    // Generate ephemeral key pair for ECDH
    const ephemeral = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const recipientKey = crypto.createPublicKey(recipientPublicKeyPem);

    // Compute shared secret
    const sharedSecret = crypto.diffieHellman({
        privateKey: ephemeral.privateKey,
        publicKey: recipientKey,
    });

    // Derive wrapping key using HKDF (RFC 5869) — never use raw shared secret or plain hash.
    const wrappingKey = crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), "ECDH-AES-key-wrap", 32);

    // Encrypt AES key with wrapping key
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", wrappingKey, iv);
    const enc = Buffer.concat([cipher.update(aesKey), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const wrapped = Buffer.concat([iv, authTag, enc]).toString("base64");
    const ephPub = ephemeral.publicKey.export({ type: "spki", format: "pem" });

    return { wrappedKey: wrapped, ephemeralPublicKey: ephPub };
}

/**
 * Unwrap an AES key using the recipient's private key.
 * @param {string} wrappedKeyB64        Base64 wrapped key from wrapKey().
 * @param {string} ephemeralPublicKeyPem Ephemeral public key from wrapKey().
 * @param {string} privateKeyPem        Recipient's private key (PEM).
 * @returns {Buffer}  The original AES key.
 */
function unwrapKey(wrappedKeyB64, ephemeralPublicKeyPem, privateKeyPem) {
    const buf = Buffer.from(wrappedKeyB64, "base64");
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const enc = buf.subarray(28);

    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const ephPublicKey = crypto.createPublicKey(ephemeralPublicKeyPem);

    const sharedSecret = crypto.diffieHellman({ privateKey, publicKey: ephPublicKey });
    const wrappingKey = crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), "ECDH-AES-key-wrap", 32);

    const decipher = crypto.createDecipheriv("aes-256-gcm", wrappingKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// ─────────────────────────── Integrity ────────────────────────────────────

/**
 * Verify the SHA-256 hash of a plaintext chunk.
 * @param {Buffer} chunk       Plaintext chunk.
 * @param {string} storedHash  Hex hash stored at upload time.
 * @returns {boolean}
 */
function verifyIntegrity(chunk, storedHash) {
    const computed = crypto.createHash("sha256").update(chunk).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
}

/**
 * Compute SHA-256 hash of a buffer.
 * @param {Buffer} data
 * @returns {string}  Hex digest.
 */
function sha256(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

module.exports = {
    generateKeyPair,
    encryptFile,
    decryptFile,
    wrapKey,
    unwrapKey,
    verifyIntegrity,
    sha256,
    CHUNK_SIZE,
};
