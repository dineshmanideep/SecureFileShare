The best option for local transaction monitoring is **Blockscout**. It’s open-source, easy to set up, and provides a full-featured web UI similar to Etherscan.

# or we can use tenderly and deploy the stuff

**How to use Blockscout locally:**

1. **Install Docker and Docker Compose** (if not already installed).

2. **Get the Blockscout Docker Compose file:**  
   You can use the official one or a minimal version. Example:
   ```bash
   curl -O https://raw.githubusercontent.com/blockscout/blockscout/master/docker/docker-compose-blockscout.yml
   ```

3. **Edit the compose file:**  
   - Set the `ETHEREUM_JSONRPC_HTTP_URL` to your local Hardhat node (e.g., `http://host.docker.internal:8545` on Windows/Mac, or `http://172.17.0.1:8545` on Linux).
   - Example change in the `environment:` section:
     ```
     ETHEREUM_JSONRPC_HTTP_URL: "http://host.docker.internal:8545"
     ```

4. **Start Blockscout:**  
   ```bash
   docker compose -f docker-compose-blockscout.yml up
   ```

5. **Open the Blockscout UI:**  
   - Visit [http://localhost:4000](http://localhost:4000) in your browser.
   - You can now search for transactions, addresses, contracts, and events on your local chain.

**Summary:**  
Blockscout is the easiest and most robust local explorer. Just run it with Docker, point it to your Hardhat node, and use the web UI for all your monitoring needs.5. **Open the Blockscout UI:**  
   - Visit [http://localhost:4000](http://localhost:4000) in your browser.
   - You can now search for transactions, addresses, contracts, and events on your local chain.

**Summary:**  
Blockscout is the easiest and most robust local explorer. Just run it with Docker, point it to your Hardhat node, and use the web UI for all your monitoring needs.