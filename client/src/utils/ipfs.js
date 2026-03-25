/**
 * IPFS utility functions using Pinata
 *
 * Reads from centralized .env file at project root:
 * - PINATA_API_KEY
 * - PINATA_API_SECRET
 * - PINATA_GATEWAY (optional, defaults to https://gateway.pinata.cloud)
 *
 * Note: Vite automatically exposes env vars prefixed with VITE_
 * For raw PINATA_* vars, use import.meta.env.VITE_PINATA_*
 * and set them in .env with VITE_ prefix during build
 */

const PINATA_API_URL = "https://api.pinata.cloud";
const PINATA_GATEWAY = import.meta.env.VITE_PINATA_GATEWAY || "https://gateway.pinata.cloud";
const PINATA_API_KEY = import.meta.env.VITE_PINATA_API_KEY;
const PINATA_API_SECRET = import.meta.env.VITE_PINATA_API_SECRET;

if (!PINATA_API_KEY || !PINATA_API_SECRET) {
    console.warn(
        "⚠️ Pinata credentials not configured. Ensure your root .env file has VITE_PINATA_API_KEY and VITE_PINATA_API_SECRET"
    );
}

/**
 * Upload a buffer to Pinata IPFS
 * @param {Buffer | Uint8Array} buffer - The data to upload
 * @returns {Promise<string>} - CID of the uploaded content
 */
export async function uploadBufferToIPFS(buffer) {
    try {
        const formData = new FormData();
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        formData.append("file", blob);
        formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

        const response = await fetch(`${PINATA_API_URL}/pinning/pinFileToIPFS`, {
            method: "POST",
            headers: {
                pinata_api_key: PINATA_API_KEY,
                pinata_secret_api_key: PINATA_API_SECRET,
            },
            body: formData,
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Pinata upload failed: ${error.error || response.statusText}`);
        }

        const data = await response.json();
        return data.IpfsHash;
    } catch (error) {
        console.error("Pinata Upload Error:", error);
        throw error;
    }
}

/**
 * Retrieve a buffer from Pinata IPFS gateway
 * @param {string} cid - The content ID to retrieve
 * @returns {Promise<Uint8Array>} - The retrieved content as Uint8Array
 */
export async function getBufferFromIPFS(cid) {
    try {
        const url = `${PINATA_GATEWAY}/ipfs/${cid}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Failed to retrieve CID ${cid}: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return new Uint8Array(arrayBuffer);
    } catch (error) {
        console.error("Pinata Retrieve Error:", error);
        throw error;
    }
}

/**
 * Retrieve file from Pinata as a Blob (useful for downloads)
 * @param {string} cid - The content ID to retrieve
 * @returns {Promise<Blob>} - The retrieved content as Blob
 */
export async function getBlobFromIPFS(cid) {
    try {
        const url = `${PINATA_GATEWAY}/ipfs/${cid}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Failed to retrieve CID ${cid}: ${response.statusText}`);
        }

        return await response.blob();
    } catch (error) {
        console.error("Pinata Blob Retrieve Error:", error);
        throw error;
    }
}
