import assert from "node:assert/strict";
import { it } from "node:test";

import { createArcErc8004ViemReaders } from "./arc-erc8004-viem.ts";

const runLive = process.env.ARC_RPC_INTEGRATION === "1";
const zeroHash = `0x${"0".repeat(64)}`;

it("reads deployed Arc ERC-8004 registries through the official RPC", {
  skip: runLive ? false : "set ARC_RPC_INTEGRATION=1 for the read-only live check",
}, async () => {
  const { reader } = createArcErc8004ViemReaders();
  const status = await reader.getValidationStatus(zeroHash);

  assert.equal(typeof status.exists, "boolean");
  assert.match(status.validatorAddress, /^0x[a-fA-F0-9]{40}$/);
  assert.match(status.lastUpdate, /^\d+$/);
});
