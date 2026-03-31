import React, { useState, useEffect, useCallback } from "react";
import {
  LayoutGrid, List, Upload, FolderOpen, RefreshCw
} from "lucide-react";
import {
  getSigner, getFileRegistry, getAccessControl, getTimeBoundPermissions, signAuthMessage, safeGetOwnerFileIds, verifyContractsDeployed, NETWORK_CONFIG
} from "../utils/blockchain";
import FileCard from "../components/files/FileCard";
import FileRow from "../components/files/FileRow";
import FileInfoPanel from "../components/files/FileInfoPanel";
import UploadZone from "../components/files/UploadZone";
import UploadProgress from "../components/files/UploadProgress";
import ShareModal from "../components/sharing/ShareModal";
import toast from "react-hot-toast";

// Format uploader stage → 1-indexed (1=reading,2=encrypting,3=ipfs,4=blockchain)
function stageToIndex(stageName) {
  if (!stageName) return 0;
  const s = stageName.toLowerCase();
  if (s.includes("read") || s.includes("prepar")) return 1;
  if (s.includes("encrypt")) return 2;
  if (s.includes("ipfs") || s.includes("upload") || s.includes("send")) return 3;
  if (s.includes("block") || s.includes("chain") || s.includes("wait") || s.includes("register") || s.includes("gdpr") || s.includes("complete")) return 4;
  return 2;
}

