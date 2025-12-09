// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Bribe} from "./Bribe.sol";

/**
 * @title BribeFactory
 * @author heesho
 * @notice Factory for deploying Bribe contracts. Used by Voter.addStrategy() to create bribes for new strategies.
 */
contract BribeFactory {

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    address public lastBribe;  // most recently created bribe (for verification)

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event BribeFactory__BribeCreated(address indexed bribe, address indexed voter);

    /*//////////////////////////////////////////////////////////////
                          FACTORY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploys a new Bribe contract
    /// @param _voter The Voter contract that will control the bribe
    /// @return bribe Address of the newly deployed Bribe
    function createBribe(address _voter) external returns (address bribe) {
        Bribe bribeContract = new Bribe(_voter);
        bribe = address(bribeContract);
        lastBribe = bribe;
        emit BribeFactory__BribeCreated(bribe, _voter);
    }
}
