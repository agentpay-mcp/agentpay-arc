// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {AgentPayAccountV3} from "../src/AgentPayAccountV3.sol";
import {MockStablecoin} from "../src/MockStablecoin.sol";

/// Minimal second implementation used only to prove upgrade authorization.
contract AgentPayAccountV3Next is AgentPayAccountV3 {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// An implementation with no `_authorizeUpgrade` guard would let anyone swap
/// code. This one is never wired in; it exists so the tests can show the
/// difference is enforced rather than assumed.
contract RogueImplementation {
    function version() external pure returns (uint256) {
        return 666;
    }
}

contract AgentPayAccountV3Test is Test {
    AgentPayAccountV3 internal account;
    AgentPayAccountV3 internal implementation;
    MockStablecoin internal token;

    uint256 internal ownerKey = 0xA11CE;
    uint256 internal strangerKey = 0xB0B;
    address internal owner;
    address internal executor = address(0xE1);
    address internal admin = address(0xAD);
    address internal upgrader = address(0x11);
    address internal recipient = address(0xBEEF);

    function setUp() public {
        owner = vm.addr(ownerKey);
        token = new MockStablecoin("Mock USD", "mUSD", 6, address(this));
        implementation = new AgentPayAccountV3();

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        address[] memory routes = new address[](0);

        bytes memory data =
            abi.encodeCall(AgentPayAccountV3.initialize, (admin, owner, executor, upgrader, tokens, routes));
        account = AgentPayAccountV3(payable(address(new ERC1967Proxy(address(implementation), data))));

        token.mint(address(account), 1_000e6);
    }

    // ---------------------------------------------------------------
    // UUPS lifecycle — the findings that recur across audit reports
    // ---------------------------------------------------------------

    function test_implementationCannotBeInitializedDirectly() public {
        // The classic finding: an implementation left uninitialized can be
        // seized by anyone, who then controls upgrades for every proxy in front
        // of it. The constructor calls _disableInitializers to prevent it.
        address[] memory empty = new address[](0);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(admin, owner, executor, upgrader, empty, empty);
    }

    function test_proxyCannotBeInitializedTwice() public {
        address[] memory empty = new address[](0);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        account.initialize(admin, owner, executor, upgrader, empty, empty);
    }

    function test_onlyUpgraderCanUpgrade() public {
        AgentPayAccountV3Next next = new AgentPayAccountV3Next();
        // Read the role before pranking: a view call to the account would
        // itself consume the prank.
        bytes32 upgraderRole = account.UPGRADER_ROLE();

        address[3] memory unauthorized = [owner, executor, admin];
        for (uint256 i = 0; i < unauthorized.length; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized[i], upgraderRole
                )
            );
            vm.prank(unauthorized[i]);
            account.upgradeToAndCall(address(next), "");
        }

        vm.prank(upgrader);
        account.upgradeToAndCall(address(next), "");
        assertEq(AgentPayAccountV3Next(payable(address(account))).version(), 2);
    }

    function test_ownerRoleAloneCannotUpgrade() public {
        // Moving funds and replacing the code that governs how funds move are
        // deliberately different powers.
        AgentPayAccountV3Next next = new AgentPayAccountV3Next();

        assertTrue(account.hasRole(account.OWNER_ROLE(), owner));
        assertFalse(account.hasRole(account.UPGRADER_ROLE(), owner));

        vm.expectRevert();
        account.upgradeToAndCall(address(next), "");
    }

    function test_upgradeToZeroAddressIsRejected() public {
        vm.prank(upgrader);
        vm.expectRevert(AgentPayAccountV3.UpgradeToZeroAddress.selector);
        account.upgradeToAndCall(address(0), "");
    }

    function test_upgradePreservesStateAndBalance() public {
        vm.prank(owner);
        account.pause();

        AgentPayAccountV3Next next = new AgentPayAccountV3Next();
        vm.prank(upgrader);
        account.upgradeToAndCall(address(next), "");

        assertTrue(account.paused(), "storage must survive the upgrade");
        assertTrue(account.allowedTokens(address(token)));
        assertEq(token.balanceOf(address(account)), 1_000e6);
    }

    function test_rogueImplementationCannotBeInstalledByAnyone() public {
        RogueImplementation rogue = new RogueImplementation();

        vm.prank(address(0xDEAD));
        vm.expectRevert();
        account.upgradeToAndCall(address(rogue), "");
    }

    // ---------------------------------------------------------------
    // Storage layout behind a proxy
    // ---------------------------------------------------------------

    function test_rolesLiveInProxyStorageNotImplementation() public view {
        // This is why the immutable owner had to go: values baked into the
        // implementation's bytecode are invisible to the proxy's storage.
        assertTrue(account.hasRole(account.OWNER_ROLE(), owner));
        assertFalse(implementation.hasRole(implementation.OWNER_ROLE(), owner));
    }

    function test_domainSeparatorBindsToProxyNotImplementation() public view {
        bytes32 expected = keccak256(
            abi.encode(
                account.EIP712_DOMAIN_TYPEHASH(), keccak256("AgentPay"), keccak256("1"), block.chainid, address(account)
            )
        );
        assertEq(account.domainSeparator(), expected);
        assertTrue(account.domainSeparator() != implementation.domainSeparator());
    }

    function test_domainSeparatorFollowsChainId() public {
        bytes32 before = account.domainSeparator();
        vm.chainId(block.chainid + 1);
        assertTrue(account.domainSeparator() != before, "a cached separator would survive a fork");
    }

    // ---------------------------------------------------------------
    // AccessControl replaces the single owner
    // ---------------------------------------------------------------

    function test_initializeRejectsZeroAddressesAndContractOwner() public {
        address[] memory empty = new address[](0);
        AgentPayAccountV3 fresh = new AgentPayAccountV3();

        vm.expectRevert();
        new ERC1967Proxy(
            address(fresh),
            abi.encodeCall(AgentPayAccountV3.initialize, (address(0), owner, executor, upgrader, empty, empty))
        );

        // The owner must stay an EOA so ERC-1271 and EIP-712 keep recovering a key.
        vm.expectRevert();
        new ERC1967Proxy(
            address(fresh),
            abi.encodeCall(AgentPayAccountV3.initialize, (admin, address(token), executor, upgrader, empty, empty))
        );

        vm.expectRevert();
        new ERC1967Proxy(
            address(fresh), abi.encodeCall(AgentPayAccountV3.initialize, (admin, owner, owner, upgrader, empty, empty))
        );
    }

    function test_onlyOwnerRoleMayRunAdminOperations() public {
        vm.prank(executor);
        vm.expectRevert();
        account.pause();

        vm.prank(owner);
        account.pause();
        assertTrue(account.paused());
    }

    function test_onlyExecutorRoleMaySubmitPayments() public {
        (AgentPayAccountV3.DirectPaymentAuthorization memory auth, bytes memory sig) = _signedDirect(10e6, 1);

        vm.prank(owner);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(auth, sig);
    }

    function test_defaultAdminCanRotateRolesWithoutTouchingCode() public {
        address newExecutor = address(0xE2);

        bytes32 executorRole = account.EXECUTOR_ROLE();
        vm.startPrank(admin);
        account.revokeRole(executorRole, executor);
        account.grantRole(executorRole, newExecutor);
        vm.stopPrank();

        (AgentPayAccountV3.DirectPaymentAuthorization memory auth, bytes memory sig) = _signedDirect(10e6, 7);

        vm.prank(executor);
        vm.expectRevert();
        account.executeAuthorizedDirectPayment(auth, sig);

        vm.prank(newExecutor);
        account.executeAuthorizedDirectPayment(auth, sig);
        assertEq(token.balanceOf(recipient), 10e6);
    }

    // ---------------------------------------------------------------
    // Signature authority still binds to the named signer
    // ---------------------------------------------------------------

    function test_executesADirectPaymentSignedByAnOwnerRoleHolder() public {
        (AgentPayAccountV3.DirectPaymentAuthorization memory auth, bytes memory sig) = _signedDirect(25e6, 2);

        vm.prank(executor);
        account.executeAuthorizedDirectPayment(auth, sig);

        assertEq(token.balanceOf(recipient), 25e6);
        assertTrue(account.usedNonces(2));
    }

    function test_rejectsASignatureFromAnAddressWithoutOwnerRole() public {
        AgentPayAccountV3.DirectPaymentAuthorization memory auth = _direct(5e6, 3);
        auth.owner = vm.addr(strangerKey);
        bytes memory sig = _sign(strangerKey, account.hashDirectAuthorization(auth));

        vm.prank(executor);
        vm.expectRevert(AgentPayAccountV3.InvalidSignature.selector);
        account.executeAuthorizedDirectPayment(auth, sig);
    }

    function test_rejectsOneOwnerSignatureInsideAnotherOwnersPayload() public {
        // Checking only "signer holds OWNER_ROLE" would let a signature made by
        // owner A be replayed inside a payload naming owner B.
        address secondOwner = vm.addr(strangerKey);
        bytes32 ownerRole = account.OWNER_ROLE();
        vm.prank(admin);
        account.grantRole(ownerRole, secondOwner);

        AgentPayAccountV3.DirectPaymentAuthorization memory auth = _direct(5e6, 4);
        auth.owner = secondOwner;
        bytes memory sigFromFirstOwner = _sign(ownerKey, account.hashDirectAuthorization(auth));

        vm.prank(executor);
        vm.expectRevert(AgentPayAccountV3.InvalidSignature.selector);
        account.executeAuthorizedDirectPayment(auth, sigFromFirstOwner);
    }

    function test_revokingOwnerRoleInvalidatesFutureAuthorizations() public {
        (AgentPayAccountV3.DirectPaymentAuthorization memory auth, bytes memory sig) = _signedDirect(5e6, 5);

        bytes32 ownerRole = account.OWNER_ROLE();
        vm.prank(admin);
        account.revokeRole(ownerRole, owner);

        vm.prank(executor);
        vm.expectRevert(AgentPayAccountV3.InvalidSignature.selector);
        account.executeAuthorizedDirectPayment(auth, sig);
    }

    function test_erc1271AcceptsOnlyOwnerRoleSigners() public {
        bytes32 digest = keccak256("agent-wallet-proof");

        assertEq(account.isValidSignature(digest, _sign(ownerKey, digest)), bytes4(0x1626ba7e));
        assertEq(account.isValidSignature(digest, _sign(strangerKey, digest)), bytes4(0xffffffff));
    }

    function test_rejectsAReplayedNonce() public {
        (AgentPayAccountV3.DirectPaymentAuthorization memory auth, bytes memory sig) = _signedDirect(5e6, 6);

        vm.prank(executor);
        account.executeAuthorizedDirectPayment(auth, sig);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(AgentPayAccountV3.NonceAlreadyUsed.selector, uint256(6)));
        account.executeAuthorizedDirectPayment(auth, sig);
    }

    function test_rejectsAHighSMalleableSignature() public {
        AgentPayAccountV3.DirectPaymentAuthorization memory auth = _direct(5e6, 8);
        bytes32 digest = account.hashDirectAuthorization(auth);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);

        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleable = abi.encodePacked(r, bytes32(n - uint256(s)), uint8(v == 27 ? 28 : 27));

        vm.prank(executor);
        vm.expectRevert(AgentPayAccountV3.InvalidSignature.selector);
        account.executeAuthorizedDirectPayment(auth, malleable);
    }

    // ---------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------

    function _direct(uint256 amount, uint256 nonce)
        internal
        view
        returns (AgentPayAccountV3.DirectPaymentAuthorization memory auth)
    {
        auth = AgentPayAccountV3.DirectPaymentAuthorization({
            intentIdHash: keccak256(abi.encodePacked("intent", nonce)),
            tenantIdHash: keccak256("tenant"),
            paymentType: keccak256("DIRECT_PAYMENT"),
            owner: owner,
            account: address(account),
            token: address(token),
            recipient: recipient,
            amount: amount,
            nonce: nonce,
            deadline: block.timestamp + 5 minutes,
            purposeHash: keccak256("purpose")
        });
    }

    function _signedDirect(uint256 amount, uint256 nonce)
        internal
        view
        returns (AgentPayAccountV3.DirectPaymentAuthorization memory auth, bytes memory signature)
    {
        auth = _direct(amount, nonce);
        signature = _sign(ownerKey, account.hashDirectAuthorization(auth));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
