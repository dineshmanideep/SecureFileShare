// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title GDPRCompliance
 * @notice Handles GDPR right-to-erasure requests entirely on-chain.
 * @dev The contract records erasure requests and allows the file owner (or contract admin)
 *      to fulfil them.  Fulfilled erasure triggers FileRegistry.deleteFile() off-chain
 *      (orchestrated by the backend).
 */
contract GDPRCompliance is Ownable, ReentrancyGuard {
    // ─────────────────────────────── State ───────────────────────────────

    uint256 private _nextRequestId;

    struct EraseRequest {
        address requester;
        uint256 fileId;
        uint256 requestTimestamp;
        bool fulfilled;
    }

    /// @dev requestId => EraseRequest
    mapping(uint256 => EraseRequest) private _requests;

    /// @dev fileId => requestId  (one active request per file)
    mapping(uint256 => uint256) private _fileRequest;

    /// @dev user => fileIds they have uploaded (for GDPR Article 20 data export)
    mapping(address => uint256[]) private _userFiles;

    /// @dev fileId => owner (set when registering)
    mapping(uint256 => address) private _fileOwner;

    // ─────────────────────────────── Events ──────────────────────────────

    event ErasureRequested(
        uint256 indexed requestId,
        address indexed requester,
        uint256 indexed fileId,
        uint256 timestamp
    );
    event ErasureFulfilled(
        uint256 indexed requestId,
        uint256 indexed fileId,
        uint256 timestamp
    );

    // ─────────────────────────────── Functions ────────────────────────────

    /**
     * @notice Register a file for this user so the GDPR module tracks it.
     * @param fileId  The file identifier.
     */
    function registerFile(uint256 fileId) external {
        require(_fileOwner[fileId] == address(0), "GDPR: file already registered");
        _fileOwner[fileId] = msg.sender;
        _userFiles[msg.sender].push(fileId);
    }

    /**
     * @notice Request erasure of a specific file (right to be forgotten).
     * @param fileId  The file the caller wishes to have erased.
     * @return requestId  Assigned request identifier.
     */
    function requestErasure(uint256 fileId)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        require(_fileOwner[fileId] == msg.sender, "GDPR: only file owner can request erasure");
        require(!_requests[_fileRequest[fileId]].fulfilled, "GDPR: already erased");

        requestId = _nextRequestId++;
        _requests[requestId] = EraseRequest({
            requester: msg.sender,
            fileId: fileId,
            requestTimestamp: block.timestamp,
            fulfilled: false
        });
        _fileRequest[fileId] = requestId;

        emit ErasureRequested(requestId, msg.sender, fileId, block.timestamp);
    }

    /**
     * @notice Mark an erasure request as fulfilled.
     *         Called by the backend after IPFS unpin + FileRegistry deletion.
     * @param fileId  The file that has been erased.
     */
    function fulfillErasure(uint256 fileId) external nonReentrant {
        uint256 requestId = _fileRequest[fileId];
        EraseRequest storage req = _requests[requestId];

        require(req.requestTimestamp != 0, "GDPR: no erasure request found");
        require(!req.fulfilled, "GDPR: already fulfilled");
        require(
            msg.sender == req.requester || msg.sender == owner(),
            "GDPR: not authorised"
        );

        req.fulfilled = true;
        emit ErasureFulfilled(requestId, fileId, block.timestamp);
    }

    /**
     * @notice Check whether the erasure for a given file has been fulfilled.
     * @param fileId  The file to query.
     */
    function getErasureStatus(uint256 fileId) external view returns (bool fulfilled) {
        uint256 requestId = _fileRequest[fileId];
        return _requests[requestId].fulfilled;
    }

    /**
     * @notice GDPR Article 20: export all fileIds associated with a user.
     * @param user  The data subject.
     * @return fileIds  List of file identifiers owned by the user.
     */
    function exportUserData(address user) external view returns (uint256[] memory fileIds) {
        return _userFiles[user];
    }

    /**
     * @notice Retrieve the full erasure request record.
     */
    function getErasureRequest(uint256 requestId)
        external
        view
        returns (EraseRequest memory)
    {
        return _requests[requestId];
    }

    /**
     * @notice Get the erasure request id for a file.
     */
    function getFileRequestId(uint256 fileId) external view returns (uint256) {
        return _fileRequest[fileId];
    }
}
