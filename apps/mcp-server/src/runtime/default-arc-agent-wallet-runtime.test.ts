import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ArcErc8004ViemReaders } from "../services/arc-erc8004-viem.ts";
import type { ArcAgentJobViemReaders } from "../services/arc-agent-jobs-viem.ts";
import type { ArcAppKitService } from "../services/arc-app-kit.ts";
import type { CircleCli } from "../services/circle-cli.ts";
import type { SwapSettlementVerifier } from "../tools/arc-liquidity.ts";
import { createDefaultArcAgentWalletRuntime } from "./default-arc-agent-wallet-runtime.ts";

describe("createDefaultArcAgentWalletRuntime", () => {
  it("builds the config-free local runtime from a process-owned state file", async () => {
    const searched: unknown[] = [];
    const statePath = join(
      tmpdir(),
      `agentpay-default-runtime-${process.pid}-${crypto.randomUUID()}.json`,
    );
    const runtime = createDefaultArcAgentWalletRuntime({
      statePath,
      circleCli: {
        async searchServices(input: unknown) {
          searched.push(input);
          return [];
        },
      } as unknown as CircleCli,
      appKit: {} as ArcAppKitService,
      settlementVerifier: {} as SwapSettlementVerifier,
      identityReaders: {
        reader: {},
        proofReader: {},
      } as ArcErc8004ViemReaders,
      jobReaders: {
        reader: {},
        proofReader: {},
      } as ArcAgentJobViemReaders,
      clock: () => new Date("2026-07-28T06:00:00.000Z"),
    });

    assert.equal(Object.keys(runtime).length, 31);
    assert.deepEqual(await runtime.searchPaidServices({ query: "weather" }), {
      services: [],
    });
    assert.deepEqual(searched, [{ query: "weather" }]);
  });
});
