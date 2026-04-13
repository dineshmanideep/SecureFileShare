import React, { useEffect, useState } from "react";
import { User, Save, Check, Shield, Loader2, Copy } from "lucide-react";
import WalletAvatar from "../components/profile/WalletAvatar";
import { ethers } from "ethers";
import { getAccessControl, getSigner, NETWORK_CONFIG } from "../utils/blockchain";
import toast from "react-hot-toast";
import { Identity } from "@semaphore-protocol/identity";

const EMPTY_ATTR = { key: "", value: "" };
const CONFIGURED_RBAC_ADMIN_WALLET = (import.meta.env.VITE_RBAC_ADMIN_WALLET || "").trim();

function normalizeAddress(address) {
  if (!address) return "";
  try {
    return ethers.utils.getAddress(address);
  } catch {
    return "";
  }
}

function getStoredAttributes(account) {
  if (!account) return [{ ...EMPTY_ATTR }];
  try {
    const raw = localStorage.getItem(`abacAttributes_${account}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [{ ...EMPTY_ATTR }];
  } catch {
    return [{ ...EMPTY_ATTR }];
  }
}

function formatAttributes(attrs) {
  return attrs
    .map((attr) => ({ key: attr.key.trim(), value: attr.value.trim() }))
    .filter((attr) => attr.key && attr.value)
    .map((attr) => `${attr.key}:${attr.value}`);
}

function inferRoleLabelFromAttributes(attributeTags) {
  const normalized = [...(attributeTags || [])].sort().join("|");
  if (!normalized) return "No role selected";

  for (const sector of Object.values(ROLE_PRESETS)) {
    for (const role of sector.roles || []) {
      const roleSignature = (role.attrs || [])
        .map((a) => `${a.key}:${a.value}`)
        .sort()
        .join("|");
      if (roleSignature === normalized) {
        return role.label;
      }
    }
  }

  return "Custom role";
}

function inferRoleLabelFromHashedAttributes(attributeHashes) {
  const normalized = [...(attributeHashes || [])]
    .map((h) => String(h || "").toLowerCase())
    .sort()
    .join("|");

  if (!normalized) return "No role selected";

  for (const sector of Object.values(ROLE_PRESETS)) {
    for (const role of sector.roles || []) {
      const hashedSignature = (role.attrs || [])
        .map((a) => `${a.key}:${a.value}`)
        .map((tag) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(tag)).toLowerCase())
        .sort()
        .join("|");
      if (hashedSignature === normalized) {
        return role.label;
      }
    }
  }

  return "Custom role";
}

// ─── Real-world role presets ──────────────────────────────────────────────────
// Each role maps to a set of attribute key-value pairs that exactly describe it.
// These are hashed and written on-chain via setUserAttributes() so file owners
// can restrict access using definePolicy() with matching tags.
const ROLE_PRESETS = {
  healthcare: {
    label: "Healthcare",
    emoji: "🏥",
    roles: [
      { label: "Doctor – Cardiology",  attrs: [{ key: "role", value: "doctor" }, { key: "department", value: "cardiology" }] },
      { label: "Doctor – Oncology",    attrs: [{ key: "role", value: "doctor" }, { key: "department", value: "oncology" }] },
      { label: "Doctor – Neurology",   attrs: [{ key: "role", value: "doctor" }, { key: "department", value: "neurology" }] },
      { label: "Doctor – Radiology",   attrs: [{ key: "role", value: "doctor" }, { key: "department", value: "radiology" }] },
      { label: "Nurse",                attrs: [{ key: "role", value: "nurse" }] },
      { label: "Lab Technician",       attrs: [{ key: "role", value: "lab-technician" }] },
      { label: "Hospital Admin",       attrs: [{ key: "role", value: "hospital-admin" }] },
    ],
  },
  legal: {
    label: "Legal",
    emoji: "⚖️",
    roles: [
      { label: "Senior Lawyer",   attrs: [{ key: "role", value: "lawyer" }, { key: "clearance", value: "senior" }] },
      { label: "Junior Lawyer",   attrs: [{ key: "role", value: "lawyer" }, { key: "clearance", value: "junior" }] },
      { label: "Paralegal",       attrs: [{ key: "role", value: "paralegal" }] },
      { label: "Judge",           attrs: [{ key: "role", value: "judge" }] },
      { label: "Senior Auditor",  attrs: [{ key: "role", value: "auditor" }, { key: "clearance", value: "level-3" }] },
      { label: "Junior Auditor",  attrs: [{ key: "role", value: "auditor" }, { key: "clearance", value: "level-1" }] },
    ],
  },
  academic: {
    label: "Academic",
    emoji: "🎓",
    roles: [
      { label: "Professor – CS",     attrs: [{ key: "role", value: "professor" }, { key: "department", value: "cs" }] },
      { label: "Professor – Maths",  attrs: [{ key: "role", value: "professor" }, { key: "department", value: "maths" }] },
      { label: "Researcher",         attrs: [{ key: "role", value: "researcher" }] },
      { label: "PhD Student",        attrs: [{ key: "role", value: "student" }, { key: "level", value: "phd" }] },
      { label: "Undergrad Student",  attrs: [{ key: "role", value: "student" }, { key: "level", value: "undergrad" }] },
    ],
  },
  corporate: {
    label: "Corporate",
    emoji: "🏢",
    roles: [
      { label: "Executive (Level 3)",   attrs: [{ key: "role", value: "executive" }, { key: "clearance", value: "level-3" }] },
      { label: "Manager (Level 2)",     attrs: [{ key: "role", value: "manager" }, { key: "clearance", value: "level-2" }] },
      { label: "Employee (Level 1)",    attrs: [{ key: "role", value: "employee" }, { key: "clearance", value: "level-1" }] },
      { label: "HR / Payroll Manager",  attrs: [{ key: "role", value: "hr-manager" }, { key: "clearance", value: "payroll" }] },
      { label: "Senior Auditor",        attrs: [{ key: "role", value: "auditor" }, { key: "clearance", value: "level-3" }] },
    ],
  },
};

export default function Settings({ account }) {
  const normalizedConfiguredAdmin = normalizeAddress(CONFIGURED_RBAC_ADMIN_WALLET);
  const normalizedAccount = normalizeAddress(account || "");
  const accountMatchesConfiguredAdmin =
    !normalizedConfiguredAdmin ||
    (normalizedAccount && normalizedAccount.toLowerCase() === normalizedConfiguredAdmin.toLowerCase());

  const [displayName, setDisplayName] = useState(account ? (localStorage.getItem(`displayName_${account}`) || "") : "");
  const [attrs, setAttrs] = useState(() => getStoredAttributes(account));
  const [saved, setSaved] = useState(false);
  const [syncingAttributes, setSyncingAttributes] = useState(false);
  const [selectedSector, setSelectedSector] = useState("healthcare");
  const [isTrustedIssuer, setIsTrustedIssuer] = useState(false);
  const [issueTargetAddress, setIssueTargetAddress] = useState("");
  const [zkIdentityCommitment, setZkIdentityCommitment] = useState("");
  const [zkGroupDuration, setZkGroupDuration] = useState("3600");
  const [onChainRoleLabel, setOnChainRoleLabel] = useState("No role selected");
  const [onChainAttributeCount, setOnChainAttributeCount] = useState(0);
  const currentAttributeTags = formatAttributes(attrs);
  const currentRoleLabel = inferRoleLabelFromAttributes(currentAttributeTags);
  const canManageRoleIssuance = normalizedConfiguredAdmin
    ? accountMatchesConfiguredAdmin
    : isTrustedIssuer;

  useEffect(() => {
    setDisplayName(account ? (localStorage.getItem(`displayName_${account}`) || "") : "");
    setAttrs(getStoredAttributes(account));
    setIssueTargetAddress("");
   

    // Initialize (or load) Semaphore identity locally.
    if (account) {
      const storageKey = `semaphoreIdentity_${String(account).toLowerCase()}`;
      const stored = localStorage.getItem(storageKey);
      let identity;
      if (stored) {
        try {
          identity = Identity.import(stored);
        } catch {
          identity = new Identity();
          localStorage.setItem(storageKey, identity.export());
        }
      } else {
        identity = new Identity();
        localStorage.setItem(storageKey, identity.export());
      }
      setZkIdentityCommitment(identity.commitment.toString());
    } else {
      setZkIdentityCommitment("");
    }
  }, [account]);

  useEffect(() => {
    const refreshCurrentUserRole = async () => {
      if (!account) {
        setOnChainRoleLabel("No role selected");
        setOnChainAttributeCount(0);
        return;
      }
      try {
        const signer = await getSigner();
        const accessControl = await getAccessControl(signer);
        const hashes = await accessControl.getUserAttributes(account);
        const hashList = Array.isArray(hashes) ? hashes.map((h) => String(h)) : [];
        setOnChainAttributeCount(hashList.length);
        setOnChainRoleLabel(inferRoleLabelFromHashedAttributes(hashList));
      } catch {
        setOnChainRoleLabel("No role selected");
        setOnChainAttributeCount(0);
      }
    };

    refreshCurrentUserRole();
  }, [account]);

  useEffect(() => {
    const refreshIssuerStatus = async () => {
      if (!account) {
        setIsTrustedIssuer(false);
        return;
      }
      try {
        const signer = await getSigner();
        const accessControl = await getAccessControl(signer);
        const issuer = await accessControl.isTrustedIssuer(account);
        setIsTrustedIssuer(Boolean(issuer));
      } catch {
        setIsTrustedIssuer(false);
      }
    };
    refreshIssuerStatus();
  }, [account]);

  const handleSave = () => {
    if (account) {
      localStorage.setItem(`displayName_${account}`, displayName);
      localStorage.setItem(`abacAttributes_${account}`, JSON.stringify(attrs));
      setSaved(true);
      toast.success("Settings saved!");
      setTimeout(() => setSaved(false), 2500);
    }
  };

  // Apply a preset role to the attrs array and save to localStorage immediately.
  // The user still needs to click "Sync On-Chain" to write the hash to the contract.
  const applyRolePreset = (roleAttrs) => {
    setAttrs(roleAttrs);
    if (account) localStorage.setItem(`abacAttributes_${account}`, JSON.stringify(roleAttrs));
  };

  const syncAbacAttributes = async () => {
    if (!account) return;

    if (normalizedConfiguredAdmin && !accountMatchesConfiguredAdmin) {
      toast.error(`Only configured admin wallet ${normalizedConfiguredAdmin} can issue role attributes.`);
      return;
    }

    if (!isTrustedIssuer) {
      toast.error("Only trusted issuer wallets can write on-chain role attributes.");
      return;
    }

    const normalizedTarget = normalizeAddress(issueTargetAddress);
    if (!normalizedTarget) {
      toast.error("Enter a valid target wallet address for role issuance.");
      return;
    }

    const formatted = formatAttributes(attrs);
    const hashed = formatted.map((attr) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(attr)));

    setSyncingAttributes(true);
    try {
      const signer = await getSigner();
      const accessControl = await getAccessControl(signer);
      const tx = await accessControl.setUserAttributes(normalizedTarget, hashed);
      await tx.wait();
      setIssueTargetAddress(normalizedTarget);
      toast.success(
        hashed.length > 0
          ? `Role attributes issued to ${normalizedTarget.slice(0, 8)}...${normalizedTarget.slice(-6)}`
          : `Role attributes cleared for ${normalizedTarget.slice(0, 8)}...${normalizedTarget.slice(-6)}`
      );
    } catch (err) {
      toast.error(err.message || "Failed to sync ABAC attributes");
    } finally {
      setSyncingAttributes(false);
    }
  };

  const createZkGroup = async () => {
    if (!account) return;
    const duration = Number(zkGroupDuration);
    if (!Number.isInteger(duration) || duration <= 0) {
      toast.error("Enter a valid merkle tree duration in seconds (e.g. 3600).");
      return;
    }

    // Any user can create a ZK group; this just returns an id bound to the Semaphore tree.
    try {
      const signer = await getSigner();
      const accessControl = await getAccessControl(signer);
      const tx = await accessControl.createZkGroup(duration);
      const receipt = await tx.wait();
      let groupId = null;
      const ev = receipt?.events?.find?.((e) => e.event === "ZkGroupCreated");
      if (ev?.args?.groupId !== undefined) {
        groupId = ev.args.groupId.toString();
      }
      toast.success(groupId !== null ? `ZK group created: groupId=${groupId}` : "ZK group created.");
    } catch (err) {
      toast.error(err.message || "Failed to create ZK group");
    }
  };

  if (!account) return <div className="p-8 text-gray-400 text-sm">Connect your wallet to access settings.</div>;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

      <div className="card p-6 mb-6">
        <h2 className="text-base font-bold text-gray-900 mb-4 flex items-center gap-2">
          <User className="w-4 h-4 text-electric-500" /> Profile
        </h2>

        {/* Avatar */}
        <div className="flex items-center gap-4 mb-6 p-4 bg-gray-50 rounded-xl">
          <WalletAvatar address={account} size={56} />
          <div>
            <div className="font-semibold text-gray-800">{displayName || "Anonymous"}</div>
            <div className="text-xs font-mono text-gray-400 mt-0.5">{account}</div>
            <div className="text-xs text-gray-600 mt-1">Role: <span className="font-semibold">{onChainRoleLabel}</span></div>
            <div className="text-xs text-gray-500 mt-0.5 break-words">
              On-chain attributes: {onChainAttributeCount}
            </div>
            <div className="text-xs text-gray-400 mt-1">Avatar generated from your wallet address (blockies)</div>
          </div>
        </div>

        {/* Display name */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-gray-600 mb-1">Display Name</label>
          <input
            className="input-field"
            placeholder="e.g. Alice"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <p className="text-xs text-gray-400 mt-1">Stored locally in your browser only.</p>
        </div>

        {/* Wallet info */}
        <div className="mb-6">
          <label className="block text-xs font-semibold text-gray-600 mb-1">Wallet Address</label>
          <div className="input-field bg-gray-50 font-mono text-xs cursor-default select-all">
            {account}
          </div>
        </div>
      </div>

      <div className="card p-6 mb-6">
        <div className="mb-4">
          <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <Shield className="w-4 h-4 text-electric-500" /> My Role Profile
          </h2>
          <p className="text-xs text-gray-400 mt-1">
            Select your sector and role. These attributes are hashed and written on-chain so file owners can restrict access to the right people automatically — no manual entry needed.
          </p>
        </div>

        {/* Sector tabs */}
        <div className="flex gap-2 mb-4 flex-wrap">
          {Object.entries(ROLE_PRESETS).map(([key, sector]) => (
            <button
              key={key}
              onClick={() => setSelectedSector(key)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                selectedSector === key
                  ? "bg-electric-500 border-electric-500 text-white"
                  : "border-gray-200 text-gray-600 hover:border-electric-300"
              }`}
            >
              {sector.emoji} {sector.label}
            </button>
          ))}
        </div>

        {/* Role buttons for the selected sector */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          {ROLE_PRESETS[selectedSector].roles.map((role) => {
            const activeTag = role.attrs.map(a => `${a.key}:${a.value}`).join(",");
            const currentTag = formatAttributes(attrs).join(",");
            const isActive = activeTag === currentTag;
            return (
              <button
                key={role.label}
                onClick={() => applyRolePreset(role.attrs)}
                className={`flex items-start gap-2 px-3 py-2.5 rounded-xl border text-left transition-all ${
                  isActive
                    ? "bg-electric-50 border-electric-400"
                    : "border-gray-200 text-gray-700 hover:border-electric-300 hover:bg-gray-50"
                }`}
              >
                <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex-shrink-0 ${
                  isActive ? "border-electric-500 bg-electric-500" : "border-gray-300"
                }`} />
                <div>
                  <div className="text-xs font-semibold text-gray-800">{role.label}</div>
                  <div className="text-[10px] text-gray-400 font-mono mt-0.5">
                    {role.attrs.map(a => `${a.key}:${a.value}`).join(" · ")}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Show resulting attribute strings that will be hashed on-chain */}
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 mb-4">
          <div className="text-xs font-semibold text-gray-700 mb-1">Active attribute strings (will be keccak256-hashed on-chain)</div>
          <div className="text-xs text-gray-500 break-words font-mono">
            {formatAttributes(attrs).length > 0 ? formatAttributes(attrs).join(", ") : "No role selected — click a role above."}
          </div>
        </div>

        {canManageRoleIssuance ? (
          <>
            <div className="rounded-xl border border-gray-200 bg-white p-4 mb-4">
              {normalizedConfiguredAdmin && (
                <div className="text-xs text-gray-500 mb-3">
                  Configured RBAC admin wallet: <span className="font-mono">{normalizedConfiguredAdmin}</span>
                </div>
              )}
              <div className="text-xs font-semibold text-gray-700 mb-1">Role Issuance Target Wallet</div>
              <input
                className="input-field font-mono text-xs"
                value={issueTargetAddress}
                onChange={(e) => setIssueTargetAddress(e.target.value)}
                placeholder="0x..."
              />
              <div className="text-xs mt-2 text-gray-500">
                Enter the recipient wallet address explicitly. Roles are issued to this target wallet, not automatically to the connected admin wallet.
              </div>
            </div>

            <button onClick={syncAbacAttributes} disabled={syncingAttributes || !isTrustedIssuer} className="btn-primary inline-flex items-center gap-2">
              {syncingAttributes
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Syncing...</>
                : <><Shield className="w-4 h-4" /> Issue On-Chain Role Attributes</>}
            </button>
          </>
        ) : (
          <div className="text-xs text-gray-500">
            Role issuance controls are visible only to the admin wallet.
          </div>
        )}
      </div>

      <div className="card p-6 mb-6">
        <div className="mb-4">
          <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <Shield className="w-4 h-4 text-electric-500" /> Zero-Knowledge Identity
          </h2>
          <p className="text-xs text-gray-400 mt-1">
            Your Semaphore identity is stored locally in this browser. Trusted issuers can add your identity commitment to role groups to enable ZK access proofs.
          </p>
        </div>

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 mb-4">
          <div className="text-xs font-semibold text-gray-700 mb-1">Identity commitment</div>
          <div className="flex items-start gap-2">
            <div className="flex-1 text-xs font-mono text-gray-600 break-words select-all">
              {zkIdentityCommitment || "—"}
            </div>
            {zkIdentityCommitment && (
              <button
                type="button"
                className="btn-icon border border-gray-200 rounded-lg p-1 hover:bg-gray-50"
                onClick={() => {
                  navigator.clipboard.writeText(zkIdentityCommitment);
                  toast.success("Identity commitment copied");
                }}
              >
                <Copy className="w-3.5 h-3.5 text-gray-500" />
              </button>
            )}
          </div>
          <div className="text-[10px] text-gray-400 mt-1">
            Share this commitment with a trusted issuer so they can add you to a ZK group.
          </div>
        </div>
      </div>

      <div className="card p-6 mb-6">
        <div className="mb-4">
          <div>
            <h2 className="text-base font-bold text-gray-900">Sharing Model</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              SecureShare supports direct wallet-to-wallet sharing and multi-user group sharing.
              ABAC policies can now be layered on top so access can require both the right key path and the right attribute set.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="text-sm font-semibold text-gray-800 mb-1">Direct Share</div>
            <p className="text-xs text-gray-500">
              Share a file with one wallet address and apply an expiry window. Role attributes are issuer-managed and validated against the file policy.
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="text-sm font-semibold text-gray-800 mb-1">Group Share</div>
            <p className="text-xs text-gray-500">
              Create a named group, add multiple member wallets, and combine group key access with an optional ABAC file policy.
            </p>
          </div>
        </div>
      </div>

      {/* Network info */}
      <div className="card p-6 mb-6">
        <h2 className="text-base font-bold text-gray-900 mb-4">Network</h2>
        <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl">
          <div className="w-3 h-3 rounded-full bg-green-400 animate-pulse" />
          <div>
            {/* <div className="text-sm font-semibold text-gray-800">{NETWORK_CONFIG.chainName}</div> */}
            <div className="text-xs text-gray-400 font-mono">Chain ID: {NETWORK_CONFIG.chainId} · {NETWORK_CONFIG.rpcUrl}</div>
          </div>
        </div>
      </div>

      <button onClick={handleSave} className="btn-primary flex items-center gap-2">
        {saved ? <><Check className="w-4 h-4" /> Saved!</> : <><Save className="w-4 h-4" /> Save Settings</>}
      </button>
    </div>
  );
}
