import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  arcBatchPayoutInputSchema,
  deterministicBatchItemId,
  formatUsdcAtomic,
  parseUsdcAtomic,
  sumUsdcAmounts,
} from "./batch-payout.ts";

const BATCH_ID = "33d3d96a-983a-4f0c-8f66-921f2d6d4b15";
const IDEMPOTENCY_KEY = "ea1e8ff1-edaa-4a27-a6de-715f76d5aa7c";
const RECIPIENT_A = "0x1111111111111111111111111111111111111111";
const RECIPIENT_B = "0x2222222222222222222222222222222222222222";

describe("Arc batch payout schemas", () => {
  it("parses only Arc Testnet USDC batches and leaves caller input immutable", () => {
    const input = {
      batchId: BATCH_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      chain: "ARC-TESTNET",
      token: "USDC",
      payouts: [
        { recipient: RECIPIENT_A, amount: "1.000001", purpose: "Contributor A" },
        { recipient: RECIPIENT_B, amount: "2", purpose: "Contributor B" },
      ],
    } as const;
    const before = structuredClone(input);

    const parsed = arcBatchPayoutInputSchema.parse(input);

    assert.deepEqual(input, before);
    assert.notEqual(parsed, input);
    assert.equal(parsed.chain, "ARC-TESTNET");
    assert.equal(parsed.token, "USDC");
  });

  it("requires UUID-v4 identifiers", () => {
    for (const field of ["batchId", "idempotencyKey"] as const) {
      const invalid = {
        batchId: BATCH_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
        [field]: "550e8400-e29b-11d4-a716-446655440000",
      };

      assert.throws(() => arcBatchPayoutInputSchema.parse(invalid), /uuid|version 4/i);
    }
  });

  it("rejects non-Arc chains, non-USDC tokens, invalid addresses, and imprecise amounts", () => {
    const base = {
      batchId: BATCH_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      payouts: [{ recipient: RECIPIENT_A, amount: "1" }],
    };

    assert.throws(
      () => arcBatchPayoutInputSchema.parse({ ...base, chain: "ETH-SEPOLIA" }),
      /ARC-TESTNET|invalid/i,
    );
    assert.throws(
      () => arcBatchPayoutInputSchema.parse({ ...base, token: "EURC" }),
      /USDC|invalid/i,
    );
    assert.throws(
      () => arcBatchPayoutInputSchema.parse({ ...base, payouts: [{ recipient: "0x1234", amount: "1" }] }),
      /address/i,
    );
    assert.throws(
      () => arcBatchPayoutInputSchema.parse({ ...base, payouts: [{ recipient: RECIPIENT_A, amount: "1.0000001" }] }),
      /six|decimal|precision/i,
    );
    assert.throws(
      () => arcBatchPayoutInputSchema.parse({ ...base, payouts: [{ recipient: RECIPIENT_A, amount: "0" }] }),
      /positive/i,
    );
  });

  it("rejects duplicate recipients case-insensitively", () => {
    assert.throws(
      () =>
        arcBatchPayoutInputSchema.parse({
          batchId: BATCH_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          payouts: [
            { recipient: RECIPIENT_A.toLowerCase(), amount: "1" },
            { recipient: RECIPIENT_A.toUpperCase().replace("0X", "0x"), amount: "2" },
          ],
        }),
      /duplicate recipient/i,
    );
  });

  it("uses exact bigint arithmetic and deterministic item IDs", () => {
    assert.equal(parseUsdcAtomic("9007199254740993.000001"), 9007199254740993000001n);
    assert.equal(formatUsdcAtomic(9007199254740993000001n), "9007199254740993.000001");
    assert.equal(sumUsdcAmounts(["0.000001", "2", "3.999999"]), 6_000_000n);
    assert.equal(deterministicBatchItemId(BATCH_ID, 0), `${BATCH_ID}:0`);
    assert.equal(deterministicBatchItemId(BATCH_ID, 0), deterministicBatchItemId(BATCH_ID, 0));
    assert.notEqual(deterministicBatchItemId(BATCH_ID, 0), deterministicBatchItemId(BATCH_ID, 1));
  });
});
