import React, { useEffect, useMemo, useState } from "react";
import {
  X, User, Clock, ChevronRight, ChevronLeft, Check, Loader2, Key, Users, Plus
} from "lucide-react";
import { ethers } from "ethers";
import {
  getSigner, getAccessControl, getTimeBoundPermissions, signAuthMessage
} from "../../utils/blockchain";
import toast from "react-hot-toast";

const EMPTY_ATTR = { key: "", value: "" };

const EXPIRY_PRESETS = [
  { label: "1 Hour", seconds: 3600 },
  { label: "24 Hours", seconds: 86400 },
  { label: "7 Days", seconds: 604800 },
  { label: "30 Days", seconds: 2592000 },
];

const SHARE_MODELS = [
  {
    id: "direct-basic",
    label: "Individual",
    shortLabel: "Direct Wallet",
    description: "Direct wallet share without role policy",
    mode: "direct",
    requiresPolicy: false,
  },
  {
    id: "direct-role",
    label: "Role-Based",
    shortLabel: "ABAC Policy",
    description: "Share by role/department policy (no specific recipient wallet)",
    mode: "direct",
    requiresPolicy: true,
  },
  {
    id: "group-open",
    label: "Group (No ABAC)",
    shortLabel: "Group",
    description: "Group share for active members without role policy",
    mode: "group",
    requiresPolicy: false,
  },
  {
    id: "group-role",
    label: "Group + Role-Based",
    shortLabel: "Group + ABAC",
    description: "Group share where members must also match required role policy",
    mode: "group",
    requiresPolicy: true,
  },
];

// ─── Real-world access policy templates ──────────────────────────────────────────
// Each template defines attribute tags written to the FILE policy (definePolicy).
// Any user with matching on-chain attributes will be eligible for role-based access.
const POLICY_TEMPLATES = [
  {
    id: "cardiologists",
    label: "Cardiologists only",
    emoji: "🪬",
    description: "Only doctors tagged with department:cardiology can open this file",
    policy: [{ key: "role", value: "doctor" }, { key: "department", value: "cardiology" }],
  },
  {
    id: "oncologists",
    label: "Oncologists only",
    emoji: "🩺",
    description: "Only doctors tagged with department:oncology can open this file",
    policy: [{ key: "role", value: "doctor" }, { key: "department", value: "oncology" }],
  },
  {
    id: "any-doctor",
    label: "Any registered doctor",
    emoji: "🏥",
    description: "Any wallet with role:doctor passes automatically",
    policy: [{ key: "role", value: "doctor" }],
  },
  {
    id: "senior-lawyers",
    label: "Senior lawyers only",
    emoji: "⚖️",
    description: "Lawyers with clearance:senior — junior lawyers are blocked",
    policy: [{ key: "role", value: "lawyer" }, { key: "clearance", value: "senior" }],
  },
  {
    id: "cs-professors",
    label: "CS professors only",
    emoji: "🎓",
    description: "Professors in the CS department — other departments are blocked",
    policy: [{ key: "role", value: "professor" }, { key: "department", value: "cs" }],
  },
  {
    id: "senior-auditors",
    label: "Senior auditors only",
    emoji: "🔍",
    description: "Auditors with clearance:level-3 — level-1 auditors cannot access",
    policy: [{ key: "role", value: "auditor" }, { key: "clearance", value: "level-3" }],
  },
  {
    id: "payroll-hr",
    label: "HR / Payroll managers",
    emoji: "💼",
    description: "HR managers with payroll clearance — regular employees are blocked",
    policy: [{ key: "role", value: "hr-manager" }, { key: "clearance", value: "payroll" }],
  },
  {
    id: "executives",
    label: "Level-3 executives only",
    emoji: "🏢",
    description: "Top-level executives — managers and employees cannot access",
    policy: [{ key: "role", value: "executive" }, { key: "clearance", value: "level-3" }],
  },
];

function formatAttributes(attrs) {
  return attrs
    .map((attr) => ({ key: attr.key.trim(), value: attr.value.trim() }))
    .filter((attr) => attr.key && attr.value)
    .map((attr) => `${attr.key}:${attr.value}`);
}

function hashAttributes(attrs) {
  return formatAttributes(attrs).map((attr) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(attr)));
}

function normalizeHash(value) {
  return String(value || "").toLowerCase();
}

