const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertTransition,
  canAcceptedContractorViewPrivate,
  moneySplit,
  stripPrivateJobFields
} = require("../api/_lib/marketplace-rules");

test("money split stores integer cents and applies the 30/70 platform split", () => {
  assert.deepEqual(moneySplit(10000), {
    finalAmountCents: 10000,
    platformFeePercentage: 30,
    platformFeeCents: 3000,
    contractorPercentage: 70,
    contractorAmountCents: 7000
  });
  assert.equal(moneySplit(999).platformFeeCents, 300);
  assert.equal(moneySplit(999).contractorAmountCents, 699);
});

test("ordinary lifecycle transitions reject direct jumps", () => {
  assert.doesNotThrow(() => assertTransition("open", "quotes_received"));
  assert.throws(() => assertTransition("open", "completed"), /cannot move/);
});

test("admin lifecycle override requires a reason", () => {
  assert.throws(() => assertTransition("open", "completed", { adminOverride: true }), /cannot move/);
  assert.doesNotThrow(() => assertTransition("open", "completed", { adminOverride: true, reason: "Owner reviewed records." }));
});

test("accepted contractor private access requires an allowed post-acceptance state", () => {
  const job = { acceptedContractorId: "contractor-1", status: "awaiting_final_offer" };
  assert.equal(canAcceptedContractorViewPrivate(job, "contractor-1"), true);
  assert.equal(canAcceptedContractorViewPrivate(job, "contractor-2"), false);
  assert.equal(canAcceptedContractorViewPrivate({ ...job, status: "open" }, "contractor-1"), false);
});

test("public job output strips private coordinates and contact fields", () => {
  const output = stripPrivateJobFields({
    id: "job-1",
    city: "Example",
    latitude: 1,
    longitude: 2,
    fullAddress: "Private",
    posterEmail: "private@example.com",
    posterPhone: "555"
  });
  assert.deepEqual(output, { id: "job-1", city: "Example" });
});
