/**
 * envConfig.js
 * 
 * Centralized environment configuration loader
 * Loads from project root .env file
 * Used by all backend services
 */

const path = require('path');
const dotenv = require('dotenv');

// Load .env from project root (one level above /backend)
// NOTE: previous '../../.env' points to the parent of the repo, so keys won't load.
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsv(value, fallback = []) {
    if (!value) {
        return fallback;
    }

    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

const serverPort = parseNumber(process.env.PORT, 3001);
const serverHost = process.env.HOST || 'localhost';

module.exports = {
    // Pinata Configuration
    pinata: {
        apiKey: process.env.PINATA_API_KEY,
        apiSecret: process.env.PINATA_API_SECRET,
        apiBaseUrl: process.env.PINATA_API_URL || 'https://api.pinata.cloud',
        gateway: process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud',
    },

    // Server Configuration
    server: {
        port: serverPort,
        host: serverHost,
        nodeEnv: process.env.NODE_ENV || 'development',
        allowedOrigins: parseCsv(process.env.CORS_ORIGINS, [
            'http://localhost:3000',
            'http://localhost:5173',
            'http://localhost:5174',
        ]),
        publicUrl: process.env.PUBLIC_BACKEND_URL || `http://${serverHost}:${serverPort}`,
    },

    // Blockchain / wallet network configuration
    blockchain: {
        rpcUrl: process.env.HARDHAT_RPC_URL || 'http://127.0.0.1:8545',
        chainId: parseNumber(process.env.HARDHAT_CHAIN_ID, 1337),
        networkName: process.env.HARDHAT_NETWORK_NAME || 'Hardhat Local',
        currencySymbol: process.env.HARDHAT_CURRENCY_SYMBOL || 'ETH',
    },
};
