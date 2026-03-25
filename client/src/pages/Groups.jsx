import React, { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Users } from "lucide-react";
import toast from "react-hot-toast";
import { getSigner, signAuthMessage } from "../utils/blockchain";

function parseMemberInput(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

export default function Groups({ account }) {
  const [groups, setGroups] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState("");

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
      setGroups(Array.isArray(data.groups) ? data.groups : []);
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

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-4 h-4 text-electric-500" />
          <h2 className="text-lg font-semibold text-gray-900">Create Group</h2>
        </div>

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
          <div className="text-sm text-gray-500">No groups found. Create your first group above.</div>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <div key={g.groupId} className="rounded-xl border border-gray-100 px-4 py-3 bg-gray-50">
                <div className="font-medium text-gray-900">{g.name}</div>
                <div className="text-xs text-gray-500 mt-1">
                  {g.memberCount} active member(s) • role: {g.role || "member"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
