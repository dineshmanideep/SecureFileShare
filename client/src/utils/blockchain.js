import { ethers } from "ethers";
import FileRegistryABI from "../../../blockchain/artifacts/contracts/FileRegistry.sol/FileRegistry.json";
import AccessControlABI from "../../../blockchain/artifacts/contracts/AccessControl.sol/FileAccessControl.json";
import TimeBoundPermissionsABI from "../../../blockchain/artifacts/contracts/TimeBoundPermissions.sol/TimeBoundPermissions.json";
import GDPRComplianceABI from "../../../blockchain/artifacts/contracts/GDPRCompliance.sol/GDPRCompliance.json";
import SemaphoreABI from "../../../blockchain/artifacts/@semaphore-protocol/contracts/Semaphore.sol/Semaphore.json";
// Fallback if addresses file wasn't generated correctly by deploy.js yet
import Addresses from "../contracts/addresses.json";

const CONTRACTS = Addresses.contracts || Addresses;
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 1337);
const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`;
const RPC_URL = import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8545";
const CHAIN_NAME = import.meta.env.VITE_CHAIN_NAME || "Hardhat Local";
const CHAIN_CURRENCY_SYMBOL = import.meta.env.VITE_CHAIN_CURRENCY_SYMBOL || "ETH";

export const NETWORK_CONFIG = {
    chainId: CHAIN_ID,
    chainIdHex: CHAIN_ID_HEX,
    chainName: CHAIN_NAME,
    rpcUrl: RPC_URL,
    currencySymbol: CHAIN_CURRENCY_SYMBOL,
};

export async function getProvider() {
    if (!window.ethereum) throw new Error("MetaMask not found");
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    await provider.send("eth_requestAccounts", []);

    // Attempt to auto-switch to the configured EVM network.
    try {
        await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: NETWORK_CONFIG.chainIdHex }],
        });
    } catch (switchError) {
        // Error 4902 implies the chain is not yet added to MetaMask
        if (switchError.code === 4902) {
            try {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: NETWORK_CONFIG.chainIdHex,
                        chainName: NETWORK_CONFIG.chainName,
                        rpcUrls: [NETWORK_CONFIG.rpcUrl],
                        nativeCurrency: {
                            name: 'Ethereum',
                            symbol: NETWORK_CONFIG.currencySymbol,
                            decimals: 18
                        }
                    }],
                });
            } catch (addError) {
                throw new Error(
                    `Failed to add local chain ${NETWORK_CONFIG.chainId} in MetaMask. ` +
                    `Ensure local node is running at ${NETWORK_CONFIG.rpcUrl}.`
                );
            }
        } else {
            throw new Error(
                `Failed to switch MetaMask to chain ${NETWORK_CONFIG.chainId}. ` +
                `Please switch manually and ensure RPC ${NETWORK_CONFIG.rpcUrl} is reachable.`
            );
        }
    }

    const chainIdHex = await provider.send("eth_chainId", []);
    const activeChainId = Number.parseInt(chainIdHex, 16);
    if (activeChainId !== NETWORK_CONFIG.chainId) {
        throw new Error(
            `Wrong network selected (current: ${activeChainId}, expected: ${NETWORK_CONFIG.chainId}). ` +
            `Switch MetaMask to ${NETWORK_CONFIG.chainName}.`
        );
    }

    try {
        await provider.getBlockNumber();
    } catch {
        throw new Error(
            `Cannot reach local blockchain node at ${NETWORK_CONFIG.rpcUrl}. ` +
            `Start Hardhat node and redeploy contracts.`
        );
    }

    return provider;
}

export async function getSigner() {
    const provider = await getProvider();
    return provider.getSigner();
}

function getContract(address, abi, signerOrProvider) {
    if (!address || !ethers.utils.isAddress(address)) {
        throw new Error("Contract address is missing or invalid. Re-run deploy to refresh addresses.json.");
    }
    return new ethers.Contract(address, abi.abi || abi, signerOrProvider);
}

export async function getFileRegistry(signer) {
    return getContract(CONTRACTS.FileRegistry, FileRegistryABI, signer);
}

export async function getAccessControl(signer) {
    return getContract(CONTRACTS.FileAccessControl, AccessControlABI, signer);
}

export async function getTimeBoundPermissions(signer) {
    return getContract(CONTRACTS.TimeBoundPermissions, TimeBoundPermissionsABI, signer);
}

export async function getGDPRCompliance(signer) {
    return getContract(CONTRACTS.GDPRCompliance, GDPRComplianceABI, signer);
}

export async function getSemaphore(signer) {
    if (!CONTRACTS.Semaphore) {
        throw new Error(
            "Semaphore contract address missing in addresses.json. " +
            "Re-run blockchain deploy to generate updated addresses including Semaphore."
        );
    }
    return getContract(CONTRACTS.Semaphore, SemaphoreABI, signer);
}

/**
 * Verify that all core contracts are deployed on the current network.
 * Throws detailed error indicating which contracts are missing or misconfigured.
 */
export async function verifyContractsDeployed(signer) {
    const requiredContracts = {
        FileRegistry: CONTRACTS.FileRegistry,
        FileAccessControl: CONTRACTS.FileAccessControl,
        TimeBoundPermissions: CONTRACTS.TimeBoundPermissions,
        GDPRCompliance: CONTRACTS.GDPRCompliance,
    };
    
    const missingAddresses = [];
    const notDeployed = [];
    
    for (const [name, address] of Object.entries(requiredContracts)) {
        if (!address) {
            missingAddresses.push(name);
            continue;
        }
        
        if (!ethers.utils.isAddress(address)) {
            throw new Error(
                `Invalid address for ${name}: "${address}"\n` +
                `Re-run deploy script and hard-refresh browser (Ctrl+F5).`
            );
        }
        
        try {
            const code = await signer.provider.getCode(address);
            if (!code || code === "0x") {
                notDeployed.push({ name, address });
            }
        } catch (err) {
            throw new Error(
                `Cannot verify contract deployment for ${name}. ` +
                `Network error: ${err.message}`
            );
        }
    }
    
    if (missingAddresses.length > 0) {
        throw new Error(
            `Missing contract addresses in addresses.json: ${missingAddresses.join(", ")}\n` +
            `Re-run deploy script from blockchain/ folder:\n` +
            `  cd midsem\\ submission/blockchain && npx hardhat run scripts/deploy.js --network localhost\n` +
            `Then hard-refresh browser (Ctrl+F5).`
        );
    }
    
    if (notDeployed.length > 0) {
        const details = notDeployed.map(c => `  - ${c.name}: ${c.address}`).join("\n");
        throw new Error(
            `Contracts not deployed on current chain (${NETWORK_CONFIG.chainId}):\n${details}\n` +
            `Re-deploy contracts:\n` +
            `  1. Restart Hardhat node: npx hardhat node\n` +
            `  2. Deploy: cd midsem\\ submission/blockchain && npx hardhat run scripts/deploy.js --network localhost\n` +
            `  3. Hard-refresh browser (Ctrl+F5).`
        );
    }
}

export async function safeGetOwnerFileIds(registry, ownerAddress) {
    if (!registry || !ownerAddress) return [];

    try {
        const ids = await registry.getOwnerFiles(ownerAddress);
        return Array.isArray(ids) ? ids : [];
    } catch (err) {
        const msg = String(err?.message || "");
        const isCallException = err?.code === "CALL_EXCEPTION" || msg.includes("CALL_EXCEPTION") || msg.includes("revert");
        if (!isCallException) throw err;

        // Fallback for ABI/address mismatches: infer ids from FileUploaded events.
        try {
            const normalizedOwner = ethers.utils.getAddress(ownerAddress);
            const filter = registry.filters.FileUploaded(null, normalizedOwner);
            const events = await registry.queryFilter(filter, 0, "latest");

            const seen = new Set();
            const ids = [];
            for (const ev of events) {
                const fileId = ev?.args?.fileId;
                if (!fileId) continue;
                const key = fileId.toString();
                if (seen.has(key)) continue;
                seen.add(key);
                ids.push(fileId);
            }
            return ids;
        } catch {
            return [];
        }
    }
}

export async function signAuthMessage(signer) {
    const address = await signer.getAddress();
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = ethers.utils.hexlify(ethers.utils.randomBytes(8));
    const message = `SecureFileShare:${timestamp}:${address}:${nonce}`;
    const signature = await signer.signMessage(message);
    return { address, signature, message };
}
