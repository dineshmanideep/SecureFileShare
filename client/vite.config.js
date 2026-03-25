import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
    const repoRoot = path.resolve(__dirname, "..");
    const env = loadEnv(mode, repoRoot, "");
    const frontendPort = Number(env.VITE_FRONTEND_PORT || 5173);
    const backendUrl = env.VITE_BACKEND_URL || env.PUBLIC_BACKEND_URL || "http://localhost:3001";

    return {
        envDir: repoRoot,
        plugins: [react()],
        define: {
            // Mirror root-level env vars into Vite's public namespace.
            "import.meta.env.VITE_PINATA_API_KEY": JSON.stringify(
                env.VITE_PINATA_API_KEY || env.PINATA_API_KEY || ""
            ),
            "import.meta.env.VITE_PINATA_API_SECRET": JSON.stringify(
                env.VITE_PINATA_API_SECRET || env.PINATA_API_SECRET || ""
            ),
            "import.meta.env.VITE_PINATA_GATEWAY": JSON.stringify(
                env.VITE_PINATA_GATEWAY || env.PINATA_GATEWAY || "https://gateway.pinata.cloud"
            ),
            "import.meta.env.VITE_RPC_URL": JSON.stringify(
                env.VITE_RPC_URL || env.HARDHAT_RPC_URL || "http://127.0.0.1:8545"
            ),
            "import.meta.env.VITE_CHAIN_ID": JSON.stringify(
                env.VITE_CHAIN_ID || env.HARDHAT_CHAIN_ID || "1337"
            ),
            "import.meta.env.VITE_CHAIN_NAME": JSON.stringify(
                env.VITE_CHAIN_NAME || env.HARDHAT_NETWORK_NAME || "Hardhat Local"
            ),
            "import.meta.env.VITE_CHAIN_CURRENCY_SYMBOL": JSON.stringify(
                env.VITE_CHAIN_CURRENCY_SYMBOL || env.HARDHAT_CURRENCY_SYMBOL || "ETH"
            ),
        },
        server: {
            port: frontendPort,
            proxy: {
                "/api": {
                    target: backendUrl,
                    changeOrigin: true,
                },
            },
        },
        resolve: {
            alias: {
                process: "process/browser",
            },
        },
    };
});
