import React, { useState, useEffect } from "react";
import {
  Shield, Download, Trash2, ToggleLeft, ToggleRight,
  FileText, Users, FolderOpen, Database, Loader2
} from "lucide-react";
import { getSigner, getFileRegistry, getGDPRCompliance, signAuthMessage, safeGetOwnerFileIds } from "../../utils/blockchain";
import toast from "react-hot-toast";

function Section({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="card p-6 mb-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 bg-electric-50 rounded-xl flex items-center justify-center flex-shrink-0">
          <Icon className="w-5 h-5 text-electric-500" />
        </div>
        <div>
          <h3 className="font-bold text-gray-900">{title}</h3>
          {subtitle && <p className="text-sm text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

export default function GDPRCenter({ account }) {
  const [files, setFiles] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [erasingId, setErasingId] = useState(null);
  const [consents, setConsents] = useState({
    accessLogging: true,
    analytics: false,
  });

  useEffect(() => {
    if (account) { loadFiles(); loadAuditLogs(); }
  }, [account]);

  const loadFiles = async () => {
    try {
      setIsLoading(true);
      const signer = await getSigner();
      const registry = await getFileRegistry(signer);
      const ids = await safeGetOwnerFileIds(registry, account);
      const results = await Promise.all(ids.map(async (idBN) => {
        const id = Number(idBN);
        const d = await registry.getFile(id);
        return { id, fileName: d.fileName, cids: d.cids, isDeleted: d.isDeleted, fileSize: d.fileSize.toNumber() };
      }));
      setFiles(results.filter(f => !f.isDeleted));
    } catch (err) {
      toast.error("Failed to load files: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const loadAuditLogs = async () => {
    try {
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);
      const res = await fetch(`/api/gdpr/audit`, {
        headers: {
          "x-user-address": auth.address,
          "x-signature": auth.signature,
          "x-message": auth.message,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load audit logs");
      if (data.success) setAuditLogs(data.logs || []);
    } catch { /* silent */ }
  };

  const handleExport = async () => {
    try {
      setIsExporting(true);
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);
      const res = await fetch(`/api/gdpr/export`, {
        headers: {
          "x-user-address": auth.address,
          "x-signature": auth.signature,
          "x-message": auth.message,
        },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `gdpr_export_${account.slice(0, 8)}.json`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast.success("Data exported successfully!");
    } catch (err) {
      toast.error("Export failed: " + err.message);
    } finally {
      setIsExporting(false);
    }
  };

  const handleErase = async (file) => {
    if (!window.confirm(`Permanently erase "${file.fileName}"? This will unpin from IPFS and mark deleted on blockchain.`)) return;
    try {
      setErasingId(file.id);
      const signer = await getSigner();
      const gdprContract = await getGDPRCompliance(signer);
      const registry = await getFileRegistry(signer);

      try { await (await gdprContract.registerFile(file.id)).wait(); } catch { /* already registered */ }

      const t1 = toast.loading("Logging erasure on-chain…");
      await (await gdprContract.requestErasure(file.id)).wait();
      toast.loading("Unpinning from IPFS…", { id: t1 });
      const eraseAuth = await signAuthMessage(signer);
      const res = await fetch("/api/gdpr/erase", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-address": eraseAuth.address,
          "x-signature": eraseAuth.signature,
          "x-message": eraseAuth.message,
        },
        body: JSON.stringify({ fileId: file.id, cids: file.cids }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      toast.loading("Fulfilling on-chain…", { id: t1 });
      await (await gdprContract.fulfillErasure(file.id)).wait();
      await (await registry.deleteFile(file.id)).wait();
      toast.success("File permanently erased!", { id: t1 });
      loadFiles(); loadAuditLogs();
    } catch (err) {
      toast.error("Erasure failed: " + err.message);
    } finally {
      setErasingId(null);
    }
  };

  const exportAsCsv = () => {
    const header = "Date,Action,File ID,IP\n";
    const rows = auditLogs.map(l =>
      `"${new Date(l.accessTimestamp).toLocaleString()}","${l.action}","${l.fileId}","${l.isAnonymised ? "Anonymised" : l.ipAddress || "—"}"`
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "audit_log.csv";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  if (!account) return <div className="p-8 text-gray-400 text-sm">Connect your wallet to view GDPR Center.</div>;

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">GDPR Center</h1>
        <p className="text-sm text-gray-400 mt-1">Your data rights, in full compliance with GDPR.</p>
      </div>

      {/* A. Overview */}
      <Section icon={Database} title="My Data Overview" subtitle="Summary of data associated with your wallet">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { icon: FolderOpen, label: "My Files",        value: isLoading ? "…" : files.length },
            { icon: Users,      label: "Audit Events",    value: auditLogs.length },
            { icon: Shield,     label: "GDPR Status",     value: "Active" },
            { icon: Database,   label: "Storage",         value: files.length > 0 ? `${files.length} files` : "0 files" },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="bg-gray-50 rounded-xl p-4 text-center">
              <Icon className="w-5 h-5 text-electric-400 mx-auto mb-1" />
              <div className="text-xl font-bold text-gray-900">{value}</div>
              <div className="text-xs text-gray-400">{label}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* B. Article 20 — Export */}
      <Section icon={Download} title="Download Your Data" subtitle="Article 20 — Right to Data Portability">
        <p className="text-sm text-gray-600 mb-4">
          Export all your data as JSON — includes file metadata, access logs, consent records and transaction hashes.
        </p>
        <div className="flex flex-wrap gap-2 text-xs text-gray-400 mb-4">
          {["File metadata", "Access audit logs", "Consent records", "Transaction hashes"].map(item => (
            <span key={item} className="badge badge-gray">{item}</span>
          ))}
        </div>
        <button onClick={handleExport} disabled={isExporting} className="btn-primary flex items-center gap-2">
          {isExporting ? <><Loader2 className="w-4 h-4 animate-spin" /> Exporting…</> : <><Download className="w-4 h-4" /> Export as JSON</>}
        </button>
      </Section>

      {/* C. Article 17 — Erasure */}
      <Section icon={Trash2} title="Right to Erasure" subtitle="Article 17 — Request deletion of your data">
        <div className="bg-amber-50 rounded-xl px-4 py-3 mb-4 text-xs text-amber-700">
          <p className="font-semibold mb-1">What gets deleted:</p>
          <ul className="space-y-0.5">
            <li>✓ File unpinned from IPFS network</li>
            <li>✓ Database records anonymized</li>
            <li>✓ Blockchain record marked deleted</li>
            <li className="text-amber-500">✗ Blockchain transaction history (immutable by design)</li>
          </ul>
        </div>
        {isLoading ? (
          <div className="text-sm text-gray-400 animate-pulse">Loading files…</div>
        ) : files.length === 0 ? (
          <div className="text-sm text-gray-400">No active files to erase.</div>
        ) : (
          <div className="divide-y divide-gray-50 rounded-xl border border-gray-100 overflow-hidden">
            {files.map((file) => (
              <div key={file.id} className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-800 truncate">{file.fileName}</div>
                  <div className="text-xs text-gray-400">ID: {file.id} · {file.cids.length} chunks</div>
                </div>
                <button
                  onClick={() => handleErase(file)}
                  disabled={erasingId === file.id}
                  className="btn-danger text-xs px-3 py-1.5 flex items-center gap-1 flex-shrink-0 ml-3"
                >
                  {erasingId === file.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                  Erase
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* D. Consent */}
      <Section icon={ToggleLeft} title="Consent Management" subtitle="Control how your data is used">
        <div className="space-y-3">
          {[
            { key: "accessLogging", label: "Allow access logging", desc: "Required for audit trail and GDPR compliance" },
            { key: "analytics",     label: "Allow analytics",       desc: "Anonymous usage statistics" },
          ].map(({ key, label, desc }) => (
            <div key={key} className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
              <div>
                <div className="text-sm font-medium text-gray-800">{label}</div>
                <div className="text-xs text-gray-400 mt-0.5">{desc}</div>
              </div>
              <button
                onClick={() => setConsents(c => ({ ...c, [key]: !c[key] }))}
                className={`w-11 h-6 rounded-full transition-colors ${consents[key] ? "bg-electric-500" : "bg-gray-300"}`}
                style={{ position: "relative" }}
              >
                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${consents[key] ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
            </div>
          ))}
        </div>
      </Section>

      {/* E. Audit Log */}
      <Section icon={FileText} title="Access Audit Log" subtitle="Full history of actions on your data">
        <div className="flex justify-end mb-3">
          <button onClick={exportAsCsv} className="btn-secondary text-xs flex items-center gap-1">
            <Download className="w-3 h-3" /> Export CSV
          </button>
        </div>
        {auditLogs.length === 0 ? (
          <div className="text-sm text-gray-400">No audit logs yet.</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-100">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-gray-400 text-left">
                  {["Date", "Action", "File", "IP"].map(h => (
                    <th key={h} className="px-4 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {auditLogs.map((log) => (
                  <tr key={log.logId} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2.5 text-gray-500">{new Date(log.accessTimestamp).toLocaleDateString()}</td>
                    <td className="px-4 py-2.5">
                      <span className={`badge ${
                        log.action.includes("ERASE") ? "badge-red" :
                        log.action.includes("SHARE") ? "badge-purple" :
                        "badge-blue"
                      }`}>{log.action}</span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{log.fileId}</td>
                    <td className="px-4 py-2.5 text-gray-400 font-mono">{log.isAnonymised ? "Anon" : log.ipAddress || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
