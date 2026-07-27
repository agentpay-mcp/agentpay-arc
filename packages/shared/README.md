# @agentpay-ai/shared-arc

Shared AgentPay schemas and helpers:

- Arc Testnet chain metadata: chain ID `5042002`, CAIP-2 `eip155:5042002`, Circle chain `ARC-TESTNET`;
- Arc USDC metadata, including the native 18-decimal gas view and the 6-decimal ERC-20 interface at `0x3600000000000000000000000000000000000000`, which are two views of one balance and must never be summed;
- Arc EURC metadata and the Arc CCTP/Gateway domain `26`;
- Circle Agent Wallet, balance, invoice, x402, and payment-intent validation;
- exact six-decimal USDC amount parsing that rejects zero, negative, over-precision, malformed, and overflowing values;
- ERC-8004 registration metadata schemas;
- inherited Celo chain/token metadata and EIP-712 authorization builders from the fork source.

The Arc home-chain schema accepts only Arc Testnet (`5042002`), and that is what
`networkSelectionShape` uses. The inherited Celo home-chain schema
(`42220` / `11142220`) is retained for the legacy owner-signed payment path and
does not make Celo an AgentPay Arc home chain. Destination metadata can still
describe supported cross-chain funding assets without turning those chains into
home chains.
