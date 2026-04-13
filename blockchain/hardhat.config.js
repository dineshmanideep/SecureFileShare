const path = require("path");
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const enableTenderlyPlugin = String(process.env.TENDERLY_ENABLE_PLUGIN || "false").toLowerCase() === "true";
if (enableTenderlyPlugin) {
    require("@tenderly/hardhat-tenderly");
}

const chainId = Number(process.env.HARDHAT_CHAIN_ID || 1337);
const localhostConfig = {
    url: process.env.HARDHAT_RPC_URL || "http://127.0.0.1:8545",
    chainId,
};
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
const normalizedDeployerKey = deployerPrivateKey
  ? deployerPrivateKey.startsWith("0x")
    ? deployerPrivateKey
    : `0x${deployerPrivateKey}`
  : null;

if (normalizedDeployerKey) {
  localhostConfig.accounts = [normalizedDeployerKey];
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: "0.8.23",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
        },
    },
    networks: {
        hardhat: {
            chainId,
        },
        localhost: localhostConfig,
        virtual_mainnet: {
            url:
                process.env.TENDERLY_VIRTUAL_MAINNET_RPC_URL ||
                "https://virtual.mainnet.eu.rpc.tenderly.co/c49e3924-d5b7-438e-b750-bda4eed6d0e2",
            chainId: Number(process.env.TENDERLY_VIRTUAL_MAINNET_CHAIN_ID || 1337),
            accounts: normalizedDeployerKey ? [normalizedDeployerKey] : undefined,
        },
    },
    ...(enableTenderlyPlugin
        ? {
              tenderly: {
                  project: process.env.TENDERLY_PROJECT || "project",
                  username: process.env.TENDERLY_USERNAME || "dinesh_2005",
                  automaticVerifications: false,
              },
          }
        : {}),
};
