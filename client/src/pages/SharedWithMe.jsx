import React, { useState, useEffect, useCallback } from "react";
import { Share2, Download, Clock, RefreshCw, Loader2, Users } from "lucide-react";
import { getSigner, getTimeBoundPermissions, signAuthMessage } from "../utils/blockchain";
import FileTypeIcon from "../components/files/FileTypeIcon";
import AccessVerification from "../components/sharing/AccessVerification";
import toast from "react-hot-toast";
import { formatDistanceToNow } from "date-fns";

function CountdownTimer({ expiryTs }) {
  const [timeLeft, setTimeLeft] = useState("");
  const [isExpired, setIsExpired] = useState(false);
  const [isWarning, setIsWarning] = useState(false);

  useEffect(() => {
    const update = () => {
      const now = Date.now();
      const diff = expiryTs - now;
      if (diff <= 0) { setIsExpired(true); setTimeLeft("Expired"); return; }
      setIsWarning(diff < 3600000); // < 1 hour
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      const parts = [];
      if (d > 0) parts.push(`${d}d`);
      if (h > 0) parts.push(`${h}h`);
      parts.push(`${m}m`);
      if (d === 0 && h === 0) parts.push(`${s}s`);
      setTimeLeft(parts.join(" "));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [expiryTs]);

  if (isExpired) return <span className="badge badge-red text-xs">EXPIRED</span>;
  return (
    <span className={`text-xs font-medium font-mono ${isWarning ? "text-red-500" : "text-amber-600"}`}>
      Expires in {timeLeft}
    </span>
  );
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

export default function SharedWithMe({ account, searchQuery }) {
  const [files, setFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState(null);
  const [verifyModal, setVerifyModal] = useState({ open: false, steps: 0, isDone: false, error: null });

  const filteredFiles = files.filter(f =>
    !searchQuery || f.fileName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const loadFiles = useCallback(async () => {
    if (!account) return;
    try {
      setIsLoading(true);
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);
      const res = await fetch(`/api/received-shares?userAddress=${auth.address}`, {
        headers: {
          "x-user-address": auth.address,
          "x-signature": auth.signature,
          "x-message": auth.message,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFiles(data.files || []);
    } catch (err) {
      toast.error("Failed to load shared files: " + err.message);
    } finally {
      setIsLoading(false);
    }
  }, [account]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const handleDownload = async (file) => {
    if (!file.isAccessValid) { toast.error("Access has expired"); return; }
    setDownloadingId(file.id);
    setVerifyModal({ open: true, steps: 0, isDone: false, error: null });

    try {
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);

      // Simulate verification steps with delays for UX
      for (let step = 1; step <= 5; step++) {
        setVerifyModal(v => ({ ...v, steps: step }));
        await new Promise(r => setTimeout(r, 400));
      }

      const res = await fetch(`/api/access/${file.id}`, {
        headers: { "x-user-address": auth.address, "x-signature": auth.signature, "x-message": auth.message },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Download failed" }));
        throw new Error(err.error);
      }

      setVerifyModal(v => ({ ...v, steps: 6 }));
      await new Promise(r => setTimeout(r, 400));

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = file.fileName || `shared_${file.id}`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);

      setVerifyModal(v => ({ ...v, isDone: true }));
      toast.success("File downloaded!");
    } catch (err) {
      setVerifyModal(v => ({ ...v, error: err.message }));
      toast.error(err.message || "Download failed");
    } finally {
      setDownloadingId(null);
    }
  };

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <Users className="w-12 h-12 text-gray-300 mb-4" />
        <h2 className="text-xl font-bold text-gray-700 mb-2">Connect Your Wallet</h2>
        <p className="text-gray-400 text-sm">Connect MetaMask to see files shared with you</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Shared With Me</h1>
          <p className="text-sm text-gray-400 mt-0.5">Files shared to your wallet address</p>
        </div>
        <button onClick={loadFiles} className="btn-icon" title="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center py-20 text-gray-400">
          <div className="w-8 h-8 border-2 border-electric-400 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm">Scanning blockchain for shared files…</p>
        </div>
      ) : filteredFiles.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-20 h-20 bg-purple-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Share2 className="w-10 h-10 text-purple-300" />
          </div>
          <h3 className="text-lg font-bold text-gray-800 mb-2">
            {searchQuery ? "No matching files" : "Nothing shared yet"}
          </h3>
          <p className="text-sm text-gray-400">
            {searchQuery ? `No shared files match "${searchQuery}"` : "Files shared with your wallet address will appear here."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredFiles.map((file) => (
            <div
              key={file.id}
              className={`card p-5 ${!file.isAccessValid ? "opacity-60" : ""}`}
            >
              <div className="flex items-start gap-4">
                <FileTypeIcon fileName={file.fileName} containerSize={44} size={22} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 truncate" title={file.fileName}>
                        {file.fileName}
                      </h3>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        <span className="text-xs text-gray-400">{formatBytes(file.fileSize)}</span>
                        <span className="text-xs text-gray-300">·</span>
                        <span className="text-xs text-gray-400">
                          Uploaded {formatDistanceToNow(new Date(file.uploadTimestamp), { addSuffix: true })}
                        </span>
                        <span className="text-xs text-gray-300">·</span>
                        <div className="flex items-center gap-1 text-xs text-purple-500">
                          <Share2 className="w-3 h-3" />
                          Shared by{" "}
                          <span className="font-mono">{file.owner.slice(0, 8)}…{file.owner.slice(-6)}</span>
                          {file.sharedVia === "group" && (
                            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-600 border border-blue-100">Group</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex-shrink-0 flex items-center gap-2 flex-wrap justify-end">
                      {/* Access status */}
                      {file.isAccessValid ? (
                        <span className="badge badge-green">Active</span>
                      ) : (
                        <span className="badge badge-red">Expired</span>
                      )}

                      {/* Timer */}
                      {file.expiryTimestamp && (
                        <CountdownTimer expiryTs={file.expiryTimestamp} />
                      )}
                    </div>
                  </div>

                  {/* Download button */}
                  <div className="mt-3">
                    <button
                      onClick={() => handleDownload(file)}
                      disabled={!file.isAccessValid || downloadingId === file.id}
                      className="btn-primary text-xs flex items-center gap-2 py-2 px-4"
                    >
                      {downloadingId === file.id
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Decrypting…</>
                        : !file.isAccessValid
                          ? "Access Expired"
                          : <><Download className="w-3.5 h-3.5" /> Download & Decrypt</>
                      }
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Access verification modal */}
      <AccessVerification
        isOpen={verifyModal.open}
        steps={verifyModal.steps}
        isDone={verifyModal.isDone}
        error={verifyModal.error}
        onClose={() => setVerifyModal({ open: false, steps: 0, isDone: false, error: null })}
      />
    </div>
  );
}
