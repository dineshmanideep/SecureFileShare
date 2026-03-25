import React, { useState } from "react";
import { Lock, User, Zap, CheckCircle2, ChevronRight, ChevronLeft, X } from "lucide-react";

const STEPS = [
  {
    icon: Lock,
    title: "Welcome to SecureShare",
    subtitle: "Your files. Encrypted. Always.",
    body: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>
          Every file you upload is encrypted with <strong>AES-256-GCM</strong> before it ever
          leaves your browser. Keys are protected with <strong>ECDH (Elliptic Curve
          Diffie-Hellman)</strong> so only your wallet can decrypt them.
        </p>
        <div className="grid grid-cols-2 gap-2 mt-4">
          {[
            { t: "AES-256-GCM",    s: "Military-grade encryption" },
            { t: "ECDH Keys",      s: "Wallet-bound key wrapping" },
            { t: "IPFS Storage",   s: "Decentralized & permanent" },
            { t: "ZKP Integrity",  s: "Zero-knowledge proof chain" },
          ].map(({ t, s }) => (
            <div key={t} className="bg-electric-50 rounded-xl p-3">
              <div className="text-xs font-semibold text-electric-700">{t}</div>
              <div className="text-xs text-electric-500 mt-0.5">{s}</div>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    icon: User,
    title: "Set Your Identity",
    subtitle: "Your display name and sharing model",
    body: ({ name, setName, account }) => {
      return (
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Display Name</label>
            <input
              className="input-field"
              placeholder="e.g. Alice"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="text-sm font-semibold text-gray-800 mb-2">How sharing works now</div>
            <div className="space-y-2 text-xs text-gray-500">
              <p>
                Direct shares grant a single wallet access with optional time-bound expiry.
              </p>
              <p>
                Group shares let you create a named team, add multiple wallet addresses, and reuse one group key version across all active members.
              </p>
            </div>
          </div>
        </div>
      );
    },
  },
  {
    icon: Zap,
    title: "You're All Set!",
    subtitle: "Start using SecureShare",
    body: (
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          Your blockchain-secured file sharing is ready. Here's what you can do:
        </p>
        {[
          { t: "Upload your first file",  s: "Drag & drop, encrypted instantly"      },
          { t: "Share with anyone",       s: "Set expiry, ECDH-wrapped keys"          },
          { t: "Manage your GDPR rights", s: "Export, erase, consent controls"       },
        ].map(({ t, s }) => (
          <div key={t} className="flex items-center gap-3 bg-gray-50 rounded-xl p-3">
            <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
            <div>
              <div className="text-sm font-semibold text-gray-800">{t}</div>
              <div className="text-xs text-gray-400">{s}</div>
            </div>
          </div>
        ))}
      </div>
    ),
  },
];

export default function WelcomeModal({ account }) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(true);
  const [name, setName] = useState("");

  if (!visible) return null;

  const handleFinish = () => {
    if (name) localStorage.setItem(`displayName_${account}`, name);
    localStorage.setItem(`onboarded_${account}`, "1");
    setVisible(false);
  };

  const S = STEPS[step];
  const Icon = S.icon;

  return (
    <div className="modal-backdrop z-[60]">
      <div className="modal-box animate-slide-up">
        {/* Header */}
        <div className="relative p-6 pb-4 bg-gradient-to-br from-navy-500 to-electric-500 rounded-t-2xl text-white">
          <button
            onClick={handleFinish}
            className="absolute top-4 right-4 text-white/60 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center mb-3">
            <Icon className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-xl font-bold">{S.title}</h2>
          <p className="text-sm text-white/70 mt-1">{S.subtitle}</p>
        </div>

        {/* Step dots */}
        <div className="flex items-center justify-center gap-2 py-3 border-b border-gray-100">
          {STEPS.map((_, i) => (
            <div key={i} className={`w-2 h-2 rounded-full transition-all ${i === step ? "bg-electric-500 w-6" : i < step ? "bg-green-400" : "bg-gray-200"}`} />
          ))}
        </div>

        {/* Body */}
        <div className="p-6">
          {typeof S.body === "function"
            ? S.body({ name, setName, account })
            : S.body
          }
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-gray-100">
          <button
            onClick={() => step > 0 ? setStep(s => s - 1) : null}
            className={`btn-secondary flex items-center gap-2 ${step === 0 ? "invisible" : ""}`}
          >
            <ChevronLeft className="w-4 h-4" /> Back
          </button>

          {step < STEPS.length - 1 ? (
            <button onClick={() => setStep(s => s + 1)} className="btn-primary flex items-center gap-2">
              Next <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={handleFinish} className="btn-primary flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Get Started!
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
