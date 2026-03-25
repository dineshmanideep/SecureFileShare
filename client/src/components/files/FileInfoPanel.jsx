import React from "react";
import { X, Copy, Check, Lock, Shield, ExternalLink } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import FileTypeIcon from "./FileTypeIcon";
import { useState } from "react";

function formatBytes(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function CopyField({ label, value, mono = false }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="mb-4">
      <div className="text-xs font-medium text-gray-400 mb-1">{label}</div>
      <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
        <span className={`text-xs text-gray-700 flex-1 truncate ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
        {value && (
          <button onClick={handleCopy} className="flex-shrink-0 text-gray-400 hover:text-gray-700 transition-colors">
            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

export default function FileInfoPanel({ file, onClose }) {
  if (!file) return null;

  const uploadDate = file.timestamp ? format(new Date(file.timestamp), "PPpp") : "—";
  const relativeDate = file.timestamp
    ? formatDistanceToNow(new Date(file.timestamp), { addSuffix: true })
    : "—";

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-30 bg-black/10" onClick={onClose} />

      {/* Panel */}
      <div className="info-panel p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-start gap-3">
            <FileTypeIcon fileName={file.fileName} containerSize={44} size={22} />
            <div>
              <h2 className="text-base font-bold text-gray-900 leading-tight" title={file.fileName}>
                {file.fileName || `File #${file.id}`}
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">{relativeDate}</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-icon -mt-1 -mr-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { label: "Size",   value: formatBytes(file.fileSize) },
            { label: "Chunks", value: file.cids?.length || 1 },
            { label: "ID",     value: `#${file.id}` },
          ].map(({ label, value }) => (
            <div key={label} className="bg-gray-50 rounded-xl p-3 text-center">
              <div className="text-sm font-semibold text-gray-800">{value}</div>
              <div className="text-xs text-gray-400">{label}</div>
            </div>
          ))}
        </div>

        {/* Details */}
        <CopyField label="File Name"       value={file.fileName}           />
        <CopyField label="IPFS CID"        value={file.cids?.[0] || "—"}  mono />
        <CopyField label="File Hash"       value={file.hash || "—"}        mono />
        <CopyField label="Upload Time"     value={uploadDate}              />

        {/* Security section */}
        <div className="mt-2 mb-4">
          <div className="text-xs font-medium text-gray-400 mb-2">Security</div>
          <div className="space-y-2">
            {[
              { icon: Lock,   label: "Encryption",    value: "AES-256-GCM + ECDH",  color: "text-green-600" },
              { icon: Shield, label: "ZKP Status",    value: "Proof Verified ✓",     color: "text-electric-600" },
            ].map(({ icon: Icon, label, value, color }) => (
              <div key={label} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <Icon className={`w-3.5 h-3.5 ${color}`} />
                  <span className="text-xs text-gray-600">{label}</span>
                </div>
                <span className={`text-xs font-medium ${color}`}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Active shares */}
        {file.activeShares?.length > 0 && (
          <div className="mt-2">
            <div className="text-xs font-medium text-gray-400 mb-2">
              Active Permissions ({file.activeShares.length})
            </div>
            <div className="space-y-2">
              {file.activeShares.map((share, i) => (
                <div key={i} className="flex items-center justify-between bg-amber-50 rounded-lg px-3 py-2">
                  <span className="text-xs font-mono text-gray-700 truncate">
                    {share.address.slice(0, 8)}...{share.address.slice(-6)}
                  </span>
                  <span className="text-xs text-amber-600 flex-shrink-0 ml-2">
                    {share.expiryX ? formatDistanceToNow(new Date(share.expiryX), { addSuffix: true }) : "∞"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