function userSatisfiesPolicy(userHashes, requiredHashes) {
  const userSet = new Set((Array.isArray(userHashes) ? userHashes : []).map(normalizeHash));
  return (Array.isArray(requiredHashes) ? requiredHashes : []).every((h) => userSet.has(normalizeHash(h)));
}

export default function ShareModal({ file, onClose, account }) {
  const [step, setStep] = useState(1);
  const [shareModel, setShareModel] = useState("direct-basic");

  const [recipient, setRecipient] = useState("");
  const [expiry, setExpiry] = useState(86400);
  const [filePolicyAttrs, setFilePolicyAttrs] = useState([{ ...EMPTY_ATTR }]);
  const [zkPolicyEnabled, setZkPolicyEnabled] = useState(false);
  const [zkGroupId, setZkGroupId] = useState("");

  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState("");

  const [txStatus, setTxStatus] = useState({ step: 0, done: false, error: null });
  const [isSharing, setIsSharing] = useState(false);
  // Tracks which policy template is currently selected so it can be highlighted.
  const [selectedTemplate, setSelectedTemplate] = useState(null);

  if (!file) return null;

  const expiryLabel = EXPIRY_PRESETS.find((p) => p.seconds === expiry)?.label || `${expiry}s`;
  const selectedGroup = useMemo(
    () => groups.find((g) => g.groupId === selectedGroupId) || null,
    [groups, selectedGroupId]
  );
  const selectedShareModel = useMemo(
    () => SHARE_MODELS.find((m) => m.id === shareModel) || SHARE_MODELS[0],
    [shareModel]
  );
  const mode = selectedShareModel.mode;
  const requiresPolicy = selectedShareModel.requiresPolicy;
  const filePolicyTags = useMemo(() => formatAttributes(filePolicyAttrs), [filePolicyAttrs]);
  const shouldApplyPolicy = requiresPolicy && filePolicyTags.length > 0;
  const isDirectMode = mode === "direct";
  const isDirectRoleMode = shareModel === "direct-role";
  const requiresRecipient = isDirectMode && !isDirectRoleMode;
  const isGroupMode = mode === "group";
  const directProgressSteps = useMemo(
    () => isDirectRoleMode
      ? [
          { n: 1, label: "Writing ABAC file policy (AccessControl)..." },
          { n: 2, label: "Resolving wallets with matching issued roles..." },
          { n: 3, label: "Granting role-matched wallets and expiry windows..." },
        ]
      : shouldApplyPolicy
      ? [
          { n: 1, label: "Writing ABAC file policy (AccessControl)..." },
          { n: 2, label: "Granting direct access (AccessControl)..." },
          { n: 3, label: "Setting time-bound rules (TimeBoundPermissions)..." },
        ]
      : [
          { n: 1, label: "Granting direct access (AccessControl)..." },
          { n: 2, label: "Setting time-bound rules (TimeBoundPermissions)..." },
        ],
    [isDirectRoleMode, shouldApplyPolicy]
  );
  const groupProgressSteps = useMemo(
    () => shouldApplyPolicy
      ? [
          { n: 1, label: "Writing ABAC file policy (AccessControl)..." },
          { n: 2, label: "Wrapping file key to group and storing share..." },
        ]
      : [
          { n: 1, label: "Wrapping file key to group and storing share..." },
        ],
      [shouldApplyPolicy]
  );

  const addAttributeRow = (setter) => setter((current) => [...current, { ...EMPTY_ATTR }]);

  const updateAttributeRow = (setter, index, field, value) => {
    setter((current) => current.map((attr, attrIndex) => (
      attrIndex === index ? { ...attr, [field]: value } : attr
    )));
  };

  const removeAttributeRow = (setter, index) => {
    setter((current) => {
      const next = current.filter((_, attrIndex) => attrIndex !== index);
      return next.length > 0 ? next : [{ ...EMPTY_ATTR }];
    });
  };

  const applyPolicyTemplate = (template) => {
    setSelectedTemplate(template.id);
    setFilePolicyAttrs(template.policy.map((attr) => ({ ...attr })));
  };

  const renderAttributeEditor = ({ title, subtitle, attrs, setter }) => (
    <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-800">{title}</h4>
          <p className="text-xs text-gray-400 mt-1">{subtitle}</p>
        </div>
        <button
          onClick={() => addAttributeRow(setter)}
          className="text-xs text-electric-600 hover:text-electric-700 font-medium inline-flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      <div className="space-y-2">
        {attrs.map((attr, index) => (
          <div key={`${title}-${index}`} className="flex items-center gap-2">
            <input
              className="input-field flex-1 py-2 text-xs"
              placeholder="role"
              value={attr.key}
              onChange={(e) => updateAttributeRow(setter, index, "key", e.target.value)}
            />
            <span className="text-gray-400 font-medium">:</span>
            <input
              className="input-field flex-1 py-2 text-xs"
              placeholder="doctor"
              value={attr.value}
              onChange={(e) => updateAttributeRow(setter, index, "value", e.target.value)}
            />
            <button onClick={() => removeAttributeRow(setter, index)} className="text-red-400 hover:text-red-600 text-lg leading-none px-2">
              &times;
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  const loadGroups = async () => {
    if (!account) return;
    setGroupsLoading(true);
    try {
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);
      const res = await fetch("/api/groups", {
        headers: {
          "x-user-address": auth.address,
          "x-signature": auth.signature,
          "x-message": auth.message,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load groups");
      setGroups(data.groups || []);
      if (!selectedGroupId && data.groups?.length) {
        setSelectedGroupId(data.groups[0].groupId);
      }
    } catch (err) {
      toast.error(err.message || "Failed to load groups");
    } finally {
      setGroupsLoading(false);
    }
  };

  useEffect(() => {
    if (isGroupMode) {
      loadGroups();
    }
  }, [isGroupMode]);

  const resolveRoleRecipients = async (accessControl, requesterAddress, policyHashes) => {
    const requester = String(requesterAddress || "").toLowerCase();
    const candidatesRaw = await accessControl.getKnownAttributeUsers();
    const candidates = [];
    const seen = new Set();
    for (const user of (Array.isArray(candidatesRaw) ? candidatesRaw : [])) {
      if (!user) continue;
      const normalized = String(user).toLowerCase();
      if (normalized === requester) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push(user);
    }

    const matched = [];
    for (const user of candidates) {
      const attrs = await accessControl.getUserAttributes(user);
      if (userSatisfiesPolicy(attrs, policyHashes)) {
        matched.push(user);
      }
    }
    return matched;
  };

  const handleShareDirect = async () => {
    const signer = await getSigner();
    const accessControl = await getAccessControl(signer);
    const timeBound = await getTimeBoundPermissions(signer);
    const requesterAddress = await signer.getAddress();
    const policyHashes = requiresPolicy ? hashAttributes(filePolicyAttrs) : [];

    let currentStep = 0;

    if (isDirectRoleMode || policyHashes.length > 0) {
      if (policyHashes.length === 0) {
        throw new Error("At least one role attribute is required for role-based sharing");
      }
      currentStep = 1;
      setTxStatus({ step: currentStep, done: false, error: null });
      const txPolicy = await accessControl.definePolicy(file.id, policyHashes);
      await txPolicy.wait();

      if (zkPolicyEnabled) {
        const groupIdNum = Number(zkGroupId);
        if (!Number.isInteger(groupIdNum) || groupIdNum < 0) {
          throw new Error("Enter a valid Semaphore groupId for ZK policy");
        }
        const txZk = await accessControl.defineZkPolicy(file.id, groupIdNum, true);
        await txZk.wait();
      } else {
        // Disable any previous ZK policy on the file if toggled off.
        await (await accessControl.defineZkPolicy(file.id, 0, false)).wait().catch(() => {});
      }
    }

    if (isDirectRoleMode) {
      currentStep = 2;
      setTxStatus({ step: currentStep, done: false, error: null });
      const recipients = await resolveRoleRecipients(accessControl, requesterAddress, policyHashes);
      if (recipients.length === 0) {
        throw new Error(
          "No wallets found with matching on-chain role attributes. Ask admin/trusted issuer to assign roles in Settings first."
        );
      }

      currentStep = 3;
      setTxStatus({ step: currentStep, done: false, error: null });
      for (const recipientAddress of recipients) {
        const txGrant = await accessControl.grantAccess(file.id, recipientAddress, []);
        await txGrant.wait();
        const txTimed = await timeBound.grantTimedAccess(recipientAddress, file.id, expiry);
        await txTimed.wait();
      }

      setTxStatus({ step: currentStep, done: true, error: null });
      return { recipientsCount: recipients.length };
    }

    const recipientHashes = [];

    currentStep = policyHashes.length > 0 ? 2 : 1;
    setTxStatus({ step: currentStep, done: false, error: null });
    const tx1 = await accessControl.grantAccess(file.id, recipient, recipientHashes);
    await tx1.wait();

    currentStep = policyHashes.length > 0 ? 3 : 2;
    setTxStatus({ step: currentStep, done: false, error: null });
    const tx2 = await timeBound.grantTimedAccess(recipient, file.id, expiry);
    await tx2.wait();

    setTxStatus({ step: currentStep, done: true, error: null });
    return { recipientsCount: 1 };
  };

  const handleShareGroup = async () => {
    const signer = await getSigner();
    const accessControl = await getAccessControl(signer);
    const auth = await signAuthMessage(signer);
    const policyHashes = requiresPolicy ? hashAttributes(filePolicyAttrs) : [];

    let currentStep = 0;

    if (policyHashes.length > 0) {
      currentStep = 1;
      setTxStatus({ step: currentStep, done: false, error: null });
      const txPolicy = await accessControl.definePolicy(file.id, policyHashes);
      await txPolicy.wait();

      if (zkPolicyEnabled) {
        const groupIdNum = Number(zkGroupId);
        if (!Number.isInteger(groupIdNum) || groupIdNum < 0) {
          throw new Error("Enter a valid Semaphore groupId for ZK policy");
        }
        const txZk = await accessControl.defineZkPolicy(file.id, groupIdNum, true);
        await txZk.wait();
      } else {
        await (await accessControl.defineZkPolicy(file.id, 0, false)).wait().catch(() => {});
      }
    }

    currentStep = policyHashes.length > 0 ? 2 : 1;
    setTxStatus({ step: currentStep, done: false, error: null });

    const res = await fetch(`/api/groups/${encodeURIComponent(selectedGroupId)}/share`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-address": auth.address,
        "x-signature": auth.signature,
        "x-message": auth.message,
      },
      body: JSON.stringify({
        fileId: file.id,
        expiryDurationSeconds: expiry,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Group share failed");

    setTxStatus({ step: currentStep, done: true, error: null });
  };

  const handleShare = async () => {
    if (requiresRecipient && !recipient.match(/^0x[0-9a-fA-F]{40}$/)) {
      toast.error("Enter a valid recipient wallet address");
      return;
    }
    if (isGroupMode && !selectedGroupId) {
      toast.error("Select a group");
      return;
    }
    if (requiresPolicy && filePolicyTags.length === 0) {
      toast.error("At least one ABAC policy attribute is required for this sharing option");
      return;
    }

    setIsSharing(true);
    try {
      if (isDirectMode) {
        const result = await handleShareDirect();
        toast.success(
          isDirectRoleMode
            ? `Role-based file shared to ${result?.recipientsCount || 0} matching wallet(s)`
            : `File shared with ${recipient.slice(0, 8)}...`
        );
      } else {
        await handleShareGroup();
        toast.success(`File shared to group ${selectedGroup?.name || ""}`);
      }
      setTimeout(() => onClose(), 1600);
    } catch (err) {
      setTxStatus((s) => ({ ...s, error: err.message || "Share failed" }));
      toast.error(err.message || "Share failed");
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box animate-slide-up">
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Share File</h2>
            <p className="text-sm text-gray-400 mt-0.5 truncate max-w-xs" title={file.fileName}>{file.fileName}</p>
          </div>
          <button onClick={onClose} className="btn-icon"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-50">
          {[1, 2, 3].map((s) => (
            <React.Fragment key={s}>
              <div className={`step-dot ${step === s ? "active" : step > s ? "done" : "pending"}`}>
                {step > s ? <Check className="w-3.5 h-3.5" /> : s}
              </div>
              {s < 3 && <div className={`flex-1 h-px ${step > s ? "bg-electric-300" : "bg-gray-200"}`} />}
            </React.Fragment>
          ))}
        </div>

        <div className="p-6">
          {step === 1 && (
            <div className="animate-fade-in space-y-4">
              <div className="grid grid-cols-1 gap-2">
                {SHARE_MODELS.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => {
                      setShareModel(model.id);
                      setSelectedTemplate(null);
                      if (!model.requiresPolicy) {
                        setFilePolicyAttrs([{ ...EMPTY_ATTR }]);
                      }
                    }}
                    className={`p-3 rounded-xl text-sm border transition-all text-left ${
                      shareModel === model.id ? "bg-electric-500 border-electric-500 text-white" : "border-gray-200 text-gray-600"
                    }`}
                  >
                    <div className="font-semibold">{model.label}</div>
                    <div className={`text-xs mt-0.5 ${shareModel === model.id ? "text-electric-50" : "text-gray-400"}`}>
                      {model.description}
                    </div>
                  </button>
                ))}
              </div>

              {requiresRecipient ? (
                <div>
                  <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-2">
                    <User className="w-4 h-4 text-electric-500" /> Recipient wallet
                  </h3>
                  <p className="text-xs text-gray-400 mb-3">Recipient needs MetaMask with this address</p>
                  <input
                    className="input-field font-mono"
                    placeholder="0x... wallet address"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    autoFocus
                  />
                </div>
              ) : isDirectRoleMode ? (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-2">
                    <Key className="w-4 h-4 text-electric-500" /> Role policy (ABAC)
                  </h3>
                  <p className="text-xs text-gray-400">
                    Define required roles/attributes. Access is evaluated from trusted issuer-assigned attributes.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                      <Users className="w-4 h-4 text-electric-500" /> Group selection
                    </h3>
                   
                  </div>

                  <select
                    value={selectedGroupId}
                    onChange={(e) => setSelectedGroupId(e.target.value)}
                    className="input-field"
                    disabled={groupsLoading}
                  >
                    <option value="">{groupsLoading ? "Loading groups..." : "Select a group"}</option>
                    {groups.map((g) => (
                      <option key={g.groupId} value={g.groupId}>
                        {g.name} ({g.memberCount} members)
                      </option>
                    ))}
                  </select>

                  {selectedGroup && (
                    <div className="text-xs text-gray-500">
                      Sharing to <span className="font-semibold text-gray-700">{selectedGroup.name}</span> ({selectedGroup.memberCount} active members)
                    </div>
                  )}
                </div>
              )}

              <div className="bg-electric-50 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2 text-xs text-electric-700">
                  <Key className="w-3.5 h-3.5" />
                  <span className="font-semibold">Key protection: server-managed Group KEK + AES-256 key wrapping</span>
                </div>
                <p className="text-xs text-electric-600 mt-1">
                  Individual sharing has direct wallet-only mode and role-based mode. Group sharing has open mode and role-restricted mode.
                </p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="animate-fade-in space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-2">
                <Clock className="w-4 h-4 text-electric-500" /> Access expiry
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {EXPIRY_PRESETS.map((p) => (
                  <button
                    key={p.seconds}
                    onClick={() => setExpiry(p.seconds)}
                    className={`py-2.5 rounded-xl text-sm font-medium border transition-all ${
                      expiry === p.seconds
                        ? "bg-electric-500 border-electric-500 text-white shadow-electric"
                        : "border-gray-200 text-gray-600 hover:border-electric-300"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {requiresPolicy && (
                <div className="rounded-xl border border-gray-100 bg-white p-4 space-y-3">
                  <div className="text-xs font-semibold text-gray-700">Quick role templates</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {POLICY_TEMPLATES.map((template) => (
                      <button
                        key={template.id}
                        onClick={() => applyPolicyTemplate(template)}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          selectedTemplate === template.id
                            ? "border-electric-500 bg-electric-50"
                            : "border-gray-200 hover:border-electric-300"
                        }`}
                      >
                        <div className="text-sm font-semibold text-gray-800">{template.emoji} {template.label}</div>
                        <div className="text-xs text-gray-500 mt-1">{template.description}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {requiresPolicy && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold text-gray-700">Zero-knowledge access (Semaphore)</div>
                      <div className="text-xs text-gray-500 mt-1">
                        If enabled, recipients must prove membership in a Semaphore ZK group before download.
                      </div>
                    </div>
                    <label className="text-xs font-semibold text-gray-700 flex items-center gap-2 select-none">
                      <input
                        type="checkbox"
                        checked={zkPolicyEnabled}
                        onChange={(e) => setZkPolicyEnabled(e.target.checked)}
                      />
                      Enable
                    </label>
                  </div>
                  {zkPolicyEnabled && (
                    <div className="space-y-2">
                      <input
                        className="input-field text-xs"
                        placeholder="Enter Semaphore groupId manually"
                        value={zkGroupId}
                        onChange={(e) => setZkGroupId(e.target.value)}
                      />
                      <div className="text-[11px] text-gray-500">
                        Group discovery is disabled for privacy. Use the known groupId.
                      </div>
                    </div>
                  )}
                </div>
              )}

              {requiresPolicy ? renderAttributeEditor({
                title: "ABAC File Policy",
                subtitle: "Required for this sharing option. Users must match all listed attributes.",
                attrs: filePolicyAttrs,
                setter: setFilePolicyAttrs,
              }) : (
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                  <div className="text-xs font-semibold text-gray-700">Access Control</div>
                  <div className="text-xs text-gray-500 mt-1">Disabled for this sharing option.</div>
                </div>
              )}

              {requiresRecipient && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                  <div className="text-xs font-semibold text-gray-700">Recipient Role Assignment</div>
                  <div className="text-xs text-gray-500 mt-1">
                    Disabled in strict mode. Roles are issued only by trusted issuers in Settings.
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="animate-fade-in space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Confirm & Share</h3>

              <div className="bg-gray-50 rounded-xl divide-y divide-gray-100">
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-xs text-gray-400">Mode</span>
                  <span className="text-xs font-medium text-gray-800">{selectedShareModel.shortLabel}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-xs text-gray-400">Target</span>
                  <span className="text-xs font-medium text-gray-800 font-mono">
                    {requiresRecipient
                      ? `${recipient.slice(0, 16)}...${recipient.slice(-8)}`
                      : isDirectRoleMode
                        ? "Any user matching policy"
                      : `${selectedGroup?.name || "-"} (${selectedGroup?.memberCount || 0} members)`}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-xs text-gray-400">Expiry</span>
                  <span className="text-xs font-medium text-gray-800">{expiryLabel}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-xs text-gray-400">ABAC Policy</span>
                  <span className="text-xs font-medium text-gray-800">
                    {requiresPolicy
                      ? (filePolicyTags.length > 0 ? `${filePolicyTags.length} required attribute(s)` : "Required (not set)")
                      : "Disabled"}
                  </span>
                </div>
                {requiresRecipient && (
                  <div className="px-4 py-3">
                    <div className="text-xs text-gray-400">Recipient Attributes</div>
                    <div className="text-xs font-medium text-gray-800 mt-0.5">
                      Issuer-managed in strict mode (sender cannot assign roles during share).
                    </div>
                  </div>
                )}
              </div>

              {(isSharing || txStatus.done) && (
                <div className="space-y-2">
                  {(isDirectMode ? directProgressSteps : groupProgressSteps).map(({ n, label }) => (
                    <div key={n} className="flex items-center gap-3 text-xs">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                        txStatus.done && n <= txStatus.step ? "bg-green-100" :
                        txStatus.step === n ? "bg-electric-100" : "bg-gray-100"
                      }`}>
                        {(txStatus.done && n <= txStatus.step) || txStatus.done
                          ? <Check className="w-3 h-3 text-green-600" />
                          : txStatus.step === n
                            ? <Loader2 className="w-3 h-3 text-electric-500 animate-spin" />
                            : <span className="text-gray-400 text-[10px]">{n}</span>}
                      </div>
                      <span className={
                        txStatus.done ? "text-green-700" :
                        txStatus.step === n ? "text-electric-700" : "text-gray-400"
                      }>
                        {isDirectMode
                          ? `Transaction ${n}/${directProgressSteps.length}: ${label}`
                          : `Step ${n}/${groupProgressSteps.length}: ${label}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {txStatus.error && (
                <div className="bg-red-50 text-red-600 text-xs rounded-xl px-4 py-3">
                  {txStatus.error}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-6 border-t border-gray-100">
          <button
            onClick={() => step > 1 ? setStep((s) => s - 1) : onClose()}
            className="btn-secondary flex items-center gap-2"
            disabled={isSharing}
          >
            <ChevronLeft className="w-4 h-4" />
            {step === 1 ? "Cancel" : "Back"}
          </button>

          {step < 3 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={
                (step === 1 && ((requiresRecipient && !recipient.match(/^0x[0-9a-fA-F]{40}$/)) || (isGroupMode && !selectedGroupId))) ||
                (step === 2 && requiresPolicy && filePolicyTags.length === 0)
              }
              className="btn-primary flex items-center gap-2"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleShare}
              disabled={isSharing || txStatus.done}
              className="btn-primary flex items-center gap-2"
            >
              {isSharing ? <><Loader2 className="w-4 h-4 animate-spin" /> Sharing...</>
                : txStatus.done ? <><Check className="w-4 h-4" /> Shared!</>
                : "Share Now"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
