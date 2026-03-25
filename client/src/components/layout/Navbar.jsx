import React, { useState, useRef, useEffect } from "react";
import { Search, Bell, ChevronDown, Copy, Check, LogOut, Settings, FolderOpen } from "lucide-react";
import { useNavigate } from "react-router-dom";
import WalletAvatar from "../profile/WalletAvatar";
import NotificationBell from "../notifications/NotificationBell";

export default function Navbar({ account, onDisconnect, searchQuery, onSearch }) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropRef = useRef(null);
  const navigate = useNavigate();
  const displayName = account ? (localStorage.getItem(`displayName_${account}`) || "Anonymous") : "";

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setProfileOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleCopy = () => {
    if (!account) return;
    navigator.clipboard.writeText(account);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shortAddr = account ? `${account.slice(0, 6)}...${account.slice(-4)}` : "";

  return (
    <header className="topbar">
      {/* Search */}
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          className="input-search"
          placeholder="Search files…"
          value={searchQuery || ""}
          onChange={(e) => onSearch && onSearch(e.target.value)}
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* Notifications */}
        <NotificationBell account={account} />

        {/* Profile */}
        {account && (
          <div className="relative" ref={dropRef}>
            <button
              onClick={() => setProfileOpen(!profileOpen)}
              className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-xl hover:bg-gray-100 transition-colors"
            >
              <WalletAvatar address={account} size={32} />
              <div className="text-left hidden sm:block">
                <div className="text-sm font-semibold text-gray-800 leading-tight">{displayName}</div>
                <div className="text-xs text-gray-400 font-mono leading-tight">{shortAddr}</div>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
            </button>

            {profileOpen && (
              <div className="absolute right-0 top-full mt-2 w-64 bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden animate-fade-in">
                {/* Header */}
                <div className="p-4 border-b border-gray-50 flex items-center gap-3">
                  <WalletAvatar address={account} size={40} />
                  <div>
                    <div className="font-semibold text-gray-800 text-sm">{displayName}</div>
                    <button
                      onClick={handleCopy}
                      className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 font-mono mt-0.5"
                    >
                      {shortAddr}
                      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                    </button>
                    <div className="flex items-center gap-1 mt-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400"></span>
                      <span className="text-xs text-gray-400">Hardhat Local</span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="p-2">
                  <button
                    onClick={() => { navigate("/my-files"); setProfileOpen(false); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 text-gray-400" />
                    My Files
                  </button>
                  <button
                    onClick={() => { navigate("/settings"); setProfileOpen(false); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <Settings className="w-4 h-4 text-gray-400" />
                    Settings
                  </button>
                  <hr className="my-2 border-gray-100" />
                  <button
                    onClick={() => { onDisconnect?.(); setProfileOpen(false); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-red-500 hover:bg-red-50 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    Disconnect Wallet
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
