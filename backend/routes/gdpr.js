"use strict";
const express = require("express");
const router = express.Router();

const { authMiddleware } = require("../middleware/auth");
const gdprSvc = require("../services/gdprService");
const ipfsSvc = require("../services/ipfsService");
const materialsSvc = require("../services/materialsService");

/**
 * POST /api/gdpr/erase
 * GDPR right to erasure: unpin IPFS, mark deleted on SQLite.
 * Only the file owner (req.verifiedAddress) can erase their own data.
 */
router.post("/erase", authMiddleware, async (req, res) => {
    try {
        const { fileId, cids } = req.body;
        if (fileId === undefined || fileId === null) {
            return res.status(400).json({ error: "fileId required" });
        }

        // Enforce ownership: the caller must be the registered owner of this file.
        const stored = materialsSvc.getFileMaterials(fileId);
        if (stored && stored.ownerAddress !== req.verifiedAddress) {
            return res.status(403).json({ error: "Access denied: you do not own this file" });
        }

        const erasureResult = gdprSvc.fulfillErasure(String(fileId));

        // Unpin from IPFS
        const unpinResults = [];
        const cidsToUnpin = cids && Array.isArray(cids) ? cids : (stored ? stored.cids : []);
        for (const cid of cidsToUnpin) {
            try {
                await ipfsSvc.unpinFile(cid);
                unpinResults.push({ cid, status: "unpinned" });
            } catch (e) {
                unpinResults.push({ cid, status: "error" });
            }
        }

        gdprSvc.logAccess(req.verifiedAddress, String(fileId), "GDPR_ERASE");

        return res.json({
            success: true,
            erasureTimestamp: erasureResult.timestamp,
            ipfsResults: unpinResults,
            message: "File erased from IPFS and GDPR records. Call GDPRCompliance.fulfillErasure() on-chain.",
        });
    } catch (err) {
        // Log error details server-side only
        if (err.message.includes("fileId")) {
            console.error("[gdpr/erase] Validation error");
            return res.status(400).json({ error: "Invalid file ID format" });
        }
        console.error("[gdpr/erase] Processing error (stack logged server-side)");
        res.status(500).json({ error: "File erasure failed. Please try again." });
    }
});

/**
 * GET /api/gdpr/export
 * Article 20 data portability export. Users may only export their own data.
 */
router.get("/export", authMiddleware, (req, res) => {
    try {
        const data = gdprSvc.exportUserData(req.verifiedAddress);
        res.json({ success: true, data });
    } catch (err) {
        // Log error details server-side only
        console.error("[gdpr/export] Processing error (stack logged server-side)");
        res.status(500).json({ error: "Data export failed. Please try again." });
    }
});

/**
 * POST /api/gdpr/consent
 * Record or revoke consent. Users may only manage their own consent records.
 */
router.post("/consent", authMiddleware, (req, res) => {
    try {
        const { consentType, action } = req.body;
        if (!consentType)
            return res.status(400).json({ error: "consentType required" });

        if (action === "revoke") {
            gdprSvc.revokeConsent(req.verifiedAddress, consentType);
            return res.json({ success: true, action: "revoked" });
        } else {
            gdprSvc.logConsent(req.verifiedAddress, consentType);
            return res.json({ success: true, action: "granted", timestamp: Date.now() });
        }
    } catch (err) {
        // Log error details server-side only
        console.error("[gdpr/consent] Processing error (stack logged server-side)");
        res.status(500).json({ error: "Consent update failed. Please try again." });
    }
});

/**
 * GET /api/gdpr/audit
 * Get audit trail for the authenticated user only.
 */
router.get("/audit", authMiddleware, (req, res) => {
    try {
        const logs = gdprSvc.getAuditTrail(req.verifiedAddress);
        res.json({ success: true, logs });
    } catch (err) {
        // Log error details server-side only
        console.error("[gdpr/audit] Processing error (stack logged server-side)");
        res.status(500).json({ error: "Audit retrieval failed. Please try again." });
    }
});

/**
 * POST /api/gdpr/anonymize
 * Anonymise all PII for the authenticated user (GDPR right to be forgotten at account level).
 */
router.post("/anonymize", authMiddleware, (req, res) => {
    try {
        const result = gdprSvc.anonymizeUser(req.verifiedAddress);
        res.json({ success: true, ...result });
    } catch (err) {
        // Log error details server-side only
        console.error("[gdpr/anonymize] Processing error (stack logged server-side)");
        res.status(500).json({ error: "Anonymization failed. Please try again." });
    }
});

module.exports = router;
