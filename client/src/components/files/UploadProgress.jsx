import React from "react";
import { Check, Loader2 } from "lucide-react";

const STAGES = [
  { id: 1, label: "Reading file",            detail: "Loading file into memory" },
  { id: 2, label: "Encrypting (AES-256)",    detail: "Chunking and encrypting with AES-256-GCM" },
  { id: 3, label: "Uploading to IPFS",       detail: "Pinning encrypted chunks via Pinata" },
  { id: 4, label: "Writing to blockchain",   detail: "Recording CIDs and ZKP proof on-chain" },
];

export default function UploadProgress({ fileName, progress, currentStage, isDone, isError }) {
  // currentStage: 1-4 (which stage is actively running)
  const pct = Math.round(progress || 0);

  if (!fileName) return null;

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-card animate-slide-up">
      {/* File name header */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-semibold text-gray-800 truncate max-w-xs" title={fileName}>
          {fileName}
        </div>
        <span className={`text-sm font-bold ${isDone ? "text-green-600" : isError ? "text-red-600" : "text-electric-600"}`}>
          {isDone ? "Complete!" : isError ? "Failed" : `${pct}%`}
        </span>
      </div>

      {/* Progress bar */}
      <div className="progress-bar mb-4">
        <div
          className={`progress-fill ${isDone ? "!bg-green-500" : isError ? "!bg-red-500" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Stages */}
      <div className="space-y-2">
        {STAGES.map((stage) => {
          const isDoneStage  = currentStage > stage.id || (isDone && stage.id <= 4);
          const isActiveStage = currentStage === stage.id && !isDone && !isError;
          const isPending    = currentStage < stage.id && !isDone;

          return (
            <div key={stage.id} className="flex items-center gap-3">
              {/* Status icon */}
              <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                isDoneStage  ? "bg-green-100" :
                isActiveStage ? "bg-electric-100" :
                "bg-gray-100"
              }`}>
                {isDoneStage  ? <Check className="w-3 h-3 text-green-600" />          :
                 isActiveStage ? <Loader2 className="w-3 h-3 text-electric-500 animate-spin" /> :
                                 <div className="w-1.5 h-1.5 rounded-full bg-gray-300" />}
              </div>

              {/* Label */}
              <div>
                <span className={`text-xs font-medium ${
                  isDoneStage   ? "text-green-700" :
                  isActiveStage ? "text-electric-700" :
                  "text-gray-400"
                }`}>
                  Stage {stage.id}/4: {stage.label}
                </span>
                {isActiveStage && (
                  <div className="text-xs text-gray-400">{stage.detail}…</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Success animation */}
      {isDone && (
        <div className="mt-4 flex items-center justify-center gap-2 bg-green-50 rounded-xl p-3 animate-bounce-subtle">
          <Check className="w-4 h-4 text-green-600" />
          <span className="text-sm font-semibold text-green-700">Download ready — registered on blockchain!</span>
        </div>
      )}
    </div>
  );
}
