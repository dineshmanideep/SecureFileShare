"use strict";
const express = require("express");
const multer = require("multer");
const router = express.Router();

const { authMiddleware } = require("../middleware/auth");
const encSvc = require("../services/encryptionService");
const ipfsSvc = require("../services/ipfsService");
const gdprSvc = require("../services/gdprService");
const materialsSvc = require("../services/materialsService");

// zkpService is not implemented in midsem submission (65% complete)
let zkpSvc = null;
try {
    zkpSvc = require("../services/zkpService");
} catch {
    console.warn("[upload] zkpService not available (expected in 65% midsem submission)");
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

/**
 * POST /api/upload
 * Requires authentication (x-user-address / x-signature / x-message headers).
 * Encrypts file → uploads to IPFS → generates ZKP (if available) → stores materials server-side.
 * The AES key is NEVER returned to the client; it is held in a server-side pending
 * store keyed by fileHashHex.  The client must call /api/materials/register with
 * { fileId, fileHashHex } to promote the pending record to a permanent one.
 */
router.post("/", authMiddleware, upload.single("file"), async (req, res) => {
    try {
        const { fileName } = req.body;
        const userAddress = req.verifiedAddress; // always use the cryptographically verified address
        if (!req.file) return res.status(400).json({ error: "No file provided" });

        // ── Stage 1: Encrypt ──────────────────────────────────────────────────
        const fileBuffer = req.file.buffer;
        const { encryptedChunks, aesKey, hashes, ivs, authTags } =
            encSvc.encryptFile(fileBuffer);

        // SHA-256 of the plaintext file (for ZKP + on-chain storage)
        const fileHashHex = encSvc.sha256(fileBuffer);

        // ── Stage 2: Upload to IPFS ───────────────────────────────────────────
        // Mock IPFS is NOT allowed in production. This ensures all files are persisted.
        let cids;
        try {
            cids = await ipfsSvc.uploadChunks(encryptedChunks);
        } catch (ipfsErr) {
            console.error("[upload] IPFS upload failed (no fallback allowed)");
            return res.status(503).json({
                error:
                    "File storage (IPFS/Pinata) is unavailable. Verify PINATA_API_KEY, PINATA_API_SECRET, PINATA_GATEWAY environment variables and network connectivity, then retry.",
            });
        }

        // ── Stage 3: Generate ZKP (if available) ─────────────────────────────
        let proof = null;
        let publicSignals = null;
        let chainProof = null;
        if (zkpSvc) {
            const zkpResult = await zkpSvc.generateFileIntegrityProof(
                fileBuffer,
                fileHashHex
            );
            proof = zkpResult.proof;
            publicSignals = zkpResult.publicSignals;
            chainProof = zkpSvc.prepareProofForChain({ proof, publicSignals });
        }

        // ── Stage 4: Store materials server-side (key never leaves backend) ───
        const ivsHex = ivs.map((iv) => iv.toString("hex"));
        const authTagsHex = authTags.map((t) => t.toString("hex"));
        materialsSvc.storePendingMaterials(fileHashHex, {
            ownerAddress: userAddress,
            cids,
            aesKeyHex: aesKey.toString("hex"),
            ivs: ivsHex,
            authTags: authTagsHex,
        });

        // ── Stage 5: Log to GDPR database ────────────────────────────────────
        const displayName = fileName || req.file.originalname || "unknown";
        gdprSvc.logUpload(
            userAddress,
            Date.now(), // fileId placeholder (real fileId from chain TX)
            displayName,
            "user-uploaded"
        );

        // Return everything the frontend needs EXCEPT the AES key.
        // The client must present fileHashHex to /api/materials/register after
        // obtaining the on-chain fileId to link the pending record permanently.
        const response = {
            success: true,
            cids,
            fileHashHex,
            hashes,
            ivs: ivsHex,
            authTags: authTagsHex,
            message:
                "File encrypted with AES-256-GCM, uploaded to IPFS. Call FileRegistry.uploadFile() on-chain, then POST /api/materials/register with { fileId, fileHashHex }.",
        };
        
        // Only include proof/signals if zkpService is available
        if (chainProof) response.proof = chainProof;
        if (publicSignals) response.publicSignals = publicSignals;
        
        return res.json(response);
    } catch (err) {
        // Log error details for debugging but don't expose to client
        if (err instanceof SyntaxError) {
            console.error("[upload] Request validation error (malformed input)");
            return res.status(400).json({ error: "Invalid request format" });
        }
        if (err.message.includes("File too large")) {
            console.error("[upload] File size exceeded");
            return res.status(413).json({ error: "File exceeds maximum size (100 MB)" });
        }
        console.error("[upload] Processing error (stack logged server-side)");
        res.status(500).json({ error: "File upload processing failed. Please try again." });
    }
});

module.exports = router;
