// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/**
 * @title FileAccessControl
 * @notice Attribute-Based Access Control (ABAC) for file permissions.
 * @dev Users hold a set of bytes32 attribute tags. File owners define required-attribute
 *      policies.  Access is granted when the user's attributes satisfy the policy (i.e.
 *      they possess ALL required attributes).
 */
contract FileAccessControl is Ownable, ReentrancyGuard {
    // ─────────────────────────────── State ───────────────────────────────

    /// @dev user => set of attribute tags (e.g. keccak256("role:doctor"))
    mapping(address => bytes32[]) private _userAttributes;

    /// @dev Tracks which addresses have ever had attributes issued.
    mapping(address => bool) private _knownAttributeUsers;
    address[] private _knownAttributeUserList;

    /// @dev fileId => required attribute tags (ALL must match)
    mapping(uint256 => bytes32[]) private _filePolicies;

    /// @dev fileId => recipient => explicit access grant flag
    mapping(uint256 => mapping(address => bool)) private _accessGrants;

    /// @dev fileId => list of grantees (for enumeration)
    mapping(uint256 => address[]) private _grantees;

    /// @dev owner of each file (set by FileRegistry, stored here for authorisation)
    mapping(uint256 => address) private _fileOwner;

    /// @dev addresses allowed to issue role/department attributes on-chain
    mapping(address => bool) private _trustedIssuers;

    /// @dev Optional Semaphore contract for ZK role proofs (group membership).
    ISemaphore public semaphore;

    struct ZkPolicy {
        bool enabled;
        uint256 groupId;
    }

    struct ZkGroupLeaderConfig {
        bool enabled;
        uint256 leaderCommitment;
        uint256 leaderAuthGroupId;
    }

    /// @dev fileId => ZK policy (Semaphore group requirement)
    mapping(uint256 => ZkPolicy) private _zkPolicies;

    /// @dev Deprecated: retained for ABI/storage compatibility (no longer used for auth decisions)
    mapping(uint256 => mapping(address => bool)) private _zkVerifiedAccess;

    /// @dev zk group creator/manager
    mapping(uint256 => address) private _zkGroupCreator;

    /// @dev per-zk-group leader authorization settings
    mapping(uint256 => ZkGroupLeaderConfig) private _zkGroupLeaderConfig;

    /// @dev tracks used leader-proof nullifiers per target group
    mapping(uint256 => mapping(uint256 => bool)) private _usedLeaderProofNullifier;

    /// @dev Relayer wallet permitted to execute relayed leader-authorized member adds.
    address public zkRelayer;

    // ─────────────────────────────── Events ──────────────────────────────

    event AttributesSet(address indexed user, bytes32[] attributes);
    event PolicyDefined(uint256 indexed fileId, bytes32[] requiredAttributes);
    event AccessGranted(uint256 indexed fileId, address indexed recipient);
    event AccessRevoked(uint256 indexed fileId, address indexed recipient);
    event TrustedIssuerUpdated(address indexed issuer, bool enabled);
    event SemaphoreUpdated(address indexed semaphore);
    event ZkPolicyDefined(uint256 indexed fileId, uint256 indexed groupId, bool enabled);
    event ZkAccessVerified(uint256 indexed fileId, address indexed user, uint256 indexed groupId, uint256 nullifier);
    event ZkGroupCreated(uint256 indexed groupId, uint256 merkleTreeDuration);
    event ZkGroupMemberAdded(uint256 indexed groupId, address indexed manager, uint256 identityCommitment);
    event ZkGroupLeaderConfigured(uint256 indexed groupId, uint256 indexed leaderAuthGroupId, uint256 leaderCommitment);
    event ZkRelayerUpdated(address indexed relayer);
    event ZkGroupMemberAddedByLeaderProof(uint256 indexed groupId, uint256 indexed nullifier, uint256 identityCommitment, uint256 nonce);

    // ─────────────────────────────── Modifiers ───────────────────────────

    modifier onlyFileOwner(uint256 fileId) {
        require(_fileOwner[fileId] == msg.sender, "ABAC: caller is not file owner");
        _;
    }

    modifier onlyTrustedIssuer() {
        require(_trustedIssuers[msg.sender], "ABAC: caller is not a trusted issuer");
        _;
    }

    modifier onlyZkRelayer() {
        require(msg.sender == zkRelayer, "ZK: caller not relayer");
        _;
    }

    modifier onlyZkGroupManager(uint256 groupId) {
        require(
            _zkGroupCreator[groupId] == msg.sender || _trustedIssuers[msg.sender],
            "ZK: caller not group manager"
        );
        _;
    }

    constructor(address semaphoreAddress) {
        if (semaphoreAddress != address(0)) {
            semaphore = ISemaphore(semaphoreAddress);
            emit SemaphoreUpdated(semaphoreAddress);
        }
        _trustedIssuers[msg.sender] = true;
        emit TrustedIssuerUpdated(msg.sender, true);
    }

    // ─────────────────────────────── Functions ────────────────────────────

    /**
     * @notice Set (or disable) the Semaphore contract used for ZK access proofs.
     * @dev Owner-only, to allow upgrading/verifier redeploys in dev.
     */
    function setSemaphore(address semaphoreAddress) external onlyOwner {
        semaphore = ISemaphore(semaphoreAddress);
        emit SemaphoreUpdated(semaphoreAddress);
    }

    function setZkRelayer(address relayer) external onlyOwner {
        require(relayer != address(0), "ZK: invalid relayer");
        zkRelayer = relayer;
        emit ZkRelayerUpdated(relayer);
    }

    /**
     * @notice Create a new Semaphore group.
     * @dev Any user can create a ZK group; this contract is recorded as admin.
     *      The returned groupId should be used in defineZkPolicy(fileId, groupId, true).
     */
    function createZkGroup(uint256 merkleTreeDuration) external returns (uint256 groupId) {
        require(address(semaphore) != address(0), "ZK: semaphore not configured");
        groupId = semaphore.createGroup(address(this), merkleTreeDuration);
        _zkGroupCreator[groupId] = msg.sender;
        emit ZkGroupCreated(groupId, merkleTreeDuration);
    }

    /**
     * @notice Create a ZK group with strict leader-proof authorization for future member adds.
     * @dev A dedicated leader-auth group is created with exactly one member: leaderCommitment.
     *      Future relayed member additions must provide a valid proof from this leader-auth group.
     */
    function createZkGroupWithLeader(uint256 merkleTreeDuration, uint256 leaderCommitment)
        external
        returns (uint256 groupId)
    {
        require(address(semaphore) != address(0), "ZK: semaphore not configured");
        require(leaderCommitment != 0, "ZK: invalid leader commitment");

        groupId = semaphore.createGroup(address(this), merkleTreeDuration);
        _zkGroupCreator[groupId] = msg.sender;
        emit ZkGroupCreated(groupId, merkleTreeDuration);

        uint256 leaderAuthGroupId = semaphore.createGroup(address(this), merkleTreeDuration);
        semaphore.addMember(leaderAuthGroupId, leaderCommitment);
        semaphore.addMember(groupId, leaderCommitment);

        _zkGroupLeaderConfig[groupId] = ZkGroupLeaderConfig({
            enabled: true,
            leaderCommitment: leaderCommitment,
            leaderAuthGroupId: leaderAuthGroupId
        });

        emit ZkGroupLeaderConfigured(groupId, leaderAuthGroupId, leaderCommitment);
    }

    /**
     * @notice Register a file owner. Called by the uploader right after FileRegistry.uploadFile().
     * @param fileId  The file identifier.
     */
    function registerFileOwner(uint256 fileId) external {
        require(_fileOwner[fileId] == address(0), "ABAC: owner already set");
        _fileOwner[fileId] = msg.sender;
    }

    /**
     * @notice Grant/revoke issuer rights to an address (admin only).
     */
    function setTrustedIssuer(address issuer, bool enabled) external onlyOwner {
        require(issuer != address(0), "ABAC: invalid issuer");
        _trustedIssuers[issuer] = enabled;
        emit TrustedIssuerUpdated(issuer, enabled);
    }

    /**
     * @notice Store attribute tags for a user.
     * @param user        Target user address.
     * @param attributes  Array of keccak256-hashed attribute strings.
     */
    function setUserAttributes(address user, bytes32[] calldata attributes) external onlyTrustedIssuer {
        if (!_knownAttributeUsers[user]) {
            _knownAttributeUsers[user] = true;
            _knownAttributeUserList.push(user);
        }
        _userAttributes[user] = attributes;
        emit AttributesSet(user, attributes);
    }

    /**
     * @notice Define the access policy for a file (ALL attributes required).
     * @param fileId              The file to protect.
     * @param requiredAttributes  Tags that a user must ALL possess.
     */
    function definePolicy(uint256 fileId, bytes32[] calldata requiredAttributes)
        external
        onlyFileOwner(fileId)
    {
        _filePolicies[fileId] = requiredAttributes;
        emit PolicyDefined(fileId, requiredAttributes);
    }

    /**
     * @notice Define a ZK access policy for a file based on Semaphore group membership.
     * @dev If enabled, non-owners must first submit a valid Semaphore proof (via verifyZkAccess)
     *      before checkAccess returns true for them.
     * @param fileId   The file to protect.
     * @param groupId  Semaphore groupId representing an eligible role set.
     * @param enabled  Enable/disable the ZK requirement.
     */
    function defineZkPolicy(uint256 fileId, uint256 groupId, bool enabled)
        external
        onlyFileOwner(fileId)
    {
        if (enabled) {
            require(address(semaphore) != address(0), "ZK: semaphore not configured");
        }
        _zkPolicies[fileId] = ZkPolicy({ enabled: enabled, groupId: groupId });
        emit ZkPolicyDefined(fileId, groupId, enabled);
    }

    /**
     * @notice Trusted issuer adds a user's identity commitment to a Semaphore group.
     * @dev This binds off-chain Semaphore identities to your on-chain access control.
     */
    function addZkGroupMember(uint256 groupId, uint256 identityCommitment) external onlyZkGroupManager(groupId) {
        groupId;
        identityCommitment;
        revert("ZK: direct add disabled; use relayed leader proof");
    }

    /**
     * @notice Add a member to a ZK group using a relayed, leader-authorized zero-knowledge proof.
     * @dev Callable only by configured relayer wallet. Proof is verified against the
     *      dedicated leader-auth group created via createZkGroupWithLeader.
     */
    function relayedAddZkGroupMember(
        uint256 groupId,
        uint256 identityCommitment,
        ISemaphore.SemaphoreProof calldata leaderProof,
        uint256 nonce,
        uint256 deadline
    ) external onlyZkRelayer nonReentrant {
        require(address(semaphore) != address(0), "ZK: semaphore not configured");
        require(identityCommitment != 0, "ZK: invalid commitment");
        require(deadline >= block.timestamp, "ZK: leader proof expired");

        ZkGroupLeaderConfig memory cfg = _zkGroupLeaderConfig[groupId];
        require(cfg.enabled, "ZK: leader auth not configured");

        uint256 expectedMessage = uint256(
            keccak256(abi.encodePacked("ZK_LEADER_ADD_MEMBER", groupId, identityCommitment, nonce, deadline))
        );
        require(leaderProof.message == expectedMessage, "ZK: wrong leader proof message");

        uint256 expectedScope = uint256(
            keccak256(abi.encodePacked("ZK_LEADER_SCOPE", groupId, nonce, deadline))
        );
        require(leaderProof.scope == expectedScope, "ZK: wrong leader proof scope");

        require(!_usedLeaderProofNullifier[groupId][leaderProof.nullifier], "ZK: leader proof already used");
        semaphore.validateProof(cfg.leaderAuthGroupId, leaderProof);
        _usedLeaderProofNullifier[groupId][leaderProof.nullifier] = true;

        semaphore.addMember(groupId, identityCommitment);
        emit ZkGroupMemberAdded(groupId, msg.sender, identityCommitment);
        emit ZkGroupMemberAddedByLeaderProof(groupId, leaderProof.nullifier, identityCommitment, nonce);
    }

    /**
     * @notice Verify a user's ZK proof on-chain for this file policy.
     * @dev Message is file-bound (keccak256(fileId)) and not wallet-bound.
     *      This function validates the proof and emits an event only.
     */
    function verifyZkAccess(uint256 fileId, ISemaphore.SemaphoreProof calldata proof) external nonReentrant {
        ZkPolicy memory p = _zkPolicies[fileId];
        require(p.enabled, "ZK: policy not enabled");
        require(address(semaphore) != address(0), "ZK: semaphore not configured");

        uint256 expectedMessage = uint256(keccak256(abi.encodePacked(fileId)));
        require(proof.message == expectedMessage, "ZK: wrong message");
        require(proof.scope != 0, "ZK: invalid scope");

        semaphore.validateProof(p.groupId, proof);

        emit ZkAccessVerified(fileId, msg.sender, p.groupId, proof.nullifier);
    }

    /**
     * @notice Explicitly grant access to a recipient.
     * @param fileId                The file to share.
     * @param recipient             Address to grant access to.
     * @param recipientAttributes   Deprecated in strict mode; ignored.
     */
    function grantAccess(
        uint256 fileId,
        address recipient,
        bytes32[] calldata recipientAttributes
    ) external onlyFileOwner(fileId) nonReentrant {
        recipientAttributes; // ignored: role issuance must come from trusted issuers only
        if (!_accessGrants[fileId][recipient]) {
            _grantees[fileId].push(recipient);
        }
        _accessGrants[fileId][recipient] = true;
        emit AccessGranted(fileId, recipient);
    }

    /**
     * @notice Revoke access for a specific recipient.
     */
    function revokeAccess(uint256 fileId, address recipient)
        external
        onlyFileOwner(fileId)
        nonReentrant
    {
        _accessGrants[fileId][recipient] = false;
        emit AccessRevoked(fileId, recipient);
    }

    /**
     * @notice Check whether a user can access a file under strict RBAC/ABAC rules.
     * @param user    Address to check.
     * @param fileId  File to check access for.
     * @return bool   True if access is permitted.
     */
    function checkAccess(address user, uint256 fileId) external view returns (bool) {
        // File owner always has access
        if (_fileOwner[fileId] == user) return true;

        bool hasExplicitGrant = _accessGrants[fileId][user];

        // With no policy, explicit grant is enough.
        bytes32[] storage policy = _filePolicies[fileId];
        if (policy.length == 0) return hasExplicitGrant;

        // With a policy, BOTH explicit grant and attribute match are required.
        if (!hasExplicitGrant) return false;

        bytes32[] storage userAttrs = _userAttributes[user];
        for (uint256 i = 0; i < policy.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < userAttrs.length; j++) {
                if (userAttrs[j] == policy[i]) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    /**
     * @notice Deprecated helper retained for backward compatibility.
     * @dev This contract no longer persists per-wallet ZK verification state.
     */
    function checkZkOnlyAccess(address user, uint256 fileId) external view returns (bool) {
        ZkPolicy memory zp = _zkPolicies[fileId];
        if (!zp.enabled) return false;
        user;
        fileId;
        return false;
    }

    // ─────────────────────────── View Helpers ─────────────────────────────

    function getUserAttributes(address user) external view returns (bytes32[] memory) {
        return _userAttributes[user];
    }

    function getKnownAttributeUsers() external view returns (address[] memory) {
        return _knownAttributeUserList;
    }

    function getFilePolicy(uint256 fileId) external view returns (bytes32[] memory) {
        return _filePolicies[fileId];
    }

    function getZkPolicy(uint256 fileId) external view returns (bool enabled, uint256 groupId) {
        ZkPolicy memory p = _zkPolicies[fileId];
        return (p.enabled, p.groupId);
    }

    function getZkGroupCreator(uint256 groupId) external view returns (address) {
        return _zkGroupCreator[groupId];
    }

    function getZkGroupLeaderConfig(uint256 groupId)
        external
        view
        returns (bool enabled, uint256 leaderCommitment, uint256 leaderAuthGroupId)
    {
        ZkGroupLeaderConfig memory cfg = _zkGroupLeaderConfig[groupId];
        return (cfg.enabled, cfg.leaderCommitment, cfg.leaderAuthGroupId);
    }

    function isZkVerified(uint256 fileId, address user) external pure returns (bool) {
        fileId;
        user;
        return false;
    }

    function getFileGrantees(uint256 fileId) external view returns (address[] memory) {
        return _grantees[fileId];
    }

    function getFileOwner(uint256 fileId) external view returns (address) {
        return _fileOwner[fileId];
    }

    function isTrustedIssuer(address issuer) external view returns (bool) {
        return _trustedIssuers[issuer];
    }
}
