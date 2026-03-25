"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let runtimeCpabeDisabled = false;
let runtimeDisableReason = "";

function isTruthyEnv(name) {
    const value = String(process.env[name] || "").toLowerCase();
    return value === "1" || value === "true" || value === "yes";
}

function isWindowsAbsolutePath(value) {
    return /^[a-zA-Z]:\\/.test(String(value || ""));
}

function toWslPath(value) {
    const input = String(value || "");
    if (!isWindowsAbsolutePath(input)) return input;

    const drive = input[0].toLowerCase();
    const rest = input.slice(2).replace(/\\/g, "/");
    return `/mnt/${drive}${rest}`;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shouldUseWsl(bin) {
    if (process.platform !== "win32") return false;
    if (isTruthyEnv("CPABE_USE_WSL")) return true;
    return /^\//.test(String(bin || ""));
}

function joinBinPath(binDir, executable) {
    if (!binDir) return executable;
    return /^\//.test(String(binDir)) ? path.posix.join(binDir, executable) : path.join(binDir, executable);
}

function attrFromAddress(address) {
    const normalized = String(address || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
        throw new Error("Invalid Ethereum address for CP-ABE attribute");
    }
    return `addr_${normalized.slice(2)}`;
}

function isEnabled() {
    const v = String(process.env.CPABE_ENABLED || "false").toLowerCase();
    const enabledByEnv = v !== "false" && v !== "0";
    return enabledByEnv && !runtimeCpabeDisabled;
}

function isMissingBinaryError(err) {
    const msg = String(err?.message || "").toLowerCase();
    return msg.includes("enoent") || msg.includes("failed to start") || msg.includes("install cpabe binaries");
}

function disableCpabeRuntime(err) {
    runtimeCpabeDisabled = true;
    runtimeDisableReason = String(err?.message || "CP-ABE runtime disabled");
    console.warn(`[cpabe] Runtime disabled: ${runtimeDisableReason}`);
}

function cpabePaths() {
    const keyDir = process.env.CPABE_KEY_DIR || path.join(__dirname, "..", "cpabe");
    const pub = process.env.CPABE_PUBLIC_KEY || path.join(keyDir, "pub_key");
    const msk = process.env.CPABE_MASTER_KEY || path.join(keyDir, "master_key");

    const binDir = process.env.CPABE_BIN_DIR;
    const setupBin = process.env.CPABE_SETUP_BIN || joinBinPath(binDir, "cpabe-setup");
    const encBin = process.env.CPABE_ENC_BIN || joinBinPath(binDir, "cpabe-enc");
    const decBin = process.env.CPABE_DEC_BIN || joinBinPath(binDir, "cpabe-dec");
    const keygenBin = process.env.CPABE_KEYGEN_BIN || joinBinPath(binDir, "cpabe-keygen");

    return { keyDir, pub, msk, setupBin, encBin, decBin, keygenBin };
}

function runCmd(bin, args, cwd) {
    if (shouldUseWsl(bin)) {
        const distro = String(process.env.CPABE_WSL_DISTRO || "").trim();
        const convertedBin = toWslPath(bin);
        const convertedArgs = (args || []).map((arg) => toWslPath(arg));
        const convertedCwd = cwd ? toWslPath(cwd) : "";
        const command = [convertedBin, ...convertedArgs].map(shellQuote).join(" ");
        const script = convertedCwd ? `cd ${shellQuote(convertedCwd)} && ${command}` : command;
        const wslArgs = [];

        if (distro) {
            wslArgs.push("-d", distro);
        }
        wslArgs.push("bash", "-lc", script);

        const res = spawnSync("wsl.exe", wslArgs, {
            encoding: "utf8",
            windowsHide: true,
        });

        if (res.error) {
            throw new Error(
                `Failed to start CP-ABE through WSL: ${res.error.message}. Check CPABE_WSL_DISTRO and WSL installation.`
            );
        }
        if (res.status !== 0) {
            throw new Error(
                `${path.basename(bin)} failed via WSL: ${String(res.stderr || res.stdout || "unknown error").trim()}`
            );
        }
        return;
    }

    const res = spawnSync(bin, args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
    });

    if (res.error) {
        throw new Error(
            `Failed to start ${bin}: ${res.error.message}. Install cpabe binaries or set CPABE_*_BIN paths.`
        );
    }
    if (res.status !== 0) {
        throw new Error(
            `${path.basename(bin)} failed: ${String(res.stderr || res.stdout || "unknown error").trim()}`
        );
    }
}

