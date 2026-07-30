import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareWithdrawal } from "./withdrawal.ts";

test("prepareWithdrawal validates with shared Arc schemas and creates fresh UUIDv4 keys", () => {
  const generated = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  let index = 0;
  const randomUuid = () => generated[index++]!;

  assert.deepEqual(
    prepareWithdrawal(
      "  0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  ",
      " 25.123456 ",
      randomUuid,
    ),
    {
      destination: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      amount: "25.123456",
      idempotencyKey: generated[0],
    },
  );
  assert.equal(
    prepareWithdrawal(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "1",
      randomUuid,
    ).idempotencyKey,
    generated[1],
  );
  assert.notEqual(generated[0], generated[1]);
});

test("prepareWithdrawal rejects invalid addresses, zero, negatives, excess decimals, and invalid UUIDs", () => {
  const validAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const validUuid = () => "11111111-1111-4111-8111-111111111111";

  assert.throws(
    () => prepareWithdrawal("0x1234", "1", validUuid),
    (err: Error) => err.message === "Enter a valid EVM destination address.",
  );
  for (const amount of ["0", "-1", "1.0000001", "01", "1e3"]) {
    assert.throws(
      () => prepareWithdrawal(validAddress, amount, validUuid),
      (err: Error) => err.message === "Enter a positive USDC amount with at most six decimal places.",
    );
  }
  assert.throws(
    () => prepareWithdrawal(validAddress, "1", () => "not-a-uuid"),
    (err: Error) => err.message === "Unable to prepare a safe withdrawal. Please try again.",
  );
});
