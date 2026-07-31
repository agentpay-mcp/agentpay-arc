import assert from "node:assert/strict";
import { test } from "node:test";

import { pollWithdrawalUntilTerminal } from "./withdrawal-polling.ts";

test("pollWithdrawalUntilTerminal stops at the first terminal result", async () => {
  let calls = 0;
  const result = await pollWithdrawalUntilTerminal({
    initial: {
      status: "SUBMITTED",
      transactionId: "circle-tx-1",
      reconciliationRequired: false,
    },
    async fetchStatus() {
      calls += 1;
      return calls === 1
        ? {
            status: "SUBMITTED",
            transactionId: "circle-tx-1",
            reconciliationRequired: true,
          }
        : {
            status: "COMPLETED",
            transactionId: "circle-tx-1",
            transactionHash: `0x${"a".repeat(64)}`,
            reconciliationRequired: false,
          };
    },
    async sleep() {},
    maxAttempts: 3,
  });

  assert.equal(calls, 2);
  assert.equal(result.status, "COMPLETED");
});

test("pollWithdrawalUntilTerminal is bounded and never invents completion", async () => {
  let calls = 0;
  const result = await pollWithdrawalUntilTerminal({
    initial: {
      status: "SUBMITTED",
      transactionId: "circle-tx-1",
      reconciliationRequired: false,
    },
    async fetchStatus() {
      calls += 1;
      return {
        status: "SUBMITTED",
        transactionId: "circle-tx-1",
        reconciliationRequired: true,
      };
    },
    async sleep() {},
    maxAttempts: 2,
  });

  assert.equal(calls, 2);
  assert.equal(result.status, "SUBMITTED");
  assert.equal(result.reconciliationRequired, true);
});

test("pollWithdrawalUntilTerminal stops before another status read when aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await assert.rejects(
    pollWithdrawalUntilTerminal({
      initial: {
        status: "SUBMITTED",
        transactionId: "circle-tx-1",
        reconciliationRequired: false,
      },
      async fetchStatus() {
        calls += 1;
        return {
          status: "SUBMITTED",
          transactionId: "circle-tx-1",
          reconciliationRequired: true,
        };
      },
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(calls, 0);
});
