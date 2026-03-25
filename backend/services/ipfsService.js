"use strict";
const axios = require("axios");
const FormData = require("form-data");
const config = require("../envConfig");

/**
 * ipfsService.js
 *
 * Connects to Pinata IPFS (via centralized .env configuration)
 * Provides chunked upload/download with progress, pin management,
 * and availability checks.
 *
 * Uses environment variables from: ../envConfig.js
 * Which loads from project root .env file
 */

const PINATA_API_URL = config.pinata.apiBaseUrl;
const PINATA_GATEWAY = config.pinata.gateway;
const PINATA_GATEWAY_TOKEN = process.env.PINATA_GATEWAY_TOKEN || "";
const MAX_RETRIES = Number(process.env.IPFS_RETRIEVE_RETRIES || 8);
const RETRY_BASE_DELAY_MS = Number(process.env.IPFS_RETRY_BASE_DELAY_MS || 1500);
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.IPFS_RATE_LIMIT_COOLDOWN_MS || 10000);
const INTER_CHUNK_DELAY_MS = Number(process.env.IPFS_INTER_CHUNK_DELAY_MS || 200);

function getPinataHeaders() {
    return {
        pinata_api_key: config.pinata.apiKey,
        pinata_secret_api_key: config.pinata.apiSecret,
    };
}

/**
 * Upload an array of encrypted chunk Buffers to Pinata IPFS.
 * Each chunk is stored as a separate IPFS object.
 *
 * @param {Buffer[]} encryptedChunks
 * @param {Function} [onProgress]  Called with ({chunkIndex, total, cid}) after each chunk.
 * @returns {Promise<string[]>}    Array of IPFS CIDs matching chunk order.
 */
async function uploadChunks(encryptedChunks, onProgress) {
    const cids = [];
    const headers = getPinataHeaders();

    for (let i = 0; i < encryptedChunks.length; i++) {
        const chunk = encryptedChunks[i];
        const formData = new FormData();
        // In Node, use form-data to build multipart; do NOT rely on browser Blob/FormData globals.
        formData.append("file", chunk, {
            filename: `chunk-${i}.bin`,
            contentType: "application/octet-stream",
        });
        formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
        formData.append("pinataMetadata", JSON.stringify({ name: `chunk-${i}` }));

        try {
            const response = await axios.post(`${PINATA_API_URL}/pinning/pinFileToIPFS`, formData, {
                headers: {
                    ...headers,
                    ...formData.getHeaders(),
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                timeout: 60000,
            });

            const cid = response.data.IpfsHash;
            cids.push(cid);

            if (onProgress) {
                onProgress({ chunkIndex: i, total: encryptedChunks.length, cid });
            }
        } catch (err) {
            console.error(`[uploadChunks] Failed to upload chunk ${i}:`, err.message);
            throw err;
        }
    }

    return cids;
}

/**
 * Retrieve an ordered set of encrypted chunks from Pinata IPFS by CID array.
 *
 * @param {string[]} cids  CIDs in chunk order.
 * @returns {Promise<Buffer[]>}  Encrypted chunk buffers in order.
 */
// CIDv0: Qm + 44 base58btc chars (46 total); CIDv1: b + base32 lower-case
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;

function validateCid(cid) {
    if (typeof cid !== "string" || !CID_RE.test(cid)) {
        throw new Error(`Invalid or unsafe CID format: ${String(cid).slice(0, 60)}`);
    }
}

function normalizeGateway(base) {
    return String(base || "https://gateway.pinata.cloud").replace(/\/+$/, "");
}

function isRetryableError(err) {
    const status = err?.response?.status;
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    const code = err?.code || "";
    return ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code);
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(err) {
    const raw = err?.response?.headers?.["retry-after"];
    if (!raw) return null;
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum >= 0) {
        return asNum * 1000;
    }
    const asDate = Date.parse(raw);
    if (!Number.isNaN(asDate)) {
        const delta = asDate - Date.now();
        return delta > 0 ? delta : 0;
    }
    return null;
}

