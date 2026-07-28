// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {AgentPayAccountV3} from "./AgentPayAccountV3.sol";

/// @title AgentPayAccountV3ProxyFactory
/// @notice Deploys AgentPayAccountV3 accounts as ERC-1967 proxies at
///         deterministic addresses.
/// @dev The factory itself is intentionally NOT upgradeable. Its only job is to
///      create proxies; making it upgradeable would add an authority that can
///      change how every future account is created, for no benefit. Accounts
///      are upgradeable individually through their own UPGRADER_ROLE.
///
///      The implementation address is immutable here on purpose: this contract
///      is deployed directly rather than behind a proxy, so an immutable is
///      read from its own bytecode and is correct. Pinning it means the factory
///      cannot be steered to deploy proxies pointing at some other code.
contract AgentPayAccountV3ProxyFactory is AccessControl {
    error ZeroAddress();
    error ImplementationMustBeContract();
    error AccountAlreadyDeployed(address account);

    event AccountDeployed(
        address indexed account, address indexed owner, address indexed executor, bytes32 salt
    );

    bytes32 public constant DEPLOYER_ROLE = keccak256("AGENTPAY_FACTORY_DEPLOYER_ROLE");

    /// @notice The pinned AgentPayAccountV3 implementation every proxy points at.
    address public immutable implementation;

    /// @dev Grouped so the deploy path stays within the EVM stack limit and so
    ///      callers cannot silently transpose two same-typed addresses.
    struct AccountInit {
        address defaultAdmin;
        address owner;
        address executor;
        address upgrader;
        address[] allowedTokens;
        address[] allowedRouteTargets;
    }

    constructor(address defaultAdmin, address initialDeployer, address accountImplementation) {
        if (defaultAdmin == address(0) || initialDeployer == address(0) || accountImplementation == address(0)) {
            revert ZeroAddress();
        }
        if (accountImplementation.code.length == 0) revert ImplementationMustBeContract();

        implementation = accountImplementation;
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(DEPLOYER_ROLE, initialDeployer);
    }

    /// @notice Deploys and initializes one account proxy.
    /// @dev Initialization is passed to the proxy constructor rather than made
    ///      as a follow-up call, so there is no window in which the account
    ///      exists uninitialized and open to being claimed by whoever calls
    ///      `initialize` first.
    function deployAccount(bytes32 salt, AccountInit calldata init)
        external
        onlyRole(DEPLOYER_ROLE)
        returns (address account)
    {
        account = predictAccountAddress(salt, init);
        if (account.code.length != 0) revert AccountAlreadyDeployed(account);

        address deployed = address(new ERC1967Proxy{salt: salt}(implementation, _initData(init)));
        assert(deployed == account);

        emit AccountDeployed(deployed, init.owner, init.executor, salt);
    }

    /// @notice Computes the address `deployAccount` would produce.
    /// @dev The init data is part of the creation code, so the predicted
    ///      address covers the initialization arguments too. Two different
    ///      owners cannot collide on one salt.
    function predictAccountAddress(bytes32 salt, AccountInit calldata init) public view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, _initData(init)))
        );

        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }

    function _initData(AccountInit calldata init) private pure returns (bytes memory) {
        return abi.encodeCall(
            AgentPayAccountV3.initialize,
            (init.defaultAdmin, init.owner, init.executor, init.upgrader, init.allowedTokens, init.allowedRouteTargets)
        );
    }
}
