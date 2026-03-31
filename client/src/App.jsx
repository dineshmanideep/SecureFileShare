import React, { useState, useCallback, useEffect } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { getProvider } from "./utils/blockchain";

import Layout from "./components/layout/Layout";
import Dashboard from "./pages/Dashboard";
import MyFiles from "./pages/MyFiles";
import ZkPublicFiles from "./pages/ZkPublicFiles";
import SharedWithMe from "./pages/SharedWithMe";
import GDPRCenterPage from "./pages/GDPRCenter";
import Settings from "./pages/Settings";
import Groups from "./pages/Groups";

// Connect wallet landing page (shown when not connected)
function LandingPage({ onConnect }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: "linear-gradient(135deg, #1a1f36 0%, #0f1322 100%)" }}
    >
      {/* Logo */}
      <div className="text-center mb-10">
        <div className="w-20 h-20 bg-electric-500 rounded-3xl flex items-center justify-center mx-auto mb-5 shadow-electric">
          <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h1 className="text-4xl font-bold text-white mb-2">SecureShare</h1>
        <p className="text-base text-slate-400 max-w-md">
          Blockchain-secured file sharing with AES-256-GCM encryption, ECDH key wrapping,
          IPFS storage, and ZKP integrity verification.
        </p>
      </div>

      {/* Feature grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10 max-w-lg w-full">
        {[
          { emoji: "🔐", label: "AES-256-GCM",    sub: "File encryption" },
          { emoji: "🔑", label: "ECDH Keys",       sub: "Key wrapping"    },
          { emoji: "📦", label: "IPFS",            sub: "Decentralized"   },
          { emoji: "✅", label: "ZKP Proofs",      sub: "Integrity"       },
        ].map(({ emoji, label, sub }) => (
          <div key={label} className="bg-white/5 border border-white/10 rounded-2xl p-4 text-center">
            <div className="text-2xl mb-1">{emoji}</div>
            <div className="text-sm font-semibold text-white">{label}</div>
            <div className="text-xs text-slate-400">{sub}</div>
          </div>
        ))}
      </div>

      <button
        onClick={onConnect}
        className="bg-electric-500 hover:bg-electric-600 text-white font-bold px-8 py-4 rounded-2xl text-base shadow-electric transition-all duration-200 active:scale-95 flex items-center gap-3"
      >
        <svg className="w-5 h-5" viewBox="0 0 35 33" fill="currentColor">
          <path d="M32.9582 1L19.8241 10.7183L22.2665 5.0636L32.9582 1Z" fill="white" opacity="0.9" />
          <path d="M2.04858 1L15.0719 10.8067L12.7421 5.0636L2.04858 1Z" fill="white" opacity="0.5" />
          <path d="M28.2292 23.5334L24.5972 29.0179L32.1702 31.0895L34.3307 23.6513L28.2292 23.5334Z" fill="white" opacity="0.8" />
          <path d="M0.68457 23.6513L2.83071 31.0895L10.3908 29.0179L6.77318 23.5334L0.68457 23.6513Z" fill="white" opacity="0.8" />
        </svg>
        Connect MetaMask
      </button>

      <p className="text-xs text-slate-500 mt-4">
        Connects to Hardhat Local network (Chain ID: 1337)
      </p>
    </div>
  );
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    // Check if already connected
    if (window.ethereum) {
      window.ethereum.request({ method: "eth_accounts" }).then((accounts) => {
        if (accounts.length > 0) setAccount(accounts[0]);
      });
      window.ethereum.on("accountsChanged", (accounts) => {
        if (accounts.length > 0) {
          setAccount(accounts[0]);
        } else {
          setAccount(null);
          navigate("/");
        }
      });
    }
  }, [navigate]);

  const connectWallet = useCallback(async () => {  //usecallback means
    try {
      const provider = await getProvider();
      const signer = provider.getSigner();
      const addr = await signer.getAddress();
      setAccount(addr);
      navigate("/dashboard");
    } catch (err) {
      console.error("Failed to connect wallet:", err);
    }
  }, [navigate]);

  const disconnectWallet = useCallback(async () => {
    try {
      if (window.ethereum?.request) {
        await window.ethereum.request({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        });
      }
    } catch { /* revokePermissions may not be supported by all wallets */ }
    setAccount(null);
    navigate("/");
  }, [navigate]);

  // Pass account and search to all page components
  const pageProps = { account, searchQuery };

  return (
    <>
      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: "#fff",
            color: "#111827",
            borderRadius: "12px",
            border: "1px solid #f3f4f6",
            boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
            fontSize: "15px",
            fontWeight: "500",
          },
          success: { iconTheme: { primary: "#22c55e", secondary: "#fff" } },
          error:   { iconTheme: { primary: "#ef4444", secondary: "#fff" } },
        }}
      />

      <Routes>
        {/* Landing / connect */}
        <Route
          path="/"
          element={
            account
              ? <Navigate to="/dashboard" replace />
              : <LandingPage onConnect={connectWallet} />
          }
        />

        {/* Authenticated routes — wrapped in Layout */}
        <Route
          path="/dashboard"
          element={
            account ? (
              <Layout account={account} onDisconnect={disconnectWallet} searchQuery={searchQuery} onSearch={setSearchQuery}>
                <Dashboard {...pageProps} />
              </Layout>
            ) : <Navigate to="/" replace />
          }
        />
        <Route
          path="/my-files"
          element={
            account ? (
              <Layout account={account} onDisconnect={disconnectWallet} searchQuery={searchQuery} onSearch={setSearchQuery}>
                <MyFiles {...pageProps} />
              </Layout>
            ) : <Navigate to="/" replace />
          }
        />
        <Route
          path="/zk-files"
          element={
            account ? (
              <Layout account={account} onDisconnect={disconnectWallet} searchQuery={searchQuery} onSearch={setSearchQuery}>
                <ZkPublicFiles {...pageProps} />
              </Layout>
            ) : <Navigate to="/" replace />
          }
        />
        <Route
          path="/shared"
          element={
            account ? (
              <Layout account={account} onDisconnect={disconnectWallet} searchQuery={searchQuery} onSearch={setSearchQuery}>
                <SharedWithMe {...pageProps} />
              </Layout>
            ) : <Navigate to="/" replace />
          }
        />
        <Route
          path="/gdpr"
          element={
            account ? (
              <Layout account={account} onDisconnect={disconnectWallet} searchQuery={searchQuery} onSearch={setSearchQuery}>
                <GDPRCenterPage {...pageProps} />
              </Layout>
            ) : <Navigate to="/" replace />
          }
        />
        <Route
          path="/groups"
          element={
            account ? (
              <Layout account={account} onDisconnect={disconnectWallet} searchQuery={searchQuery} onSearch={setSearchQuery}>
                <Groups {...pageProps} />
              </Layout>
            ) : <Navigate to="/" replace />
          }
        />
        <Route
          path="/settings"
          element={
            account ? (
              <Layout account={account} onDisconnect={disconnectWallet} searchQuery={searchQuery} onSearch={setSearchQuery}>
                <Settings {...pageProps} />
              </Layout>
            ) : <Navigate to="/" replace />
          }
        />

        {/* Legacy redirects */}
        <Route path="/dashboard-old" element={<Navigate to="/my-files" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
