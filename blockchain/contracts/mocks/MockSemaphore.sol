// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/**
 * @dev Test-only mock: accepts all proofs and allows adding members.
 *      This is NOT secure and must never be deployed in production.
 */
contract MockSemaphore is ISemaphore {
    mapping(uint256 => bool) public usedNullifiers;

    function groupCounter() external pure override returns (uint256) {
        return 0;
    }

    function createGroup() external pure override returns (uint256) {
        return 0;
    }

    function createGroup(address) external pure override returns (uint256) {
        return 0;
    }

    function createGroup(address, uint256) external pure override returns (uint256) {
        return 0;
    }

    function updateGroupAdmin(uint256, address) external pure override {}

    function acceptGroupAdmin(uint256) external pure override {}

    function updateGroupMerkleTreeDuration(uint256, uint256) external pure override {}

    function addMember(uint256, uint256) external pure override {}

    function addMembers(uint256, uint256[] calldata) external pure override {}

    function updateMember(uint256, uint256, uint256, uint256[] calldata) external pure override {}

    function removeMember(uint256, uint256, uint256[] calldata) external pure override {}

    function validateProof(uint256, SemaphoreProof calldata proof) external override {
        require(!usedNullifiers[proof.nullifier], "MOCK: nullifier used");
        usedNullifiers[proof.nullifier] = true;
    }

    function verifyProof(uint256, SemaphoreProof calldata) external pure override returns (bool) {
        return true;
    }
}