function ensureSetup() {
    const p = cpabePaths();
    fs.mkdirSync(p.keyDir, { recursive: true });
    if (fs.existsSync(p.pub) && fs.existsSync(p.msk)) return p;
    runCmd(p.setupBin, [], p.keyDir);
    if (!fs.existsSync(p.pub) || !fs.existsSync(p.msk)) {
        throw new Error("cpabe-setup completed but keys were not found. Check CPABE_KEY_DIR.");
    }
    return p;
}

function groupMemberPolicy(addresses) {
    const unique = [...new Set((addresses || []).map((a) => attrFromAddress(a)))];
    if (unique.length === 0) throw new Error("Cannot create CP-ABE policy with no members");
    if (unique.length === 1) return unique[0];
    return `(${unique.join(" or ")})`;
}

function encryptAesKeyHexForPolicy(aesKeyHex, policyExpr) {
    if (!isEnabled()) return null;
    if (!/^[0-9a-f]{64}$/i.test(String(aesKeyHex || ""))) {
        throw new Error("AES key must be 64 hex characters for CP-ABE encryption");
    }
    let p;
    try {
        p = ensureSetup();
    } catch (err) {
        if (isMissingBinaryError(err)) {
            disableCpabeRuntime(err);
            return null;
        }
        throw err;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpabe-enc-"));
    const plainPath = path.join(tmpDir, `${crypto.randomUUID()}.txt`);

    try {
        fs.writeFileSync(plainPath, String(aesKeyHex).toLowerCase(), "utf8");
        runCmd(p.encBin, [p.pub, plainPath, policyExpr], tmpDir);

        const encPath = `${plainPath}.cpabe`;
        if (!fs.existsSync(encPath)) {
            throw new Error("cpabe-enc did not produce ciphertext file");
        }
        return fs.readFileSync(encPath).toString("base64");
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // best effort cleanup
        }
    }
}

function decryptAesKeyHexWithAttributes(cipherB64, attributes) {
    if (!isEnabled()) return null;
    const attrs = [...new Set((attributes || []).map((v) => String(v || "").trim()).filter(Boolean))];
    if (attrs.length === 0) {
        throw new Error("At least one CP-ABE attribute is required for decryption");
    }

    let p;
    try {
        p = ensureSetup();
    } catch (err) {
        if (isMissingBinaryError(err)) {
            disableCpabeRuntime(err);
            return null;
        }
        throw err;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpabe-dec-"));
    const encPath = path.join(tmpDir, `${crypto.randomUUID()}.cpabe`);
    const outPath = encPath.replace(/\.cpabe$/i, "");
    const userKeyPath = path.join(tmpDir, "user_priv_key");

    try {
        fs.writeFileSync(encPath, Buffer.from(String(cipherB64), "base64"));
        runCmd(p.keygenBin, [p.pub, p.msk, userKeyPath, ...attrs], tmpDir);
        runCmd(p.decBin, [p.pub, userKeyPath, encPath], tmpDir);

        if (!fs.existsSync(outPath)) {
            throw new Error("cpabe-dec did not produce decrypted output");
        }
        const aesKeyHex = fs.readFileSync(outPath, "utf8").trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(aesKeyHex)) {
            throw new Error("CP-ABE decrypted payload was not a valid AES-256 key");
        }
        return aesKeyHex;
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // best effort cleanup
        }
    }
}

module.exports = {
    isEnabled,
    attrFromAddress,
    groupMemberPolicy,
    encryptAesKeyHexForPolicy,
    decryptAesKeyHexWithAttributes,
    getRuntimeDisableReason: () => runtimeDisableReason,
};
