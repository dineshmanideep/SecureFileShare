// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title TimeBoundPermissions
 * @notice Grants time-limited access to files. Access automatically expires at a
 *         Unix timestamp that is checked via `block.timestamp`.
 */
contract TimeBoundPermissions is Ownable, ReentrancyGuard {
    // ─────────────────────────────── State ───────────────────────────────

    struct Permission {
        address user;
        uint256 fileId;
        uint256 expiryTimestamp;
        bool isActive;
    }

    /// @dev permissionId => Permission
    mapping(uint256 => Permission) private _permissions;

    /// @dev user => fileId => permissionId  (one active permission per user-file pair)
    mapping(address => mapping(uint256 => uint256)) private _userFilePermission;

    /// @dev fileId => list of permissionIds
    mapping(uint256 => uint256[]) private _filePermissions;

    /// @dev owner of each file (set by granter when calling grantTimedAccess)
    mapping(uint256 => address) private _fileOwner;

    uint256 private _nextPermissionId;

    // ─────────────────────────────── Events ──────────────────────────────

    event TimedAccessGranted(
        uint256 indexed permissionId,
        address indexed user,
        uint256 indexed fileId,
        uint256 expiryTimestamp
    );
    event AccessRevoked(uint256 indexed permissionId, address indexed user, uint256 indexed fileId);
    event AccessExtended(uint256 indexed permissionId, uint256 newExpiry);

    // ─────────────────────────────── Modifiers ───────────────────────────

    modifier onlyFileOwner(uint256 fileId) {
        require(_fileOwner[fileId] == msg.sender, "TBP: caller is not file owner");
        _;
    }

    // ─────────────────────────────── Functions ────────────────────────────

    /**
     * @notice Register a file owner so they can grant timed access.
     */
    function registerFileOwner(uint256 fileId) external {
        require(_fileOwner[fileId] == address(0), "TBP: owner already set");
        _fileOwner[fileId] = msg.sender;
    }

    /**
     * @notice Grant `user` timed access to `fileId` for `durationSeconds` from now.
     * @param user            Recipient of the timed access.
     * @param fileId          File to grant access to.
     * @param durationSeconds How long (in seconds) the permission should stay valid.
     * @return permissionId   The ID of the new permission record.
     */
    function grantTimedAccess(
        address user,
        uint256 fileId,
        uint256 durationSeconds
    ) external onlyFileOwner(fileId) nonReentrant returns (uint256 permissionId) {
        require(user != address(0), "TBP: zero address");
        require(durationSeconds > 0, "TBP: duration must be positive");

        permissionId = _nextPermissionId++;
        uint256 expiry = block.timestamp + durationSeconds;

        _permissions[permissionId] = Permission({
            user: user,
            fileId: fileId,
            expiryTimestamp: expiry,
            isActive: true
        });

        _userFilePermission[user][fileId] = permissionId;
        _filePermissions[fileId].push(permissionId);

        emit TimedAccessGranted(permissionId, user, fileId, expiry);
    }

    /**
     * @notice Check whether a user's timed access is still valid.
     * @return bool  True if access is active and not expired.
     */
    function isAccessValid(address user, uint256 fileId) external view returns (bool) {
        uint256 permId = _userFilePermission[user][fileId];
        Permission storage p = _permissions[permId];
        return p.isActive && block.timestamp <= p.expiryTimestamp;
    }

    /**
     * @notice Revoke all expired permissions for a given file.
     * @param fileId  The file whose permissions to clean up.
     */
    function revokeExpiredPermissions(uint256 fileId) external {
        uint256[] storage ids = _filePermissions[fileId];
        for (uint256 i = 0; i < ids.length; i++) {
            Permission storage p = _permissions[ids[i]];
            if (p.isActive && block.timestamp > p.expiryTimestamp) {
                p.isActive = false;
                emit AccessRevoked(ids[i], p.user, fileId);
            }
        }
    }

    /**
     * @notice Extend an existing active permission.
     * @param user              The user whose permission to extend.
     * @param fileId            The file.
     * @param additionalSeconds Seconds to add to the current expiry.
     */
    function extendAccess(
        address user,
        uint256 fileId,
        uint256 additionalSeconds
    ) external onlyFileOwner(fileId) nonReentrant {
        uint256 permId = _userFilePermission[user][fileId];
        Permission storage p = _permissions[permId];
        require(p.isActive, "TBP: permission not active");
        p.expiryTimestamp += additionalSeconds;
        emit AccessExtended(permId, p.expiryTimestamp);
    }

    /**
     * @notice Manually revoke a specific permission (file owner only).
     */
    function revokePermission(address user, uint256 fileId)
        external
        onlyFileOwner(fileId)
        nonReentrant
    {
        uint256 permId = _userFilePermission[user][fileId];
        Permission storage p = _permissions[permId];
        require(p.isActive, "TBP: permission not active");
        p.isActive = false;
        emit AccessRevoked(permId, user, fileId);
    }

    // ─────────────────────────── View Helpers ─────────────────────────────

    function getPermission(uint256 permissionId) external view returns (Permission memory) {
        return _permissions[permissionId];
    }

    function getPermissionForUserFile(address user, uint256 fileId)
        external
        view
        returns (Permission memory)
    {
        uint256 permId = _userFilePermission[user][fileId];
        return _permissions[permId];
    }

    function getFilePermissions(uint256 fileId)
        external
        view
        returns (uint256[] memory)
    {
        return _filePermissions[fileId];
    }

    function getFileOwner(uint256 fileId) external view returns (address) {
        return _fileOwner[fileId];
    }
}
