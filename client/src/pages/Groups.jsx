import React, { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Shield, Users, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { ethers } from "ethers";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { getAccessControl, getSigner, relayAddZkMemberByLeaderProof, relayCreateZkGroupWithLeader, signAuthMessage } from "../utils/blockchain";

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

function getOrCreateLocalSemaphoreIdentity(account) {
  if (!account) throw new Error("Wallet is required");
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

  return identity;
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
  const [zkLeaderCommitment, setZkLeaderCommitment] = useState("");
  const [isCreatingZk, setIsCreatingZk] = useState(false);
  const [manualZkGroupId, setManualZkGroupId] = useState("");
  const [manualZkCommitment, setManualZkCommitment] = useState("");
  const [isAddingManualZkMember, setIsAddingManualZkMember] = useState(false);

  const [newMemberByGroup, setNewMemberByGroup] = useState({});
  const [newZkCommitmentByGroup, setNewZkCommitmentByGroup] = useState({});
  const [busyKey, setBusyKey] = useState("");

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
      setGroups(baseGroups.map((g) => ({ ...g, isZk: false })));
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
      const identity = getOrCreateLocalSemaphoreIdentity(account);
      const localCommitment = identity.commitment.toString();
      const leaderCommitment = String(zkLeaderCommitment || "").trim() || localCommitment;
      if (!/^\d+$/.test(leaderCommitment)) {
        throw new Error("Leader commitment must be a valid decimal uint256");
      }
      if (leaderCommitment !== localCommitment) {
        throw new Error("Leader commitment must match your local Semaphore identity commitment");
      }

      const relayed = await relayCreateZkGroupWithLeader({
        signer,
        merkleTreeDuration: seconds,
        leaderCommitment,
      });
      const groupId = String(relayed.groupId || "");

      if (groupId && zkGroupName.trim()) {
        saveZkGroupName(account, groupId, zkGroupName.trim());
      }

      toast.success(groupId ? `ZK group created (id=${groupId})` : "ZK group created");
      setZkGroupName("");
      setZkLeaderCommitment("");
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
      const [enabled, leaderCommitment] = await accessControl.getZkGroupLeaderConfig(groupId);
      if (!enabled) {
        throw new Error("Leader authorization is not configured for this ZK group");
      }

      const identity = getOrCreateLocalSemaphoreIdentity(account);
      const localCommitment = identity.commitment.toString();
      if (String(leaderCommitment || "") !== localCommitment) {
        throw new Error("Your local Semaphore identity is not the configured group leader");
      }

      const nonce = ethers.BigNumber.from(ethers.utils.randomBytes(8)).toString();
      const deadline = Math.floor(Date.now() / 1000) + 10 * 60;
      const messageHash = ethers.utils.solidityKeccak256(
        ["string", "uint256", "uint256", "uint256", "uint256"],
        ["ZK_LEADER_ADD_MEMBER", groupId, commitment, nonce, deadline]
      );
      const scopeHash = ethers.utils.solidityKeccak256(
        ["string", "uint256", "uint256", "uint256"],
        ["ZK_LEADER_SCOPE", groupId, nonce, deadline]
      );
      const message = ethers.BigNumber.from(messageHash).toString();
      const scope = ethers.BigNumber.from(scopeHash).toString();

      const leaderGroup = new Group([localCommitment]);
      const leaderProof = await generateProof(identity, leaderGroup, message, scope);

      await relayAddZkMemberByLeaderProof({
        signer,
        groupId,
        identityCommitment: commitment,
        nonce,
        deadline,
        leaderProof,
      });

      toast.success("Commitment added to ZK group");
      setNewZkCommitmentByGroup((prev) => ({ ...prev, [groupId]: "" }));
      await loadGroups();
    } catch (err) {
      toast.error(err.message || "Failed to add commitment");
    } finally {
      setBusyKey("");
    }
  };

  const addManualZkMember = async () => {
    const groupId = String(manualZkGroupId || "").trim();
    const commitment = String(manualZkCommitment || "").trim();

    if (!/^\d+$/.test(groupId)) {
      toast.error("Enter a valid numeric ZK group ID");
      return;
    }
    if (!/^\d+$/.test(commitment)) {
      toast.error("Enter a valid decimal identity commitment");
      return;
    }

    setIsAddingManualZkMember(true);
    try {
      const signer = await getSigner();
      const accessControl = await getAccessControl(signer);
      const [enabled, leaderCommitment] = await accessControl.getZkGroupLeaderConfig(groupId);
      if (!enabled) {
        throw new Error("Leader authorization is not configured for this ZK group");
      }

      const identity = getOrCreateLocalSemaphoreIdentity(account);
      const localCommitment = identity.commitment.toString();
      if (String(leaderCommitment || "") !== localCommitment) {
        throw new Error("Your local Semaphore identity is not the configured group leader");
      }

      const nonce = ethers.BigNumber.from(ethers.utils.randomBytes(8)).toString();
      const deadline = Math.floor(Date.now() / 1000) + 10 * 60;
      const messageHash = ethers.utils.solidityKeccak256(
        ["string", "uint256", "uint256", "uint256", "uint256"],
        ["ZK_LEADER_ADD_MEMBER", groupId, commitment, nonce, deadline]
      );
      const scopeHash = ethers.utils.solidityKeccak256(
        ["string", "uint256", "uint256", "uint256"],
        ["ZK_LEADER_SCOPE", groupId, nonce, deadline]
      );
      const message = ethers.BigNumber.from(messageHash).toString();
      const scope = ethers.BigNumber.from(scopeHash).toString();

      const leaderGroup = new Group([localCommitment]);
      const leaderProof = await generateProof(identity, leaderGroup, message, scope);

      await relayAddZkMemberByLeaderProof({
        signer,
        groupId,
        identityCommitment: commitment,
        nonce,
        deadline,
        leaderProof,
      });

      toast.success("Commitment added to ZK group");
      setManualZkCommitment("");
    } catch (err) {
      toast.error(err.message || "Failed to add commitment to ZK group");
    } finally {
      setIsAddingManualZkMember(false);
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
            <div className="text-[11px] text-gray-500">
              Wallet-to-commitment linking is disabled. Share by commitment and group ID only.
            </div>
            <input
              className="input-field text-xs"
              value={zkGroupName}
              onChange={(e) => setZkGroupName(e.target.value)}
              placeholder="Optional ZK group name (stored in your browser)"
            />
            <input
              className="input-field text-xs font-mono"
              value={zkLeaderCommitment}
              onChange={(e) => setZkLeaderCommitment(e.target.value)}
              placeholder="Leader commitment (leave empty to use your local identity)"
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

            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 space-y-3">
              <div className="text-xs font-semibold text-gray-700">Add Member to Existing ZK Group</div>
              <div className="text-[11px] text-gray-500">
                Enter the target group ID and identity commitment to add a member.
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  className="input-field text-xs flex-1"
                  value={manualZkGroupId}
                  onChange={(e) => setManualZkGroupId(e.target.value)}
                  placeholder="ZK group ID (numeric)"
                />
                <input
                  className="input-field text-xs flex-1"
                  value={manualZkCommitment}
                  onChange={(e) => setManualZkCommitment(e.target.value)}
                  placeholder="Identity commitment (decimal)"
                />
                <button
                  onClick={addManualZkMember}
                  disabled={isAddingManualZkMember}
                  className="btn-secondary inline-flex items-center gap-2"
                >
                  {isAddingManualZkMember ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Adding…
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      Add Member
                    </>
                  )}
                </button>
              </div>
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
                      Add members to this ZK group by identity commitment.
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