function computeRetryDelayMs(err, attempt) {
    const status = err?.response?.status;
    if (status === 429) {
        return parseRetryAfterMs(err) ?? RATE_LIMIT_COOLDOWN_MS;
    }
    return RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

async function fetchCidWithRetry(cid) {
    const gateway = normalizeGateway(PINATA_GATEWAY);
    const gatewayTokenQuery = PINATA_GATEWAY_TOKEN
        ? `?pinataGatewayToken=${encodeURIComponent(PINATA_GATEWAY_TOKEN)}`
        : "";
    const url = `${gateway}/ipfs/${cid}${gatewayTokenQuery}`;
    const authHeaders = {
        Accept: "application/octet-stream,*/*",
        "User-Agent": "SecureFileShare/1.0",
    };
    if (config.pinata.apiKey && config.pinata.apiSecret) {
        authHeaders.pinata_api_key = config.pinata.apiKey;
        authHeaders.pinata_secret_api_key = config.pinata.apiSecret;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await axios.get(url, {
                responseType: "arraybuffer",
                timeout: 45000,
                validateStatus: (status) => status >= 200 && status < 300,
                headers: authHeaders,
            });

            return Buffer.from(response.data);
        } catch (err) {
            if (attempt >= MAX_RETRIES || !isRetryableError(err)) {
                const detail = err.response?.status ? `HTTP ${err.response.status}` : (err.code || err.message);
                const rateLimitHint = err.response?.status === 429
                    ? " (Pinata gateway rate-limited this client. Configure PINATA_GATEWAY_TOKEN for a dedicated authenticated gateway.)"
                    : "";
                const finalError = new Error(`Failed to retrieve CID ${cid}: ${detail}${rateLimitHint}`);
                finalError.cause = err;
                throw finalError;
            }

            const delay = computeRetryDelayMs(err, attempt);
            await wait(delay);
        }
    }

    throw new Error(`Failed to retrieve CID ${cid}: unknown retrieval error`);
}

async function retrieveChunks(cids) {
    const chunks = [];

    for (let i = 0; i < cids.length; i++) {
        const cid = cids[i];
        validateCid(cid);
        try {
            const chunk = await fetchCidWithRetry(cid);
            chunks.push(chunk);
            // Pacing avoids immediate gateway throttling when files have many chunks.
            if (INTER_CHUNK_DELAY_MS > 0 && i < cids.length - 1) {
                await wait(INTER_CHUNK_DELAY_MS);
            }
        } catch (err) {
            console.error(
                `[retrieveChunks] Failed to retrieve CID ${cid}:`,
                err.message
            );
            throw err;
        }
    }

    return chunks;
}

/**
 * Pin a CID explicitly via Pinata.
 * @param {string} cid
 */
async function pinFile(cid) {
    const headers = getPinataHeaders();

    try {
        await axios.post(
            `${PINATA_API_URL}/pinning/pinByHash`,
            { hashToPin: cid },
            { headers }
        );
    } catch (err) {
        console.error(`[pinFile] Failed to pin CID ${cid}:`, err.message);
        throw err;
    }
}

/**
 * Unpin a CID from Pinata (GDPR erasure — allows content to be removed).
 * @param {string} cid
 */
async function unpinFile(cid) {
    const headers = getPinataHeaders();

    try {
        await axios.delete(`${PINATA_API_URL}/pinning/unpin/${cid}`, { headers });
    } catch (err) {
        // Silently ignore "not found" errors
        if (err.response?.status === 404 || err.message.includes("not found")) {
            console.warn(`[unpinFile] CID ${cid} not found on Pinata, skipping.`);
            return;
        }
        console.error(`[unpinFile] Failed to unpin CID ${cid}:`, err.message);
        throw err;
    }
}

/**
 * Check whether a CID is pinned on Pinata.
 * @param {string} cid
 * @returns {Promise<boolean>}
 */
async function checkAvailability(cid) {
    const headers = getPinataHeaders();

    try {
        const response = await axios.get(`${PINATA_API_URL}/data/pinList`, {
            params: { hashContains: cid },
            headers,
        });

        if (response.data.rows && response.data.rows.length > 0) {
            return response.data.rows.some((pin) => pin.ipfs_pin_hash === cid);
        }
        return false;
    } catch (err) {
        console.error(`[checkAvailability] Failed to check CID ${cid}:`, err.message);
        return false;
    }
}

/**
 * Get Pinata account usage statistics.
 * (Replacement for local garbage collection)
 */
async function getAccountStats() {
    const headers = getPinataHeaders();

    try {
        const response = await axios.get(`${PINATA_API_URL}/data/userPinnedDataTotal`, {
            headers,
        });
        return response.data;
    } catch (err) {
        console.error("[getAccountStats] Failed to fetch account stats:", err.message);
        throw err;
    }
}

/**
 * List all pinned files on Pinata.
 */
async function listPinnedFiles() {
    const headers = getPinataHeaders();

    try {
        const response = await axios.get(`${PINATA_API_URL}/data/pinList`, {
            headers,
        });
        return response.data.rows || [];
    } catch (err) {
        console.error("[listPinnedFiles] Failed to list pinned files:", err.message);
        throw err;
    }
}

module.exports = {
    uploadChunks,
    retrieveChunks,
    pinFile,
    unpinFile,
    checkAvailability,
    getAccountStats,
    listPinnedFiles,
};
