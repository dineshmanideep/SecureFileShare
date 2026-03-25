// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title FileRegistry
 * @notice Stores IPFS CIDs and file metadata on-chain for decentralised secure file sharing.
 * @dev Each file has a unique auto-incremented fileId. Owners can soft-delete their files.
 */
contract FileRegistry is Ownable, ReentrancyGuard {
    // ─────────────────────────────── State ───────────────────────────────

    uint256 private _nextFileId;

    struct FileRecord {
        address owner;
        string[] cids;      // Chunked CIDs from IPFS
        bytes32 fileHash;   // SHA-256 of original file
        uint256 timestamp;
        bool isDeleted;
        string fileName;
        uint256 fileSize;
    }

    /// @dev fileId => FileRecord
    mapping(uint256 => FileRecord) private _files;

    /// @dev owner => list of fileIds
    mapping(address => uint256[]) private _ownerFiles;

    // ─────────────────────────────── Events ──────────────────────────────

    event FileUploaded(
        uint256 indexed fileId,
        address indexed owner,
        string[] cids,
        bytes32 fileHash,
        string fileName,
        uint256 timestamp
    );

    event FileDeleted(
        uint256 indexed fileId,
        address indexed owner,
        uint256 timestamp
    );

    // ─────────────────────────────── Functions ────────────────────────────

    /**
     * @notice Register a new file on-chain after uploading chunks to IPFS.
     * @param cids       Array of IPFS CIDs for each encrypted chunk.
     * @param fileHash   SHA-256 hash of the original plaintext file.
     * @param fileName   Original filename (stored for display purposes).
     * @param fileSize   Original file size in bytes.
     * @return fileId    The newly assigned file identifier.
     */
    function uploadFile(
        string[] calldata cids,
        bytes32 fileHash,
        string calldata fileName,
        uint256 fileSize
    ) external nonReentrant returns (uint256 fileId) {
        require(cids.length > 0, "FileRegistry: no CIDs provided");
        require(bytes(fileName).length > 0, "FileRegistry: empty filename");

        fileId = _nextFileId++;

        _files[fileId] = FileRecord({
            owner: msg.sender,
            cids: cids,
            fileHash: fileHash,
            timestamp: block.timestamp,
            isDeleted: false,
            fileName: fileName,
            fileSize: fileSize
        });

        _ownerFiles[msg.sender].push(fileId);

        emit FileUploaded(fileId, msg.sender, cids, fileHash, fileName, block.timestamp);
    }

    /**
     * @notice Retrieve file metadata. Caller must be owner or have access granted by AccessControl.
     * @param fileId The file to retrieve.
     */
    function getFile(uint256 fileId)
        external
        view
        returns (
            address owner,
            string[] memory cids,
            bytes32 fileHash,
            uint256 timestamp,
            bool isDeleted,
            string memory fileName,
            uint256 fileSize
        )
    {
        FileRecord storage f = _files[fileId];
        require(f.timestamp != 0, "FileRegistry: file does not exist");
        return (f.owner, f.cids, f.fileHash, f.timestamp, f.isDeleted, f.fileName, f.fileSize);
    }

    /**
     * @notice Soft-delete a file. Only the owner or the contract owner can call this.
     * @param fileId The file to mark as deleted.
     */
    function deleteFile(uint256 fileId) external nonReentrant {
        FileRecord storage f = _files[fileId];
        require(f.timestamp != 0, "FileRegistry: file does not exist");
        require(
            msg.sender == f.owner || msg.sender == owner(),
            "FileRegistry: not authorised"
        );
        require(!f.isDeleted, "FileRegistry: already deleted");

        f.isDeleted = true;
        emit FileDeleted(fileId, f.owner, block.timestamp);
    }

    /**
     * @notice List all fileIds owned by a given address.
     */
    function getOwnerFiles(address user) external view returns (uint256[] memory) {
        return _ownerFiles[user];
    }

    /**
     * @notice Returns the total number of files ever registered.
     */
    function totalFiles() external view returns (uint256) {
        return _nextFileId;
    }
}
