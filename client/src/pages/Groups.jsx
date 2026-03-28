import React, { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Shield, Users, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { getAccessControl, getSemaphore, getSigner, signAuthMessage } from "../utils/blockchain";
import { Identity } from "@semaphore-protocol/identity";

const ZK_NAME_STORAGE_PREFIX = "zkGroupNames_";

function parseMemberInput(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

function getZkGroupNames(account) {
  if (!account) return {};
  try {
    const raw = localStorage.getItem(`${ZK_NAME_STORAGE_PREFIX}${String(account).toLowerCase()}`);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveZkGroupName(account, groupId, name) {
  if (!account || !groupId || !name) return;
  const current = getZkGroupNames(account);
  const next = { ...current, [String(groupId)]: String(name).trim() };
  localStorage.setItem(`${ZK_NAME_STORAGE_PREFIX}${String(account).toLowerCase()}`, JSON.stringify(next));
}

export default function Groups({ account }) {
  const [groups, setGroups] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const [createMode, setCreateMode] = useState("general");
  const [isCreating, setIsCreating] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState("");

  const [zkGroupName, setZkGroupName] = useState("");
  const [zkDuration, setZkDuration] = useState("3600");
  const [isCreatingZk, setIsCreatingZk] = useState(false);

  const [newMemberByGroup, setNewMemberByGroup] = useState({});
  const [newZkCommitmentByGroup, setNewZkCommitmentByGroup] = useState({});
  const [newZkWalletByGroup, setNewZkWalletByGroup] = useState({});
  const [busyKey, setBusyKey] = useState("");
  const [registeringIdentity, setRegisteringIdentity] = useState(false);

  const loadGroups = useCallback(async () => {
    if (!account) return;
    setIsLoading(true);
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
      const baseGroups = Array.isArray(data.groups) ? data.groups : [];

      const accessControl = await getAccessControl(signer);
      const semaphore = await getSemaphore(signer);
      const isIssuer = await accessControl.isTrustedIssuer(auth.address);
      const namesMap = getZkGroupNames(auth.address);

      const createdEvents = await accessControl.queryFilter(accessControl.filters.ZkGroupCreated(), 0, "latest");

      const [registeredCommitment, isRegistered] = await accessControl.getRegisteredZkIdentity(auth.address);
      const hasRegisteredCommitment = Boolean(isRegistered);
      const commitmentsToMatch = new Set();
      if (hasRegisteredCommitment) {
        commitmentsToMatch.add(registeredCommitment.toString());
      }

      const identityStorageKey = `semaphoreIdentity_${String(auth.address).toLowerCase()}`;
      const identityStored = localStorage.getItem(identityStorageKey);
      if (identityStored) {
        try {
          const identity = Identity.import(identityStored);
          commitmentsToMatch.add(identity.commitment.toString());
        } catch {
          // Ignore malformed legacy identity value.
        }
      }

      const myMemberGroupIds = new Set();

      if (commitmentsToMatch.size > 0) {
        const singleMemberEvents = await semaphore.queryFilter(semaphore.filters.MemberAdded(), 0, "latest");
        for (const ev of singleMemberEvents) {
          const groupId = ev?.args?.groupId;
          const identityCommitment = ev?.args?.identityCommitment;
          if (groupId === undefined || identityCommitment === undefined) continue;
          if (commitmentsToMatch.has(identityCommitment.toString())) {
            myMemberGroupIds.add(groupId.toString());
          }
        }

        const batchMemberEvents = await semaphore.queryFilter(semaphore.filters.MembersAdded(), 0, "latest");
        for (const ev of batchMemberEvents) {
          const groupId = ev?.args?.groupId;
          const commitments = ev?.args?.identityCommitments || [];
          if (groupId === undefined || !Array.isArray(commitments)) continue;
          const hasMe = commitments.some((c) => c?.toString && commitmentsToMatch.has(c.toString()));
          if (hasMe) {
            myMemberGroupIds.add(groupId.toString());
          }
        }
      }

      const zkGroupsMap = new Map();
      for (const ev of createdEvents) {
        const gid = ev?.args?.groupId;
        const dur = ev?.args?.merkleTreeDuration;
        if (gid === undefined) continue;

        const id = gid.toString();
        if (zkGroupsMap.has(id)) continue;

        let creator = "";
        try {
          creator = await accessControl.getZkGroupCreator(id);
        } catch {
          creator = "";
        }

        const isCreator = creator && String(creator).toLowerCase() === String(auth.address).toLowerCase();
        const isMember = myMemberGroupIds.has(id);

        if (!isCreator && !isMember) {
          continue;
        }

        const role = isCreator ? (isMember ? "owner/member" : "owner") : "member";

        zkGroupsMap.set(id, {
          groupId: id,
          name: String(namesMap[id] || "").trim() || `ZK group #${id}`,
          ownerAddress: creator || null,
          currentKeyVersion: null,
          status: "active",
          role,
          memberCount: null,
          durationSeconds: dur ? Number(dur.toString()) : null,
          isZk: true,
          canManage: Boolean(isIssuer || isCreator),
        });
      }

      const zkGroups = Array.from(zkGroupsMap.values());

      setGroups([
        ...baseGroups.map((g) => ({ ...g, isZk: false })),
        ...zkGroups,
      ]);
    } catch (err) {
      toast.error(err.message || "Failed to load groups");
    } finally {
      setIsLoading(false);
    }
  }, [account]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  const createGroup = async () => {
    if (!groupName.trim()) {
      toast.error("Group name is required");
      return;
    }

    const members = parseMemberInput(groupMembers);
    setIsCreating(true);
    try {
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-address": auth.address,
          "x-signature": auth.signature,
          "x-message": auth.message,
        },
        body: JSON.stringify({ name: groupName.trim(), members }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create group");

      toast.success("Group created");
      setGroupName("");
      setGroupMembers("");
      await loadGroups();
    } catch (err) {
      toast.error(err.message || "Failed to create group");
    } finally {
      setIsCreating(false);
    }
  };

  const createZkGroup = async () => {
    if (!zkDuration.trim()) {
      toast.error("Duration (seconds) is required");
      return;
    }
    const seconds = Number(zkDuration);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      toast.error("Duration must be a positive integer (seconds)");
      return;
    }

    setIsCreatingZk(true);
    try {
      const signer = await getSigner();
      const accessControl = await getAccessControl(signer);
      const tx = await accessControl.createZkGroup(seconds);
      const receipt = await tx.wait();
      let groupId = null;
      const ev = receipt?.events?.find?.((e) => e.event === "ZkGroupCreated");
      if (ev?.args?.groupId !== undefined) {
        groupId = ev.args.groupId.toString();
      }

      if (groupId && zkGroupName.trim()) {
        saveZkGroupName(account, groupId, zkGroupName.trim());
      }

      toast.success(groupId ? `ZK group created (id=${groupId})` : "ZK group created");
      setZkGroupName("");
      await loadGroups();
    } catch (err) {
      toast.error(err.message || "Failed to create ZK group");
    } finally {
      setIsCreatingZk(false);
    }
  };

  const addGeneralGroupMember = async (groupId) => {
    const memberAddress = String(newMemberByGroup[groupId] || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(memberAddress)) {
      toast.error("Enter a valid wallet address");
      return;
    }
    setBusyKey(`general:${groupId}`);
    try {
      const signer = await getSigner();
      const auth = await signAuthMessage(signer);
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-address": auth.address,
          "x-signature": auth.signature,
          "x-message": auth.message,
        },
        body: JSON.stringify({ memberAddress }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to add member");
      toast.success("Member added to group");
      setNewMemberByGroup((prev) => ({ ...prev, [groupId]: "" }));
      await loadGroups();
    } catch (err) {
      toast.error(err.message || "Failed to add member");
    } finally {
      setBusyKey("");
    }
  };

  const registerMyZkIdentity = async () => {
    if (!account) return;
    setRegisteringIdentity(true);
    try {
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

      const signer = await getSigner();
      const accessControl = await getAccessControl(signer);
      const tx = await accessControl.registerMyZkIdentity(identity.commitment.toString());
      await tx.wait();
      toast.success("Your ZK commitment was registered on-chain");
      await loadGroups();
    } catch (err) {
      toast.error(err.message || "Failed to register ZK identity");
    } finally {
      setRegisteringIdentity(false);
    }
  };

  const addZkMemberByCommitment = async (groupId) => {
    const commitment = String(newZkCommitmentByGroup[groupId] || "").trim();
    if (!/^\d+$/.test(commitment)) {
      toast.error("Enter a valid decimal identity commitment");
      return;
    }
    setBusyKey(`zkc:${groupId}`);
    try {
      const signer = await getSigner();
      const accessControl = await getAccessControl(signer);
      const tx = await accessControl.addZkGroupMember(groupId, commitment);
      await tx.wait();
      toast.success("Commitment added to ZK group");
      setNewZkCommitmentByGroup((prev) => ({ ...prev, [groupId]: "" }));
      await loadGroups();
    } catch (err) {
      toast.error(err.message || "Failed to add commitment");
    } finally {
      setBusyKey("");
    }
  };

  const addZkMemberByWallet = async (groupId) => {
    const wallet = String(newZkWalletByGroup[groupId] || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      toast.error("Enter a valid wallet address");
      return;
    }
    setBusyKey(`zkw:${groupId}`);
    try {
      const signer = await getSigner();
      const accessControl = await getAccessControl(signer);
      const tx = await accessControl.addRegisteredUserToZkGroup(groupId, wallet);
      await tx.wait();
      toast.success("Registered wallet added to ZK group");
      setNewZkWalletByGroup((prev) => ({ ...prev, [groupId]: "" }));
      await loadGroups();
    } catch (err) {
      toast.error(err.message || "Failed to add wallet to ZK group");
    } finally {
      setBusyKey("");
    }
  };

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          {createMode === "zk" ? <Shield className="w-4 h-4 text-electric-500" /> : <Users className="w-4 h-4 text-electric-500" />}
          <h2 className="text-lg font-semibold text-gray-900">Create Group</h2>
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          <button
            onClick={() => setCreateMode("general")}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
              createMode === "general"
                ? "bg-electric-500 border-electric-500 text-white"
                : "border-gray-200 text-gray-600 hover:border-electric-300"
            }`}
          >
            General Group
          </button>
          <button
            onClick={() => setCreateMode("zk")}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
              createMode === "zk"
                ? "bg-electric-500 border-electric-500 text-white"
                : "border-gray-200 text-gray-600 hover:border-electric-300"
            }`}
          >
            ZK Group
          </button>
        </div>

        {createMode === "general" ? (
          <div className="space-y-3">
            <input
              className="input-field"
              placeholder="Group name"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
            <textarea
              className="input-field min-h-[88px]"
              placeholder="Member wallet addresses (comma-separated)"
              value={groupMembers}
              onChange={(e) => setGroupMembers(e.target.value)}
            />
            <button
              onClick={createGroup}
              disabled={isCreating}
              className="btn-primary inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {isCreating ? "Creating..." : "Create Group"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              ZK groups are Semaphore Merkle trees used for zero-knowledge access control.
            </p>
            <button
              onClick={registerMyZkIdentity}
              disabled={registeringIdentity}
              className="btn-secondary inline-flex items-center gap-2 text-xs"
            >
              {registeringIdentity ? <><Loader2 className="w-3 h-3 animate-spin" /> Registering…</> : "Register My ZK Commitment"}
            </button>
            <div className="text-[11px] text-gray-500">
              Run once per wallet so managers can add you to ZK groups by wallet address.
            </div>
            <input
              className="input-field text-xs"
              value={zkGroupName}
              onChange={(e) => setZkGroupName(e.target.value)}
              placeholder="Optional ZK group name (stored in your browser)"
            />
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-gray-600 mb-1">Merkle root duration (seconds)</label>
                <input
                  className="input-field text-xs"
                  value={zkDuration}
                  onChange={(e) => setZkDuration(e.target.value)}
                  placeholder="e.g. 3600"
                />
              </div>
              <button
                onClick={createZkGroup}
                disabled={isCreatingZk}
                className="btn-secondary inline-flex items-center gap-2"
              >
                {isCreatingZk ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    Create ZK Group
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">My Groups</h3>
          <button
            onClick={loadGroups}
            disabled={isLoading}
            className="btn-secondary inline-flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {groups.length === 0 ? (
          <div className="text-sm text-gray-500">No groups found for this wallet.</div>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <div key={`${g.isZk ? "zk:" : "grp:"}${g.groupId}`} className="rounded-xl border border-gray-100 px-4 py-3 bg-gray-50">
                {/** Owner-only controls for normal groups */}
                {/** For ZK groups, creator/trusted issuer controls are already handled by canManage */}
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    {g.isZk && <Shield className="w-3.5 h-3.5 text-electric-500" />}
                    <span>{g.name || (g.isZk ? `ZK group #${g.groupId}` : `Group ${g.groupId}`)}</span>
                  </div>
                  {g.isZk && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-50 text-purple-600 border border-purple-100">
                      ZK
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {g.isZk ? (
                    <>
                      Semaphore ZK group (id {g.groupId}) • role: {g.role || "member"}
                      {g.durationSeconds ? ` • root TTL ${(g.durationSeconds / 3600).toFixed(1)}h` : ""}
                    </>
                  ) : (
                    <>
                      {g.memberCount} active member(s) • role: {g.role || "member"}
                    </>
                  )}
                </div>
                {!g.isZk ? (
                  String(g.role || "").toLowerCase() === "owner" ? (
                    <div className="mt-3 flex flex-col sm:flex-row gap-2">
                      <input
                        className="input-field text-xs flex-1"
                        placeholder="Add member wallet (0x...)"
                        value={newMemberByGroup[g.groupId] || ""}
                        onChange={(e) =>
                          setNewMemberByGroup((prev) => ({ ...prev, [g.groupId]: e.target.value }))
                        }
                      />
                      <button
                        onClick={() => addGeneralGroupMember(g.groupId)}
                        disabled={busyKey === `general:${g.groupId}`}
                        className="btn-secondary text-xs inline-flex items-center gap-1"
                      >
                        {busyKey === `general:${g.groupId}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        Add Member
                      </button>
                    </div>
                  ) : null
                ) : (
                  <div className="mt-3 space-y-2">
                    <div className="text-[11px] text-gray-500">
                      Add members to this ZK group (by commitment or by registered wallet).
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        className="input-field text-xs flex-1"
                        placeholder="Identity commitment (decimal)"
                        value={newZkCommitmentByGroup[g.groupId] || ""}
                        onChange={(e) =>
                          setNewZkCommitmentByGroup((prev) => ({ ...prev, [g.groupId]: e.target.value }))
                        }
                      />
                      <button
                        onClick={() => addZkMemberByCommitment(g.groupId)}
                        disabled={busyKey === `zkc:${g.groupId}` || !g.canManage}
                        className="btn-secondary text-xs inline-flex items-center gap-1"
                      >
                        {busyKey === `zkc:${g.groupId}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        Add Commitment
                      </button>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        className="input-field text-xs flex-1"
                        placeholder="Registered wallet (0x...)"
                        value={newZkWalletByGroup[g.groupId] || ""}
                        onChange={(e) =>
                          setNewZkWalletByGroup((prev) => ({ ...prev, [g.groupId]: e.target.value }))
                        }
                      />
                      <button
                        onClick={() => addZkMemberByWallet(g.groupId)}
                        disabled={busyKey === `zkw:${g.groupId}` || !g.canManage}
                        className="btn-secondary text-xs inline-flex items-center gap-1"
                      >
                        {busyKey === `zkw:${g.groupId}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        Add Wallet
                      </button>
                    </div>
                    {!g.canManage && (
                      <div className="text-[11px] text-amber-600">
                        You can view this ZK group, but only the creator or a trusted issuer can add members.
                      </div>
                    )}
                  </div>
                )}
                {!g.isZk && String(g.role || "").toLowerCase() !== "owner" && (
                  <div className="text-[11px] text-amber-600 mt-2">
                    Only the group owner can add members to this group.
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
