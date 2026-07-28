// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {AgentPayAccountV3} from "../src/AgentPayAccountV3.sol";
import {AgentPayAccountV3ProxyFactory} from "../src/AgentPayAccountV3ProxyFactory.sol";
import {MockStablecoin} from "../src/MockStablecoin.sol";

contract AgentPayAccountV3ProxyFactoryTest is Test {
    AgentPayAccountV3ProxyFactory internal factory;
    AgentPayAccountV3 internal implementation;
    MockStablecoin internal token;

    address internal admin = address(0xAD);
    address internal deployer = address(0xDE);
    uint256 internal ownerKey = 0xA11CE;
    address internal owner = vm.addr(0xA11CE);
    address internal executor = address(0xE1);
    address internal upgrader = address(0x11);

    address[] internal tokens;
    address[] internal routes;

    uint256 internal deadline;

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Owner authorization over the exact policy being deployed.
    function _auth(bytes32 salt, AgentPayAccountV3ProxyFactory.AccountInit memory init)
        internal
        view
        returns (bytes memory)
    {
        address predicted = factory.predictAccountAddress(salt, init);
        return _sign(ownerKey, factory.hashAccountSetup(salt, init, predicted, deadline));
    }

    /// All factory reads happen before the prank: a view call to the factory
    /// would consume it, and the deploy would run as the test contract.
    function _deploy(bytes32 salt) internal returns (address) {
        AgentPayAccountV3ProxyFactory.AccountInit memory init = _init();
        bytes memory auth = _auth(salt, init);
        vm.prank(deployer);
        return factory.deployAccount(salt, init, deadline, auth);
    }

    function _init() internal view returns (AgentPayAccountV3ProxyFactory.AccountInit memory) {
        return AgentPayAccountV3ProxyFactory.AccountInit({
            defaultAdmin: admin,
            owner: owner,
            executor: executor,
            upgrader: upgrader,
            allowedTokens: tokens,
            allowedRouteTargets: routes
        });
    }

    function setUp() public {
        token = new MockStablecoin("Mock USD", "mUSD", 6, address(this));
        implementation = new AgentPayAccountV3();
        factory = new AgentPayAccountV3ProxyFactory(admin, deployer, address(implementation));
        tokens.push(address(token));
        deadline = block.timestamp + 1 hours;
    }

    function test_deploysAnInitializedProxy() public {
        address account = _deploy(bytes32("salt-1"));

        AgentPayAccountV3 deployed = AgentPayAccountV3(payable(account));
        assertTrue(deployed.hasRole(deployed.OWNER_ROLE(), owner));
        assertTrue(deployed.hasRole(deployed.EXECUTOR_ROLE(), executor));
        assertTrue(deployed.hasRole(deployed.UPGRADER_ROLE(), upgrader));
        assertTrue(deployed.allowedTokens(address(token)));
    }

    function test_accountIsInitializedAtomicallySoItCannotBeClaimed() public {
        // Initializing in the proxy constructor leaves no window where the
        // account exists uninitialized and the first caller takes admin.
        address account = _deploy(bytes32("salt-2"));

        address[] memory empty = new address[](0);
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        AgentPayAccountV3(payable(account)).initialize(address(0xDEAD), owner, executor, address(0xDEAD), empty, empty);
    }

    function test_predictedAddressMatchesTheDeployedOne() public {
        address predicted = factory.predictAccountAddress(bytes32("salt-3"), _init());

        address account = _deploy(bytes32("salt-3"));

        assertEq(account, predicted);
    }

    function test_predictionCoversInitializationArgumentsNotJustTheSalt() public view {
        address forOwner = factory.predictAccountAddress(bytes32("shared"), _init());
        AgentPayAccountV3ProxyFactory.AccountInit memory other = _init();
        other.owner = vm.addr(0xB0B);
        address forOther = factory.predictAccountAddress(bytes32("shared"), other);

        assertTrue(forOwner != forOther, "two owners must not collide on one salt");
    }

    function test_onlyDeployerRoleMayDeploy() public {
        AgentPayAccountV3ProxyFactory.AccountInit memory init = _init();
        bytes memory auth = _auth(bytes32("salt-4"), init);

        vm.expectRevert();
        vm.prank(address(0xDEAD));
        factory.deployAccount(bytes32("salt-4"), init, deadline, auth);
    }

    function test_redeployingTheSameSaltReverts() public {
        _deploy(bytes32("salt-5"));

        AgentPayAccountV3ProxyFactory.AccountInit memory init = _init();
        bytes memory auth = _auth(bytes32("salt-5"), init);
        vm.expectRevert();
        vm.prank(deployer);
        factory.deployAccount(bytes32("salt-5"), init, deadline, auth);
    }

    function test_constructorRejectsZeroAddressesAndNonContractImplementation() public {
        vm.expectRevert(AgentPayAccountV3ProxyFactory.ZeroAddress.selector);
        new AgentPayAccountV3ProxyFactory(address(0), deployer, address(implementation));

        vm.expectRevert(AgentPayAccountV3ProxyFactory.ImplementationMustBeContract.selector);
        new AgentPayAccountV3ProxyFactory(admin, deployer, address(0xC0FFEE));
    }

    function test_everyAccountSharesThePinnedImplementation() public {
        address first = _deploy(bytes32("a"));
        address second = _deploy(bytes32("b"));

        assertTrue(first != second);
        assertEq(factory.implementation(), address(implementation));
    }

    // ---------------------------------------------------------------
    // Review findings, as regressions
    // ---------------------------------------------------------------

    function test_deployerCannotCreateAnAccountForAVictimWithoutTheirSignature() public {
        // The reported drain: a compromised deployer names a victim as owner,
        // keeps DEFAULT_ADMIN_ROLE, then grants itself OWNER_ROLE and withdraws.
        AgentPayAccountV3ProxyFactory.AccountInit memory hostile = _init();
        hostile.defaultAdmin = address(0xBAD);
        bytes memory authForCleanPolicy = _auth(bytes32("victim"), _init());

        vm.expectRevert(AgentPayAccountV3ProxyFactory.InvalidOwnerAuthorization.selector);
        vm.prank(deployer);
        factory.deployAccount(bytes32("victim"), hostile, deadline, authForCleanPolicy);
    }

    function test_ownerSignatureIsBoundToEveryInitializationField() public {
        bytes32 salt = bytes32("bound");
        AgentPayAccountV3ProxyFactory.AccountInit memory signed = _init();
        bytes memory auth = _auth(salt, signed);

        // Each mutation must invalidate the signature on its own.
        AgentPayAccountV3ProxyFactory.AccountInit memory tampered = _init();
        tampered.upgrader = address(0xBAD);
        vm.expectRevert();
        vm.prank(deployer);
        factory.deployAccount(salt, tampered, deadline, auth);

        AgentPayAccountV3ProxyFactory.AccountInit memory tampered2 = _init();
        tampered2.executor = address(0xBAD);
        vm.expectRevert();
        vm.prank(deployer);
        factory.deployAccount(salt, tampered2, deadline, auth);

        // A different salt changes the predicted account, so the same signature
        // cannot be reused for a second deployment.
        vm.expectRevert();
        vm.prank(deployer);
        factory.deployAccount(bytes32("other"), signed, deadline, auth);
    }

    function test_rejectsAnExpiredAuthorization() public {
        bytes32 salt = bytes32("stale");
        AgentPayAccountV3ProxyFactory.AccountInit memory init = _init();
        bytes memory auth = _auth(salt, init);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccountV3ProxyFactory.AuthorizationExpired.selector, deadline));
        vm.prank(deployer);
        factory.deployAccount(salt, init, deadline, auth);
    }

    function test_rejectsASignatureFromAnyoneOtherThanTheNamedOwner() public {
        bytes32 salt = bytes32("stranger");
        AgentPayAccountV3ProxyFactory.AccountInit memory init = _init();
        address predicted = factory.predictAccountAddress(salt, init);
        bytes memory strangerSig = _sign(0xB0B, factory.hashAccountSetup(salt, init, predicted, deadline));

        vm.expectRevert(AgentPayAccountV3ProxyFactory.InvalidOwnerAuthorization.selector);
        vm.prank(deployer);
        factory.deployAccount(salt, init, deadline, strangerSig);
    }

    function test_rejectsANonUUPSImplementation() public {
        // Code length alone accepted a fallback-only contract, and the proxy's
        // initialization delegatecall silently succeeded against it.
        AcceptAllImplementation rogue = new AcceptAllImplementation();

        vm.expectRevert(AgentPayAccountV3ProxyFactory.ImplementationNotUUPS.selector);
        new AgentPayAccountV3ProxyFactory(admin, deployer, address(rogue));
    }

    function test_rejectsAnImplementationWithTheWrongProxiableUUID() public {
        WrongUuidImplementation wrong = new WrongUuidImplementation();

        vm.expectRevert(AgentPayAccountV3ProxyFactory.ImplementationNotUUPS.selector);
        new AgentPayAccountV3ProxyFactory(admin, deployer, address(wrong));
    }
}

/// Swallows any call, including the proxy's initialization delegatecall.
contract AcceptAllImplementation {
    fallback() external payable {}
}

contract WrongUuidImplementation {
    function proxiableUUID() external pure returns (bytes32) {
        return keccak256("not-the-erc1967-slot");
    }
}
