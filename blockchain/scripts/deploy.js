const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const rpcUrl = process.env.HARDHAT_RPC_URL || "http://127.0.0.1:8545";
const chainId = Number(process.env.HARDHAT_CHAIN_ID || network.config.chainId || 1337);
const frontendUrl = process.env.VITE_FRONTEND_URL || `http://localhost:${process.env.VITE_FRONTEND_PORT || 5173}`;
const configuredRbacAdminWallet = process.env.RBAC_ADMIN_WALLET || process.env.VITE_RBAC_ADMIN_WALLET || "";
const configuredRelayerPrivateKey = process.env.ZK_RELAYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY || "";

function normalizeAddress(address) {
    if (!address) return "";
    try {
        return ethers.getAddress(address.trim());
    } catch {
        return "";
    }
}

function privateKeyToAddress(pk) {
    const value = String(pk || "").trim();
    if (!value) return "";
    try {
        const normalizedPk = value.startsWith("0x") ? value : `0x${value}`;
        return new ethers.Wallet(normalizedPk).address;
    } catch {
        return "";
    }
}

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);
    console.log(
        "Account balance:",
        ethers.formatEther(await deployer.provider.getBalance(deployer.address)),
        "ETH"
    );

    // ── 0. Semaphore (ZK access control) ─────────────────────────────────
    console.log("\n📦 Deploying PoseidonT3 library...");
    const PoseidonT3 = await ethers.getContractFactory("poseidon-solidity/PoseidonT3.sol:PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();
    await poseidonT3.waitForDeployment();
    const poseidonT3Addr = await poseidonT3.getAddress();
    console.log("✅ PoseidonT3 deployed to:", poseidonT3Addr);

    console.log("\n📦 Deploying SemaphoreVerifier...");
    const SemaphoreVerifier = await ethers.getContractFactory("SemaphoreVerifier");
    const semaphoreVerifier = await SemaphoreVerifier.deploy();
    await semaphoreVerifier.waitForDeployment();
    const semaphoreVerifierAddr = await semaphoreVerifier.getAddress();
    console.log("✅ SemaphoreVerifier deployed to:", semaphoreVerifierAddr);

    console.log("\n📦 Deploying Semaphore...");
    const Semaphore = await ethers.getContractFactory("Semaphore", {
        libraries: {
            PoseidonT3: poseidonT3Addr,
        },
    });
    const semaphore = await Semaphore.deploy(semaphoreVerifierAddr);
    await semaphore.waitForDeployment();
    const semaphoreAddr = await semaphore.getAddress();
    console.log("✅ Semaphore deployed to:", semaphoreAddr);

    // ── 1. FileRegistry ──────────────────────────────────────────────────
    console.log("\n📦 Deploying FileRegistry...");
    const FileRegistry = await ethers.getContractFactory("FileRegistry");
    const fileRegistry = await FileRegistry.deploy();
    await fileRegistry.waitForDeployment();
    const fileRegistryAddr = await fileRegistry.getAddress();
    console.log("✅ FileRegistry deployed to:", fileRegistryAddr);

    // ── 2. FileAccessControl ─────────────────────────────────────────────
    console.log("\n📦 Deploying FileAccessControl...");
    const FileAccessControl = await ethers.getContractFactory("FileAccessControl");
    const accessControl = await FileAccessControl.deploy(semaphoreAddr);
    await accessControl.waitForDeployment();
    const accessControlAddr = await accessControl.getAddress();
    console.log("✅ FileAccessControl deployed to:", accessControlAddr);

    const relayerAddress = privateKeyToAddress(configuredRelayerPrivateKey);
    if (configuredRelayerPrivateKey && !relayerAddress) {
        console.log("⚠️ ZK_RELAYER_PRIVATE_KEY/RELAYER_PRIVATE_KEY is invalid; skipping setZkRelayer.");
    } else if (relayerAddress) {
        console.log(`🔁 Configuring ZK relayer wallet: ${relayerAddress}`);
        const txRelayer = await accessControl.setZkRelayer(relayerAddress);
        await txRelayer.wait();
        console.log("✅ ZK relayer configured in AccessControl");
    } else {
        console.log("ℹ️ No relayer private key configured. ZK relayed member-add will remain disabled until setZkRelayer is called.");
    }

    // Optionally auto-whitelist an RBAC admin wallet as a trusted issuer.
    // In strict mode, only trusted issuers can set role attributes.
    const normalizedAdmin = normalizeAddress(configuredRbacAdminWallet);
    if (configuredRbacAdminWallet && !normalizedAdmin) {
        console.log("⚠️ RBAC_ADMIN_WALLET is set but invalid; skipping trusted issuer setup.");
    } else if (normalizedAdmin && normalizedAdmin.toLowerCase() !== deployer.address.toLowerCase()) {
        console.log(`\n🔐 Whitelisting RBAC admin wallet as trusted issuer: ${normalizedAdmin}`);
        const txIssuer = await accessControl.setTrustedIssuer(normalizedAdmin, true);
        await txIssuer.wait();
        console.log("✅ Trusted issuer granted to RBAC admin wallet");
    } else {
        console.log("ℹ️ No additional RBAC admin wallet configured. Deployer remains trusted issuer by default.");
    }

    // ── 3. TimeBoundPermissions ──────────────────────────────────────────
    console.log("\n📦 Deploying TimeBoundPermissions...");
    const TimeBoundPermissions = await ethers.getContractFactory("TimeBoundPermissions");
    const timeBound = await TimeBoundPermissions.deploy();
    await timeBound.waitForDeployment();
    const timeBoundAddr = await timeBound.getAddress();
    console.log("✅ TimeBoundPermissions deployed to:", timeBoundAddr);

    // ── 4. GDPRCompliance ────────────────────────────────────────────────
    console.log("\n📦 Deploying GDPRCompliance...");
    const GDPRCompliance = await ethers.getContractFactory("GDPRCompliance");
    const gdpr = await GDPRCompliance.deploy();
    await gdpr.waitForDeployment();
    const gdprAddr = await gdpr.getAddress();
    console.log("✅ GDPRCompliance deployed to:", gdprAddr);

    // ── Save addresses ───────────────────────────────────────────────────
    const addresses = {
        network: network.name || process.env.HARDHAT_NETWORK_NAME || "localhost",
        chainId,
        deployedAt: new Date().toISOString(),
        rbacAdminWallet: normalizeAddress(configuredRbacAdminWallet) || null,
        contracts: {
            SemaphoreVerifier: semaphoreVerifierAddr,
            Semaphore: semaphoreAddr,
            FileRegistry: fileRegistryAddr,
            FileAccessControl: accessControlAddr,
            TimeBoundPermissions: timeBoundAddr,
            GDPRCompliance: gdprAddr,
        },
    };

    const outPath = path.join(__dirname, "..", "deployed_addresses.json");
    fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
    console.log("\n📝 Contract addresses saved to deployed_addresses.json");

    // Also write addresses for client consumption
    const frontendOut = path.join(
        __dirname,
        "..",
        "..",
        "client",
        "src",
        "contracts",
        "addresses.json"
    );
    fs.mkdirSync(path.dirname(frontendOut), { recursive: true });
    fs.writeFileSync(frontendOut, JSON.stringify(addresses, null, 2));
    console.log("📝 Addresses also saved to client/src/contracts/addresses.json");

    // Also write addresses for backend consumption
    const backendOut = path.join(
        __dirname,
        "..",
        "..",
        "backend",
        "contracts",
        "addresses.json"
    );
    fs.mkdirSync(path.dirname(backendOut), { recursive: true });
    fs.writeFileSync(backendOut, JSON.stringify(addresses, null, 2));
    console.log("📝 Addresses also saved to backend/contracts/addresses.json");

    console.log("\n🎉 All contracts deployed successfully!");
    console.log("─".repeat(60));
    console.log("Next steps:");
    console.log("  1. cd backend && npm run dev");
    console.log("  2. cd client && npm run dev");
    console.log(`  3. Open ${frontendUrl} in your browser`);
    console.log(`  4. Connect MetaMask to ${rpcUrl} (Chain ID: ${chainId})`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Deployment failed:", error);
        process.exit(1);
    });
