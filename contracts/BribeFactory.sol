// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./Bribe.sol";

/**
 * @title BribeFactory
 * @author heesho
 *
 * @notice Simple factory for creating Bribe contracts.
 *
 * @dev This is a stateless deployment utility:
 *      - Anyone can call createBribe() to deploy a new Bribe
 *      - No access control - the Voter contract uses this when adding strategies
 *      - Tracks lastBribe for convenience (e.g., verification after deployment)
 *
 * Used by Voter.addStrategy() to create a Bribe for each new strategy.
 */
contract BribeFactory {
    /*----------  STATE VARIABLES  --------------------------------------*/

    /// @notice Address of the most recently created Bribe contract
    /// @dev Useful for verification after deployment
    address public lastBribe;

    /*----------  EVENTS ------------------------------------------------*/

    event BribeFactory__BribeCreated(address indexed bribe, address indexed voter);

    /*----------  FACTORY FUNCTIONS  ------------------------------------*/

    /**
     * @notice Deploy a new Bribe contract
     * @param _voter The Voter contract that will control the new Bribe
     * @return bribe The address of the newly deployed Bribe contract
     *
     * @dev The new Bribe will:
     *      - Only accept _deposit/_withdraw calls from _voter
     *      - Only accept addReward calls from _voter
     *      - Allow anyone to call notifyRewardAmount and getReward
     */
    function createBribe(address _voter) external returns (address bribe) {
        // Deploy new Bribe with voter as controller
        Bribe bribeContract = new Bribe(_voter);
        bribe = address(bribeContract);

        // Track for convenience
        lastBribe = bribe;

        emit BribeFactory__BribeCreated(bribe, _voter);
    }
}
