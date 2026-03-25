import React from "react";
import { formatDistanceToNow } from "date-fns";
import { Download, Share2, Lock } from "lucide-react";
import FileTypeIcon from "./FileTypeIcon";

function formatBytes(bytes) {
  if (!bytes) return "—";
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

export default function FileRow({ file, onClick, onShare, onDownload, selected, onSelect }) {
  const relDate = file.timestamp
    ? formatDistanceToNow(new Date(file.timestamp), { addSuffix: true })
    : "—";

  return (
    <div
      className={`file-row ${selected ? "bg-electric-50" : ""}`}
      onClick={() => onClick?.(file)}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        className="rounded border-gray-300 text-electric-500 focus:ring-electric-400 w-4 h-4 flex-shrink-0"
        checked={selected || false}
        onChange={(e) => { e.stopPropagation(); onSelect?.(file.id); }}
        onClick={(e) => e.stopPropagation()}
      />

      {/* Icon */}
      <FileTypeIcon fileName={file.fileName} containerSize={36} size={18} />

      {/* Name */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-gray-800 truncate">{file.fileName || `File #${file.id}`}</div>
        <div className="text-xs text-gray-400 font-mono truncate">{file.cids?.[0]?.slice(0, 20)}…</div>
      </div>

      {/* Size */}
      <div className="w-20 text-sm text-gray-500 hidden sm:block">{formatBytes(file.fileSize)}</div>

      {/* Date */}
      <div className="w-32 text-sm text-gray-400 hidden md:block">{relDate}</div>

      {/* Shares */}
      <div className="w-24 hidden lg:block">
        {file.activeShares?.length > 0 ? (
          <span className="badge badge-blue text-xs">{file.activeShares.length} shared</span>
        ) : (
          <span className="text-xs text-gray-300">—</span>
        )}
      </div>

      {/* Encryption */}
      <div className="hidden xl:flex items-center gap-1">
        <Lock className="w-3 h-3 text-green-500" />
        <span className="text-xs text-green-600">ECDH</span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <button
          className="btn-icon"
          title="Download"
          onClick={() => onDownload?.(file)}
        >
          <Download className="w-3.5 h-3.5" />
        </button>
        <button
          className="btn-icon"
          title="Share"
          onClick={() => onShare?.(file)}
        >
          <Share2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