export default function MyFiles({ account, searchQuery }) {
  const [files, setFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState("grid"); // "grid" | "list"
  const [selectedFile, setSelectedFile] = useState(null);
  const [shareFile, setShareFile] = useState(null);
  const [uploads, setUploads] = useState([]); // per-file upload progress

  const filteredFiles = files.filter(f =>
    !searchQuery || f.fileName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const loadFiles = useCallback(async () => {
    if (!account) return;
    try {
      setIsLoading(true);
      const signer = await getSigner();
      
      // Verify contracts are deployed before attempting any operations
      await verifyContractsDeployed(signer);
      
      const registry = await getFileRegistry(signer);
      const accessControl = await getAccessControl(signer);
      const timeBound = await getTimeBoundPermissions(signer);
      const fileIds = await safeGetOwnerFileIds(registry, account);

      const results = await Promise.all(fileIds.map(async (idBN) => {
        const id = Number(idBN);
        const data = await registry.getFile(id);
        const grantees = await accessControl.getFileGrantees(id);
        const activeShares = [];
        for (const grantee of grantees) {
          try {
            const isValid = await timeBound.isAccessValid(grantee, id);
            if (isValid) {
              const perm = await timeBound.getPermissionForUserFile(grantee, id);
              activeShares.push({ address: grantee, expiryX: perm.expiryTimestamp.toNumber() * 1000 });
            }
          } catch { /* no time-bound record */ }
        }
        return {
          id,
          owner: data.owner,
          cids: data.cids,
          hash: data.fileHash,
          timestamp: data.timestamp.toNumber() * 1000,
          isDeleted: data.isDeleted,
          fileName: data.fileName,
          fileSize: data.fileSize.toNumber(),
          activeShares,
        };
      }));

      setFiles(results.filter(f => !f.isDeleted).reverse());
    } catch (err) {
      toast.error("Failed to load files: " + err.message);
    } finally {
      setIsLoading(false);
    }
  }, [account]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const handleFilesSelected = async (selectedFiles) => {
    for (const file of selectedFiles) {
      await uploadFile(file);
    }
  };

  const uploadFile = async (file) => {
    const uploadId = Date.now() + Math.random();
    const updateProgress = (stage, progress, isDone = false, isError = false) => {
      setUploads(us => us.map(u => u.id === uploadId ? { ...u, stage, progress, isDone, isError } : u));
    };

    setUploads(us => [...us, { id: uploadId, fileName: file.name, stage: "Reading file…", progress: 5, isDone: false, isError: false }]);

    try {
      updateProgress("Reading file…", 10);
      const signer = await getSigner();
      
      // Verify contracts are deployed before attempting upload
      await verifyContractsDeployed(signer);
      
      const auth = await signAuthMessage(signer);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("userAddress", account);
      formData.append("fileName", file.name);

      updateProgress("Encrypting (AES-256-GCM) and uploading to IPFS…", 30);
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "x-user-address": auth.address, "x-signature": auth.signature, "x-message": auth.message },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");

      updateProgress("Writing to blockchain…", 70);
      const registry = await getFileRegistry(signer);
      const code = await signer.provider.getCode(registry.address);
      if (!code || code === "0x") {
        throw new Error(
          `FileRegistry not found at ${registry.address} on chain ${NETWORK_CONFIG.chainId}.\n` +
          `Hard-refresh browser (Ctrl+F5) and redeploy contracts if needed.`
        );
      }
      const fileHashBytes32 = "0x" + data.fileHashHex.slice(0, 64);
      const tx = await registry.uploadFile(data.cids, fileHashBytes32, file.name, file.size);
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        throw new Error("Blockchain transaction failed while uploading metadata.");
      }

      let newFileId;
      if (receipt.events) {
        const ev = receipt.events.find(e => e.event === "FileUploaded");
        const rawFileId = ev?.args?.fileId;
        if (rawFileId !== undefined && rawFileId !== null) {
          if (typeof rawFileId === "number") {
            newFileId = rawFileId;
          } else if (typeof rawFileId.toNumber === "function") {
            newFileId = rawFileId.toNumber();
          } else {
            newFileId = Number(rawFileId.toString());
          }
        }
      }

      if (!Number.isInteger(newFileId) || newFileId < 0) {
        throw new Error(
          "Upload transaction did not return a valid fileId. This usually means contract address/ABI mismatch or wrong network."
        );
      }

      updateProgress("Registering ownership metadata…", 85);
      const accessControl = await getAccessControl(signer);
      const timeBound = await getTimeBoundPermissions(signer);
      const { getGDPRCompliance } = await import("../utils/blockchain");
      const gdpr = await getGDPRCompliance(signer);

      await (await accessControl.registerFileOwner(newFileId)).wait();
      await (await timeBound.registerFileOwner(newFileId)).wait();
      await (await gdpr.registerFile(newFileId)).wait();

      // Register encryption materials on backend
      const registerAuth = await signAuthMessage(signer);
      const regRes = await fetch("/api/materials/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-address": registerAuth.address, "x-signature": registerAuth.signature, "x-message": registerAuth.message },
        body: JSON.stringify({ fileId: newFileId, fileHashHex: data.fileHashHex }),
      });
      const regData = await regRes.json().catch(() => ({}));
      if (!regRes.ok) {
        throw new Error(regData.error || "Failed to register decryption materials");
      }

      updateProgress("Complete!", 100, true);
      toast.success(`${file.name} uploaded securely!`);
      setTimeout(() => {
        setUploads(us => us.filter(u => u.id !== uploadId));
        loadFiles();
      }, 3000);

    } catch (err) {
      updateProgress(err.message, 0, false, true);
      toast.error(err.message || "Upload failed");
      setTimeout(() => setUploads(us => us.filter(u => u.id !== uploadId)), 5000);
    }
  };

  const handleDownload = async (file) => {
    const toastId = toast.loading("Verifying access & decrypting…");
    try {
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);
      const res = await fetch(`/api/access/${file.id}`, {
        headers: { "x-user-address": auth.address, "x-signature": auth.signature, "x-message": auth.message },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Download failed" }));
        if (res.status === 400 && String(err.error || "").toLowerCase().includes("missing decryption materials")) {
          throw new Error("Missing decryption materials for this fileId. Re-upload this file so backend materials can be re-registered.");
        }
        throw new Error(err.error || "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = file.fileName || `file_${file.id}`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast.success("File decrypted and downloaded!", { id: toastId });
    } catch (err) {
      toast.error(err.message || "Download failed", { id: toastId });
    }
  };

  const handleErase = async (file) => {
    const confirmErase = window.confirm(`Request GDPR erasure for "${file.fileName || `file_${file.id}`}"?`);
    if (!confirmErase) return;

    const toastId = toast.loading("Requesting erasure…");
    try {
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);
      const res = await fetch("/api/gdpr/erase", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-address": auth.address,
          "x-signature": auth.signature,
          "x-message": auth.message,
        },
        body: JSON.stringify({ fileId: file.id, cids: file.cids || [] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Erasure failed");

      setFiles((prev) => prev.filter((f) => f.id !== file.id));
      toast.success("Erasure request completed", { id: toastId });
    } catch (err) {
      toast.error(err.message || "Erasure failed", { id: toastId });
    }
  };

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <div className="w-16 h-16 bg-electric-50 rounded-2xl flex items-center justify-center mb-4">
          <FolderOpen className="w-8 h-8 text-electric-400" />
        </div>
        <h2 className="text-xl font-bold text-gray-800 mb-2">Connect Your Wallet</h2>
        <p className="text-gray-400 text-sm">Connect MetaMask to access your files</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Files</h1>
          <p className="text-sm text-gray-400 mt-0.5">{files.length} encrypted file{files.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
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

      {/* Upload zone */}
      <div className="mb-6">
        <UploadZone onFilesSelected={handleFilesSelected} disabled={uploads.length > 0} />
      </div>

      {/* Active uploads */}
      {uploads.length > 0 && (
        <div className="mb-6 space-y-3">
          {uploads.map(u => (
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

      {/* Files */}
      {isLoading ? (
        <div className="flex flex-col items-center py-20 text-gray-400">
          <div className="w-8 h-8 border-2 border-electric-400 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm">Loading blockchain registry…</p>
        </div>
      ) : filteredFiles.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-20 h-20 bg-electric-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <FolderOpen className="w-10 h-10 text-electric-300" />
          </div>
          <h3 className="text-lg font-bold text-gray-800 mb-2">
            {searchQuery ? "No matching files" : "No files yet"}
          </h3>
          <p className="text-sm text-gray-400 mb-4">
            {searchQuery ? `No files match "${searchQuery}"` : "Upload your first file — encrypted end-to-end"}
          </p>
        
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {filteredFiles.map(file => (
            <FileCard
              key={file.id}
              file={file}
              onClick={setSelectedFile}
              onShare={setShareFile}
              onDownload={handleDownload}
              onErase={handleErase}
              onCopyCid={() => toast.success("CID copied!")}
            />
          ))}
        </div>
      ) : (
        <div className="card overflow-hidden">
          {/* List header */}
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
          {filteredFiles.map(file => (
            <FileRow
              key={file.id}
              file={file}
              onClick={setSelectedFile}
              onShare={setShareFile}
              onDownload={handleDownload}
            />
          ))}
        </div>
      )}

      {/* Side panel */}
      {selectedFile && (
        <FileInfoPanel file={selectedFile} onClose={() => setSelectedFile(null)} />
      )}

      {/* Share modal */}
      {shareFile && (
        <ShareModal file={shareFile} account={account} onClose={() => setShareFile(null)} />
      )}
    </div>
  );
}
