import React, { useState, useEffect } from "react";
import { FolderOpen, Share2, Shield, Upload, ArrowRight, TrendingUp } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getSigner, getFileRegistry, safeGetOwnerFileIds } from "../utils/blockchain";

export default function Dashboard({ account }) {
  const navigate = useNavigate();
  const [stats, setStats] = useState({ myFiles: 0, loading: true });
  const displayName = account ? (localStorage.getItem(`displayName_${account}`) || "there") : "there";

  useEffect(() => {
    if (account) loadStats();
  }, [account]);

  const loadStats = async () => {
    try {
      const signer = await getSigner();
      const registry = await getFileRegistry(signer);
      const ids = await safeGetOwnerFileIds(registry, account);
      const metaArr = await Promise.all(
        ids.map((id) => registry.getFile(Number(id)).catch(() => null))
      );
      const activeCount = metaArr.filter((f) => f && !f.isDeleted).length;
      setStats({ myFiles: activeCount, loading: false });
    } catch {
      setStats({ myFiles: 0, loading: false });
    }
  };

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <div className="w-16 h-16 bg-electric-50 rounded-2xl flex items-center justify-center mb-4">
          <Shield className="w-8 h-8 text-electric-400" />
        </div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Secure File Sharing</h2>
        <p className="text-gray-400 text-sm max-w-md">
          Connect your MetaMask wallet to access your encrypted files powered by blockchain, IPFS and ZKP.
        </p>
      </div>
    );
  }

  const quickActions = [
    { icon: Upload,    label: "Upload Files",    desc: "Encrypt and store securely",   to: "/my-files",   color: "bg-electric-500" },
    { icon: Share2,    label: "Shared With Me",  desc: "Files from other wallets",     to: "/shared",     color: "bg-purple-500" },
    { icon: Shield,    label: "GDPR Center",     desc: "Manage your data rights",      to: "/gdpr",       color: "bg-green-500" },
  ];

  const techBadges = [
    { label: "AES-256-GCM",        desc: "File encryption" },
    { label: "ECDH Key Wrapping",  desc: "Key protection" },
    { label: "IPFS / Pinata",      desc: "Decentralized storage" },
    { label: "ZKP Integrity",      desc: "Zero-knowledge proofs" },
    { label: "Group Key Management", desc: "Versioned multi-user key sharing" },
    { label: "GDPR Compliant",     desc: "Your data rights" },
  ];

  return (
    <div className="max-w-4xl">
      {/* Welcome */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Good afternoon, {displayName}! 👋</h1>
        <p className="text-sm text-gray-400 mt-1">
          Your files are end-to-end encrypted and secured on the blockchain.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {[
          { icon: FolderOpen, label: "My Files",     value: stats.loading ? "…" : stats.myFiles, color: "bg-electric-50 text-electric-600" },
          { icon: TrendingUp, label: "Encryption",   value: "AES-256",              color: "bg-green-50 text-green-600" },
          { icon: Shield,     label: "ZKP Status",   value: "Active ✓",             color: "bg-purple-50 text-purple-600" },
        ].map(({ icon: Icon, label, value, color }) => (
          <div key={label} className="card p-5">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${color}`}>
              <Icon className="w-5 h-5" />
            </div>
            <div className="text-2xl font-bold text-gray-900">{value}</div>
            <div className="text-sm text-gray-400 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <h2 className="text-base font-bold text-gray-900 mb-3">Quick Actions</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {quickActions.map(({ icon: Icon, label, desc, to, color }) => (
          <button
            key={label}
            onClick={() => navigate(to)}
            className="card p-5 text-left group hover:shadow-card-hover transition-all duration-200"
          >
            <div className={`w-10 h-10 ${color} rounded-xl flex items-center justify-center mb-3`}>
              <Icon className="w-5 h-5 text-white" />
            </div>
            <div className="font-semibold text-gray-900 text-sm">{label}</div>
            <div className="text-xs text-gray-400 mt-0.5">{desc}</div>
            <div className="mt-3 flex items-center gap-1 text-electric-500 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity">
              Go <ArrowRight className="w-3 h-3" />
            </div>
          </button>
        ))}
      </div>

      {/* Tech stack */}
      <h2 className="text-base font-bold text-gray-900 mb-3">Security Guarantees</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {techBadges.map(({ label, desc }) => (
          <div key={label} className="bg-gray-50 rounded-xl p-4 border border-gray-100">
            <div className="text-sm font-semibold text-gray-800">{label}</div>
            <div className="text-xs text-gray-400 mt-0.5">{desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
