import React, { useCallback, useEffect, useState } from "react";
import { LayoutGrid, List, RefreshCw, FolderOpen, Search, Lock } from "lucide-react";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { ethers } from "ethers";
import toast from "react-hot-toast";

import {
  getSigner,
  getFileRegistry,
  getSemaphore,
  signAuthMessage,
  verifyContractsDeployed,
  NETWORK_CONFIG,
  semaphoreCreateGroup,
  semaphoreAddMember,
  semaphoreValidateProof,
} from "../utils/blockchain";

import FileCard from "../components/files/FileCard";
import FileRow from "../components/files/FileRow";
import FileInfoPanel from "../components/files/FileInfoPanel";
import UploadZone from "../components/files/UploadZone";
import UploadProgress from "../components/files/UploadProgress";

function stageToIndex(stageName) {
  if (!stageName) return 0;
  const s = stageName.toLowerCase();
  if (s.includes("read") || s.includes("prepar")) return 1;
  if (s.includes("encrypt")) return 2;
  if (s.includes("ipfs") || s.includes("upload") || s.includes("send")) return 3;
  if (s.includes("block") || s.includes("chain") || s.includes("wait") || s.includes("register") || s.includes("gdpr") || s.includes("complete")) return 4;
  return 2;
}

export default function ZkPublicFiles({ account, searchQuery }) {
  const [files, setFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState("grid");
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploads, setUploads] = useState([]);

  const filteredFiles = files.filter((f) =>
    !searchQuery || f.fileName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const loadFiles = useCallback(async () => {
    if (!account) return;
    try {
      setIsLoading(true);
      const res = await fetch("/api/zk-public/files");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch ZK files");
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      toast.error("Failed to load ZK files: " + err.message);
    } finally {
      setIsLoading(false);
    }
  }, [account]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleFilesSelected = async (selectedFiles) => {
    for (const file of selectedFiles) {
      await uploadZkPublicFile(file);
    }
  };

  const uploadZkPublicFile = async (file) => {
    const uploadId = Date.now() + Math.random();
    const updateProgress = (stage, progress, isDone = false, isError = false) => {
      setUploads((current) => current.map((u) => (u.id === uploadId ? { ...u, stage, progress, isDone, isError } : u)));
    };

    setUploads((current) => [...current, { id: uploadId, fileName: file.name, stage: "Reading file…", progress: 5, isDone: false, isError: false }]);

    try {
      updateProgress("Reading file…", 10);
      const signer = await getSigner();
      await verifyContractsDeployed(signer);
      const auth = await signAuthMessage(signer);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("fileName", file.name);

      updateProgress("Encrypting and uploading to IPFS…", 30);
      const uploadRes = await fetch("/api/zk-public/upload", {
        method: "POST",
        headers: { "x-user-address": auth.address, "x-signature": auth.signature, "x-message": auth.message },
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || "ZK upload failed");

      updateProgress("Creating file-specific ZK access policy…", 62);
      // NOTE: ZK files do NOT go through FileRegistry - they have no owner mapping
      // Backend will generate a unique fileId internally

      updateProgress("Setting up zero-knowledge identity…", 65);

      const identityStorageKey = `semaphoreIdentity_${String(account).toLowerCase()}`;
      let identity;
      const identityStored = localStorage.getItem(identityStorageKey);
      if (identityStored) {
        try {
          identity = Identity.import(identityStored);
        } catch {
          identity = new Identity();
          localStorage.setItem(identityStorageKey, identity.export());
        }
      } else {
        identity = new Identity();
        localStorage.setItem(identityStorageKey, identity.export());
      }

      updateProgress("Creating ZK access group…", 75);
      const semaphore = await getSemaphore(signer);
      const userAddress = await signer.getAddress();
      const createGroupTx = await semaphoreCreateGroup(semaphore, userAddress, 365 * 24 * 60 * 60);
      const createGroupReceipt = await createGroupTx.wait();
      
      if (!createGroupReceipt || !createGroupReceipt.events) {
        throw new Error("No events in group creation receipt");
      }
      
      const groupEvent = createGroupReceipt.events.find((e) => e.event === "GroupCreated");
      if (!groupEvent) {
        throw new Error("GroupCreated event not found in receipt");
      }
      
      const rawGroupId = groupEvent?.args?.groupId;
      if (!rawGroupId) {
        throw new Error("groupId not found in GroupCreated event args");
      }
      
      const groupId = rawGroupId?.toString ? rawGroupId.toString() : String(rawGroupId || "");
      if (!groupId || !/^\d+$/.test(groupId)) {
        throw new Error(`Invalid ZK groupId format: "${groupId}"`);
      }

      // Use helper to call Semaphore.addMember with proper error handling
      const addMemberTx = await semaphoreAddMember(semaphore, groupId, identity.commitment.toString());
      await addMemberTx.wait();

      updateProgress("Finalizing anonymous ZK-public listing…", 92);
      const registerAuth = await signAuthMessage(signer);
      const registerRes = await fetch("/api/zk-public/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-address": registerAuth.address,
          "x-signature": registerAuth.signature,
          "x-message": registerAuth.message,
        },
        body: JSON.stringify({
          fileHashHex: uploadData.fileHashHex,
          fileName: file.name,
          fileSize: file.size,
          groupId,
        }),
      });
      const registerData = await registerRes.json().catch(() => ({}));
      if (!registerRes.ok) throw new Error(registerData.error || "Failed to finalize ZK-public upload");
      
      // Backend generated the fileId for this ZK file
      const generatedFileId = registerData?.fileId;
      if (!generatedFileId) throw new Error("Server did not return fileId");
      
      // Store the fileId with groupId for future downloads
      const fileIdStorageKey = `zkFileId_${groupId}`;
      localStorage.setItem(fileIdStorageKey, String(generatedFileId));

      updateProgress("Complete!", 100, true);
      toast.success(`${file.name} uploaded to ZK files!`);

      setTimeout(() => {
        setUploads((current) => current.filter((u) => u.id !== uploadId));
        loadFiles();
      }, 1800);
    } catch (err) {
      updateProgress(err.message || "Upload failed", 0, false, true);
      toast.error(err.message || "ZK-public upload failed");
      setTimeout(() => setUploads((current) => current.filter((u) => u.id !== uploadId)), 5000);
    }
  };

  const handleDownload = async (file) => {
    const toastId = toast.loading("Generating ZK proof and downloading…");
    try {
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);
      const downloadWithAuth = async () => {
        const dlRes = await fetch(`/api/zk-public/download/${file.id}`, {
          headers: {
            "x-user-address": auth.address,
            "x-signature": auth.signature,
            "x-message": auth.message,
          },
        });
        return dlRes;
      };

      // Fast-path: if backend already has cached ZK verification for this user+file, skip on-chain proof.
      let dlRes = await downloadWithAuth();
      if (dlRes.ok) {
        const blob = await dlRes.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.fileName || `file_${file.id}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.success("File downloaded!", { id: toastId });
        return;
      }

      if (dlRes.status !== 403) {
        const errData = await dlRes.json().catch(() => ({ error: "Download failed" }));
        throw new Error(errData.error || "Download failed");
      }

      const semaphore = await getSemaphore(signer);

      const groupIdStr = String(file.groupId || "");
      if (!groupIdStr) {
        throw new Error(`File has no groupId. It may not be a valid ZK file.`);
      }
      
      if (!/^\d+$/.test(groupIdStr)) {
        throw new Error(`Invalid ZK groupId format: "${groupIdStr}". Must be numeric.`);
      }

      const storageKey = `semaphoreIdentity_${String(auth.address).toLowerCase()}`;
      const stored = localStorage.getItem(storageKey);
      if (!stored) {
        throw new Error("No Semaphore identity found for this wallet/browser profile.");
      }

      let identity;
      try {
        identity = Identity.import(stored);
      } catch {
        throw new Error("Stored Semaphore identity is invalid. Recreate it in Settings.");
      }

      // Properly encode groupId as BigNumber for contract queries
      const groupIdNum = ethers.BigNumber.from(groupIdStr);
      const members = [];

      try {
        const ev1 = await semaphore.queryFilter(semaphore.filters.MemberAdded(groupIdNum), 0, "latest");
        for (const ev of ev1) {
          const commitment = ev?.args?.identityCommitment;
          if (commitment !== undefined && commitment !== null) members.push(commitment.toString());
        }
      } catch (err) {
        console.warn("Error querying MemberAdded events:", err.message);
      }

      try {
        const ev2 = await semaphore.queryFilter(semaphore.filters.MembersAdded(groupIdNum), 0, "latest");
        for (const ev of ev2) {
          const arr = ev?.args?.identityCommitments || [];
          for (const commitment of arr) members.push(commitment.toString());
        }
      } catch (err) {
        console.warn("Error querying MembersAdded events:", err.message);
      }

      if (members.length === 0) {
        throw new Error(`No members found in ZK group ${groupIdStr}. Either the group doesn't exist on chain or has been deleted.`);
      }

      const localCommitment = identity.commitment.toString();
      const isMember = members.some((m) => String(m) === localCommitment);
      if (!isMember) {
        throw new Error("Your identity is not a member of this file's ZK group. You cannot access this file.");
      }

      const group = new Group(members);
      const packedHash = ethers.utils.solidityKeccak256(["uint256", "address"], [file.id, auth.address]);
      const message = ethers.BigNumber.from(packedHash).toString();
      const scopeSeed = ethers.utils.solidityKeccak256(
        ["uint256", "address", "uint256"],
        [file.id, auth.address, ethers.BigNumber.from(ethers.utils.randomBytes(8)).toString()]
      );
      const scope = ethers.BigNumber.from(scopeSeed).toString();
      const proof = await generateProof(identity, group, message, scope);

      // Use helper to call Semaphore.validateProof with proper error handling
      const verifyTx = await semaphoreValidateProof(semaphore, groupIdNum, proof);
      await verifyTx.wait();

      const verifyRes = await fetch("/api/zk-public/verify-proof", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-address": auth.address,
          "x-signature": auth.signature,
          "x-message": auth.message,
        },
        body: JSON.stringify({
          fileId: file.id,
          proofTxHash: verifyTx.hash,
          proofScope: scope,
        }),
      });
      const verifyData = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok) {
        throw new Error(verifyData.error || "Backend proof verification failed");
      }

      dlRes = await downloadWithAuth();
      if (!dlRes.ok) {
        const errData = await dlRes.json().catch(() => ({ error: "Download failed" }));
        throw new Error(errData.error || "Download failed");
      }

      const blob = await dlRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.fileName || `file_${file.id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      toast.success("File downloaded with ZK access proof!", { id: toastId });
    } catch (err) {
      toast.error(err.message || "Download failed", { id: toastId });
    }
  };

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <div className="w-16 h-16 bg-electric-50 rounded-2xl flex items-center justify-center mb-4">
          <Lock className="w-8 h-8 text-electric-400" />
        </div>
        <h2 className="text-xl font-bold text-gray-800 mb-2">Connect Your Wallet</h2>
        <p className="text-gray-400 text-sm">Connect MetaMask to access ZK files</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">ZK Public Files</h1>
          <p className="text-sm text-gray-400 mt-0.5">Publicly listed files with zero-knowledge access proof for download</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-gray-100 rounded-xl p-1">
            <button
              onClick={() => setViewMode("grid")}
              className={`p-2 rounded-lg transition-colors ${viewMode === "grid" ? "bg-white shadow-sm text-electric-600" : "text-gray-400 hover:text-gray-600"}`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`p-2 rounded-lg transition-colors ${viewMode === "list" ? "bg-white shadow-sm text-electric-600" : "text-gray-400 hover:text-gray-600"}`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
          <button onClick={loadFiles} className="btn-icon" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="mb-6">
        <UploadZone onFilesSelected={handleFilesSelected} disabled={uploads.length > 0} />
      </div>

      {uploads.length > 0 && (
        <div className="mb-6 space-y-3">
          {uploads.map((u) => (
            <UploadProgress
              key={u.id}
              fileName={u.fileName}
              progress={u.progress}
              currentStage={stageToIndex(u.stage)}
              isDone={u.isDone}
              isError={u.isError}
            />
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-col items-center py-20 text-gray-400">
          <div className="w-8 h-8 border-2 border-electric-400 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm">Loading ZK file registry…</p>
        </div>
      ) : filteredFiles.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-20 h-20 bg-electric-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <FolderOpen className="w-10 h-10 text-electric-300" />
          </div>
          <h3 className="text-lg font-bold text-gray-800 mb-2">
            {searchQuery ? "No matching files" : "No ZK files yet"}
          </h3>
          <p className="text-sm text-gray-400 mb-4">
            {searchQuery ? `No ZK files match "${searchQuery}"` : "Upload a file to publish it in the ZK-only access page"}
          </p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {filteredFiles.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              onClick={setSelectedFile}
              onDownload={handleDownload}
              onShare={() => toast("Sharing is disabled in ZK public files")}
              onCopyCid={() => {}}
              onErase={() => {}}
            />
          ))}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-4 px-4 py-2.5 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-400">
            <div className="w-4" />
            <div className="w-9" />
            <div className="flex-1">Name</div>
            <div className="w-20 hidden sm:block">Size</div>
            <div className="w-32 hidden md:block">Uploaded</div>
            <div className="w-24 hidden lg:block">Shared</div>
            <div className="hidden xl:block w-16">Security</div>
            <div className="w-16">Actions</div>
          </div>
          {filteredFiles.map((file) => (
            <FileRow
              key={file.id}
              file={{ ...file, activeShares: [] }}
              onClick={setSelectedFile}
              onShare={() => toast("Sharing is disabled in ZK public files")}
              onDownload={handleDownload}
            />
          ))}
        </div>
      )}

      {selectedFile && (
        <FileInfoPanel
          file={selectedFile}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}
