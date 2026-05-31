const { httpError } = require("./http");

const JOB_STATUSES = [
  "pending_verification",
  "open",
  "quotes_received",
  "contractor_accepted",
  "awaiting_final_offer",
  "awaiting_buyer_offer_acceptance",
  "awaiting_payment",
  "payment_held",
  "scheduling",
  "scheduled",
  "in_progress",
  "contractor_completed",
  "completed",
  "canceled",
  "disputed",
  "closed"
];

const PAYMENT_STATUSES = [
  "not_required",
  "awaiting_final_offer",
  "awaiting_buyer_acceptance",
  "awaiting_payment",
  "payment_authorized_or_paid",
  "payment_failed",
  "held_pending_completion",
  "release_requested",
  "released_to_contractor",
  "partially_refunded",
  "refunded",
  "disputed_payment"
];

const CANCELLATION_REASONS = [
  "buyer canceled",
  "contractor canceled",
  "no response from buyer",
  "no response from contractor",
  "contractor no-show",
  "buyer no-show",
  "wrong job details",
  "wrong scope",
  "unsafe property",
  "duplicate request",
  "price not agreed",
  "price disagreement",
  "weather delay",
  "work incomplete",
  "property issue",
  "other"
];

const LEGAL_TRANSITIONS = {
  pending_verification: ["open", "canceled"],
  open: ["quotes_received", "contractor_accepted", "canceled"],
  quotes_received: ["contractor_accepted", "canceled"],
  contractor_accepted: ["awaiting_final_offer", "canceled"],
  awaiting_final_offer: ["awaiting_buyer_offer_acceptance", "canceled"],
  awaiting_buyer_offer_acceptance: ["awaiting_final_offer", "awaiting_payment", "canceled"],
  awaiting_payment: ["payment_held", "canceled"],
  payment_held: ["scheduling", "canceled"],
  scheduling: ["scheduled", "canceled"],
  scheduled: ["in_progress", "canceled"],
  in_progress: ["contractor_completed", "disputed"],
  contractor_completed: ["completed", "disputed"],
  completed: ["closed"],
  canceled: ["open", "closed"],
  disputed: ["completed", "canceled", "closed"],
  closed: []
};

const PRIVATE_DETAIL_STATUSES = new Set([
  "contractor_accepted",
  "awaiting_final_offer",
  "awaiting_buyer_offer_acceptance",
  "awaiting_payment",
  "payment_held",
  "scheduling",
  "scheduled",
  "in_progress",
  "contractor_completed",
  "completed",
  "disputed"
]);

function assertKnownStatus(status) {
  if (!JOB_STATUSES.includes(status)) throw httpError(400, "Invalid job status.");
}

function assertTransition(from, to, options = {}) {
  assertKnownStatus(from);
  assertKnownStatus(to);
  if (from === to) return;
  if ((LEGAL_TRANSITIONS[from] || []).includes(to)) return;
  if (options.adminOverride && String(options.reason || "").trim()) return;
  throw httpError(409, `A job cannot move from ${from} to ${to}.`);
}

function assertCancellationReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (!CANCELLATION_REASONS.includes(normalized)) {
    throw httpError(400, "Choose a valid cancellation or dispute reason.");
  }
  return normalized;
}

function moneySplit(finalAmountCents) {
  if (!Number.isSafeInteger(finalAmountCents) || finalAmountCents <= 0) {
    throw httpError(400, "Enter a valid final price in cents.");
  }
  const platformFeeCents = Math.round(finalAmountCents * 30 / 100);
  return {
    finalAmountCents,
    platformFeePercentage: 30,
    platformFeeCents,
    contractorPercentage: 70,
    contractorAmountCents: finalAmountCents - platformFeeCents
  };
}

function canAcceptedContractorViewPrivate(job, uid) {
  return Boolean(job &&
    uid &&
    job.acceptedContractorId === uid &&
    PRIVATE_DETAIL_STATUSES.has(job.status));
}

function stripPrivateJobFields(job) {
  const safe = { ...(job || {}) };
  [
    "posterEmail",
    "posterPhone",
    "fullAddress",
    "customerDetails",
    "privateNotes",
    "accessInstructions",
    "latitude",
    "longitude",
    "locationAccuracyMeters"
  ].forEach(field => delete safe[field]);
  return safe;
}

module.exports = {
  CANCELLATION_REASONS,
  JOB_STATUSES,
  LEGAL_TRANSITIONS,
  PAYMENT_STATUSES,
  PRIVATE_DETAIL_STATUSES,
  assertCancellationReason,
  assertKnownStatus,
  assertTransition,
  canAcceptedContractorViewPrivate,
  moneySplit,
  stripPrivateJobFields
};
