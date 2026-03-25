import React, { useEffect, useRef, useState } from "react";
import { MoreVertical, Share2, Download, Copy, Trash2, Info, Lock, Check } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import FileTypeIcon from "./FileTypeIcon";

function formatBytes(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

export default function FileCard({ file, onClick, onShare, onDownload, onErase, onCopyCid }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [cidCopied, setCidCopied] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (event) => {
      if (!menuRef.current || !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [menuOpen]);

  const handleCopyCid = (e) => {
    e.stopPropagation();
    const cid = Array.isArray(file.cids) ? file.cids[0] : file.cids;
    if (cid) {
      navigator.clipboard.writeText(cid);
      setCidCopied(true);
      setTimeout(() => setCidCopied(false), 2000);
      onCopyCid?.();
    }
    setMenuOpen(false);
  };

  const dateLabel = file.timestamp
    ? formatDistanceToNow(new Date(file.timestamp), { addSuffix: true })
    : "—";

  return (
    <div
      className="file-card group relative"
      onClick={() => onClick?.(file)}
    >
      {/* Three-dot menu */}
      <div className="absolute top-3 right-3 z-30" ref={menuRef}>
        <button
          className="btn-icon opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          aria-label="File options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>

        {menuOpen && (
          <div
            className="absolute right-0 top-8 w-48 bg-white rounded-xl shadow-xl border border-gray-100 z-20 animate-fade-in overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {[
              { icon: Share2,   label: "Share",          action: () => { onShare?.(file); setMenuOpen(false); }, color: "text-electric-600" },
              { icon: Download, label: "Download",        action: () => { onDownload?.(file); setMenuOpen(false); } },
              { icon: cidCopied ? Check : Copy, label: cidCopied ? "Copied!" : "Copy CID", action: handleCopyCid },
              { icon: Info,     label: "File Info",       action: () => { onClick?.(file); setMenuOpen(false); } },
              { icon: Trash2,   label: "Request Erasure", action: () => { onErase?.(file); setMenuOpen(false); }, color: "text-red-500" },
            ].map(({ icon: Icon, label, action, color }) => (
              <button
                key={label}
                onClick={(e) => {
                  e.stopPropagation();
                  action(e);
                }}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-gray-50 transition-colors ${color || "text-gray-700"}`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Icon */}
      <FileTypeIcon fileName={file.fileName} containerSize={44} size={22} />

      {/* File name */}
      <div
        className="mt-3 text-sm font-semibold text-gray-800 truncate leading-tight"
        title={file.fileName}
      >
        {file.fileName || `File #${file.id}`}
      </div>

      {/* Meta */}
      <div className="mt-1 text-xs text-gray-400 space-y-0.5">
        <div>{formatBytes(file.fileSize)}</div>
        <div>{dateLabel}</div>
      </div>

      {/* Encryption badge */}
      <div className="mt-3 flex items-center gap-1">
        <span className="badge badge-green text-xs" title="Protected with AES-256-GCM + ECDH Key Wrapping">
          <Lock className="w-2.5 h-2.5" />
          AES-256-GCM + ECDH
        </span>
      </div>

      {/* Active shares indicator */}
      {file.activeShares?.length > 0 && (
        <div className="mt-1">
          <span className="badge badge-blue text-xs">
            <Share2 className="w-2.5 h-2.5" />
            {file.activeShares.length} shared
          </span>
        </div>
      )}
    </div>
  );
}
