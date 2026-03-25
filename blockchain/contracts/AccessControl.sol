// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

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

    // ─────────────────────────────── Events ──────────────────────────────

    event AttributesSet(address indexed user, bytes32[] attributes);
    event PolicyDefined(uint256 indexed fileId, bytes32[] requiredAttributes);
    event AccessGranted(uint256 indexed fileId, address indexed recipient);
    event AccessRevoked(uint256 indexed fileId, address indexed recipient);
    event TrustedIssuerUpdated(address indexed issuer, bool enabled);

    // ─────────────────────────────── Modifiers ───────────────────────────

    modifier onlyFileOwner(uint256 fileId) {
        require(_fileOwner[fileId] == msg.sender, "ABAC: caller is not file owner");
        _;
    }

    modifier onlyTrustedIssuer() {
        require(_trustedIssuers[msg.sender], "ABAC: caller is not a trusted issuer");
        _;
    }

    constructor() {
        _trustedIssuers[msg.sender] = true;
        emit TrustedIssuerUpdated(msg.sender, true);
    }

    // ─────────────────────────────── Functions ────────────────────────────

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

    // ─────────────────────────── View Helpers ─────────────────────────────

    function getUserAttributes(address user) external view returns (bytes32[] memory) {
        return _userAttributes[user];
    }

    function getFilePolicy(uint256 fileId) external view returns (bytes32[] memory) {
        return _filePolicies[fileId];
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
