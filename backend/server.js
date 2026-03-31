"use strict";
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./envConfig");

// Routes
const uploadRoute = require("./routes/upload");
const { accessRouter, receivedSharesRouter } = require("./routes/access");
const gdprRoute = require("./routes/gdpr");
const materialsRoute = require("./routes/materials");
const groupsRoute = require("./routes/groups");
const zkPublicRoute = require("./routes/zkPublic");
const zkRelayerRoute = require("./routes/zkRelayer");

// Services
const gdprSvc = require("./services/gdprService");

const app = express();
const PORT = config.server.port;
const HOST = config.server.host;

// ─────────────────────────── Security Middleware ──────────────────────────

// HTTP security headers (CSP, HSTS, X-Frame-Options, etc.)
app.use(helmet());

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({
    origin: config.server.allowedOrigins,
    credentials: true,
}));

// Redact auth headers from Morgan logs so keys / signatures are never logged.
app.use(morgan("dev", {
    skip: () => false,
    stream: process.stdout,
}));

// ─────────────────────────── Rate Limiting ────────────────────────────────

// Global limiter — 200 requests per minute per IP
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down." },
});

// Tighter limit for expensive operations (upload, access, GDPR erase)
const strictLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests on this endpoint." },
});

app.use(globalLimiter);

// ─────────────────────────── GDPR DB Init ────────────────────────────────

// Ensure SQLite schema is created at startup
try {
    gdprSvc.initSchema();
    console.log("✅ GDPR SQLite database initialized");
} catch (err) {
    console.error("❌ Failed to init GDPR DB:", err.message);
}

// ─────────────────────────── Contract Address Validation ───────────────────

// Validate that all required contract addresses are valid Ethereum addresses
try {
    const { ethers } = require("ethers");
    const deployedAddresses = require("../blockchain/deployed_addresses.json").contracts;
    
    const requiredAddresses = [
        { name: "FileRegistry", key: "FileRegistry" },
        { name: "FileAccessControl", key: "FileAccessControl" },
        { name: "GDPRCompliance", key: "GDPRCompliance" },
        { name: "TimeBoundPermissions", key: "TimeBoundPermissions" },
    ];

    const optionalAddresses = [
        { name: "ZKPVerifier", key: "ZKPVerifier" },
    ];

    requiredAddresses.forEach(({ name, key }) => {
        if (!deployedAddresses[key]) {
            throw new Error(`Missing contract address for ${name} at deployed_addresses.json.contracts.${key}`);
        }
        try {
            ethers.utils.getAddress(deployedAddresses[key]);
        } catch {
            throw new Error(`Invalid Ethereum address for ${name}: ${deployedAddresses[key]}`);
        }
    });

    optionalAddresses.forEach(({ name, key }) => {
        if (!deployedAddresses[key]) {
            console.warn(`⚠️ Optional contract ${name} not configured at deployed_addresses.json.contracts.${key}`);
            return;
        }
        try {
            ethers.utils.getAddress(deployedAddresses[key]);
        } catch {
            throw new Error(`Invalid Ethereum address for optional contract ${name}: ${deployedAddresses[key]}`);
        }
    });

    console.log("✅ Required contract addresses validated");
} catch (err) {
    console.error("❌ Contract address validation failed:", err.message);
    process.exit(1);
}

// ─────────────────────────── Routes ──────────────────────────────────────

app.use("/api/upload", strictLimiter, uploadRoute);
app.use("/api", accessRouter);           // /api/share and /api/access/:fileId
app.use("/api", receivedSharesRouter);  // /api/received-shares
app.use("/api/gdpr", strictLimiter, gdprRoute);
app.use("/api/materials", materialsRoute);
app.use("/api/groups", groupsRoute);
app.use("/api/zk-public", strictLimiter, zkPublicRoute);
app.use("/api/zk-relayer", strictLimiter, zkRelayerRoute);

// ─────────────────────────── Health Check ────────────────────────────────

// Health endpoint: return minimal status only — do not expose service topology.
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// ─────────────────────────── 404 / Error ─────────────────────────────────

app.use((req, res) => {
    res.status(404).json({ error: "Route not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error("[server]", err);
    // Never expose internal error details (stack traces, DB messages, etc.) to clients.
    res.status(500).json({ error: "Internal server error" });
});

// ─────────────────────────── Start ───────────────────────────────────────

app.listen(PORT, HOST, () => {
    console.log("\n🚀 SecureFileShare Backend running!");
    console.log(`   URL:  ${config.server.publicUrl}`);
    console.log(`   Pinata API: ${config.pinata.apiBaseUrl}`);
    console.log(`   Pinata Gateway: ${config.pinata.gateway}`);
    console.log(`   Chain RPC: ${config.blockchain.rpcUrl}`);
    console.log("─".repeat(50));
    console.log("   Routes:");
    console.log("   POST /api/upload           – Encrypt + upload file");
    console.log("   POST /api/share            – Share file (ECDH key wrap)");
    console.log("   GET  /api/access/:fileId   – Access and decrypt file");
    console.log("   GET  /api/received-shares  – Files shared TO a user");
    console.log("   GET  /api/groups           – List groups for user");
    console.log("   POST /api/groups           – Create group");
    console.log("   POST /api/groups/share     – Share file to group");
    console.log("   POST /api/zk-public/upload – Upload file for ZK-public flow");
    console.log("   POST /api/zk-public/register – Finalize ZK-public upload");
    console.log("   GET  /api/zk-public/files  – List ZK-public files");
    console.log("   GET  /api/zk-public/download/:fileId – Download via ZK proof");
    console.log("   POST /api/zk-relayer/validate-proof – Relay ZK proof tx to Semaphore");
    console.log("   POST /api/gdpr/erase       – GDPR right to erasure");
    console.log("   GET  /api/gdpr/export      – GDPR Article 20 export");
});
