import React from "react";
import { Check, Loader2, X } from "lucide-react";

const STEPS = [
  "Verifying ZKP proof on-chain",
  "Checking direct/group permissions",
  "Checking time permissions",
  "Unwrapping key (ECDH)",
  "Fetching from IPFS",
  "Decrypting file (AES-256)",
];

export default function AccessVerification({ isOpen, steps, error, isDone, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={isDone && !error ? onClose : undefined}>
      <div className="modal-box max-w-sm animate-slide-up">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-gray-900">Verifying Access</h3>
            {(isDone || error) && (
              <button onClick={onClose} className="btn-icon"><X className="w-4 h-4" /></button>
            )}
          </div>

          <div className="space-y-3">
            {STEPS.map((label, i) => {
              const stepN = i + 1;
              const isDoneStep = steps >= stepN || isDone;
              const isActive = steps === i && !isDone && !error;
              const isErrorStep = error && steps === i;

              return (
                <div key={label} className="flex items-center gap-3">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs ${
                    isErrorStep ? "bg-red-100" :
                    isDoneStep  ? "bg-green-100" :
                    isActive    ? "bg-electric-100" : "bg-gray-100"
                  }`}>
                    {isErrorStep  ? <X className="w-3 h-3 text-red-500" />            :
                     isDoneStep   ? <Check className="w-3 h-3 text-green-600" />       :
                     isActive     ? <Loader2 className="w-3 h-3 text-electric-500 animate-spin" /> :
                                    <span className="text-gray-400">{stepN}</span>}
                  </div>
                  <span className={`text-sm ${
                    isErrorStep ? "text-red-600" :
                    isDoneStep  ? "text-green-700 font-medium" :
                    isActive    ? "text-electric-700 font-medium" :
                    "text-gray-400"
                  }`}>
                    Step {stepN}: {label}… {isDoneStep ? "✓" : ""}
                  </span>
                </div>
              );
            })}
          </div>

          {isDone && !error && (
            <div className="mt-4 bg-green-50 rounded-xl p-3 text-center text-sm font-semibold text-green-700 animate-bounce-subtle">
              Download ready!
            </div>
          )}
          {error && (
            <div className="mt-4 bg-red-50 rounded-xl p-3 text-xs text-red-600">{error}</div>
          )}
        </div>
      </div>
    </div>
  );
}
