import React, { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, ShieldCheck } from "lucide-react";

export default function UploadZone({ onFilesSelected, disabled }) {
  const onDrop = useCallback((acceptedFiles) => {
    if (acceptedFiles?.length > 0) onFilesSelected?.(acceptedFiles);
  }, [onFilesSelected]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled,
    noClick: disabled,
  });

  return (
    <>
      {/* Global drag overlay */}
      {isDragActive && (
        <div className="drop-overlay">
          <div className="text-center">
            <Upload className="w-16 h-16 text-electric-500 mx-auto mb-4 animate-bounce" />
            <p className="text-2xl font-bold text-electric-700">Drop to securely upload</p>
            <p className="text-sm text-electric-600 mt-2">Files will be encrypted with AES-256-GCM</p>
          </div>
        </div>
      )}

      {/* Drop zone box */}
      <div
        {...getRootProps()}
        className={`
          border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all duration-300
          ${isDragActive
            ? "border-electric-400 bg-electric-50 scale-[1.01]"
            : "border-gray-200 bg-gray-50 hover:border-electric-300 hover:bg-electric-50/50"
          }
          ${disabled ? "opacity-50 cursor-not-allowed" : ""}
        `}
      >
        <input {...getInputProps()} />

        <div className="flex flex-col items-center">
          <div className="w-14 h-14 bg-electric-100 rounded-2xl flex items-center justify-center mb-4">
            <Upload className="w-7 h-7 text-electric-500" />
          </div>
          <p className="text-base font-semibold text-gray-700 mb-1">
            {isDragActive ? "Release to upload" : "Drop files here or click to browse"}
          </p>
          <p className="text-sm text-gray-400 mb-4">Upload any file type — encrypted end-to-end</p>

          <div className="flex items-center gap-2 bg-green-50 text-green-700 px-4 py-2 rounded-full text-xs font-medium">
            <ShieldCheck className="w-3.5 h-3.5" />
            AES-256-GCM · ECDH Key Wrapping · IPFS · Blockchain
          </div>
        </div>
      </div>
    </>
  );
}
