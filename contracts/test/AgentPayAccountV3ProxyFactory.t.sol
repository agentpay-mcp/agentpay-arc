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
    address internal owner = vm.addr(0xA11CE);
    address internal executor = address(0xE1);
    address internal upgrader = address(0x11);

    address[] internal tokens;
    address[] internal routes;

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
    }

    function test_deploysAnInitializedProxy() public {
        vm.prank(deployer);
        address account =
            factory.deployAccount(bytes32("salt-1"), _init());

        AgentPayAccountV3 deployed = AgentPayAccountV3(payable(account));
        assertTrue(deployed.hasRole(deployed.OWNER_ROLE(), owner));
        assertTrue(deployed.hasRole(deployed.EXECUTOR_ROLE(), executor));
        assertTrue(deployed.hasRole(deployed.UPGRADER_ROLE(), upgrader));
        assertTrue(deployed.allowedTokens(address(token)));
    }

    function test_accountIsInitializedAtomicallySoItCannotBeClaimed() public {
        // Initializing in the proxy constructor leaves no window where the
        // account exists uninitialized and the first caller takes admin.
        vm.prank(deployer);
        address account =
            factory.deployAccount(bytes32("salt-2"), _init());

        address[] memory empty = new address[](0);
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        AgentPayAccountV3(payable(account)).initialize(
            address(0xDEAD), owner, executor, address(0xDEAD), empty, empty
        );
    }

    function test_predictedAddressMatchesTheDeployedOne() public {
        address predicted =
            factory.predictAccountAddress(bytes32("salt-3"), _init());

        vm.prank(deployer);
        address account =
            factory.deployAccount(bytes32("salt-3"), _init());

        assertEq(account, predicted);
    }

    function test_predictionCoversInitializationArgumentsNotJustTheSalt() public view {
        address forOwner =
            factory.predictAccountAddress(bytes32("shared"), _init());
        AgentPayAccountV3ProxyFactory.AccountInit memory other = _init();
        other.owner = vm.addr(0xB0B);
        address forOther = factory.predictAccountAddress(bytes32("shared"), other);

        assertTrue(forOwner != forOther, "two owners must not collide on one salt");
    }

    function test_onlyDeployerRoleMayDeploy() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        factory.deployAccount(bytes32("salt-4"), _init());
    }

    function test_redeployingTheSameSaltReverts() public {
        vm.prank(deployer);
        factory.deployAccount(bytes32("salt-5"), _init());

        vm.prank(deployer);
        vm.expectRevert();
        factory.deployAccount(bytes32("salt-5"), _init());
    }

    function test_constructorRejectsZeroAddressesAndNonContractImplementation() public {
        vm.expectRevert(AgentPayAccountV3ProxyFactory.ZeroAddress.selector);
        new AgentPayAccountV3ProxyFactory(address(0), deployer, address(implementation));

        vm.expectRevert(AgentPayAccountV3ProxyFactory.ImplementationMustBeContract.selector);
        new AgentPayAccountV3ProxyFactory(admin, deployer, address(0xC0FFEE));
    }

    function test_everyAccountSharesThePinnedImplementation() public {
        vm.startPrank(deployer);
        address first = factory.deployAccount(bytes32("a"), _init());
        address second = factory.deployAccount(bytes32("b"), _init());
        vm.stopPrank();

        assertTrue(first != second);
        assertEq(factory.implementation(), address(implementation));
    }
}
