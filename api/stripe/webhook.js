const { asyncHandler, methodNotAllowed, readRawBody, sendJson } = require("../_lib/http");
const { db, serverTimestamp } = require("../_lib/github-data");
const { processStripeEvent } = require("../_lib/marketplace");
const {
  findUidByStripeAccountId,
  getConnectedAccount,
  getStripe,
  stripeKeyIsLive,
  stripeWebhookSecret,
  updateUserStripeStatus
} = require("../_lib/stripe-connect");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const webhookSecret = stripeWebhookSecret();
  if (!webhookSecret) {
    res.statusCode = 500;
    return sendJson(res, 500, { error: "Stripe webhook secret is not configured." });
  }
  const raw = await readRawBody(req);
  const signature = req.headers["stripe-signature"];
  let event;
  try {
    event = getStripe().webhooks.constructEvent(raw, signature, webhookSecret);
  } catch {
    return sendJson(res, 400, { error: "Invalid Stripe webhook signature." });
  }

  if (Boolean(event.livemode) !== stripeKeyIsLive()) {
    return sendJson(res, 200, { received: true, ignored: "Stripe mode mismatch." });
  }

  if (event.type === "account.updated") {
    const account = event.data.object;
    const uid = await findUidByStripeAccountId(account.id);
    if (uid) await updateUserStripeStatus(uid, account);
  }

  if (event.account && event.type === "account.external_account.updated") {
    const uid = await findUidByStripeAccountId(event.account);
    if (uid) {
      const account = await getConnectedAccount(getStripe(), event.account);
      await updateUserStripeStatus(uid, account);
    }
  }

  if (event.account && event.type.startsWith("payout.")) {
    const uid = await findUidByStripeAccountId(event.account);
    if (uid) {
      const payout = event.data.object;
      await db().collection("users").doc(uid).set({
        lastStripePayoutEvent: {
          id: payout.id,
          amount: payout.amount || 0,
          currency: payout.currency || "usd",
          status: payout.status || "",
          created: payout.created || null,
          type: event.type,
          failureCode: payout.failure_code || "",
          failureMessage: payout.failure_message || ""
        },
        lastStripeStatusSync: serverTimestamp()
      }, { merge: true });
      if (event.type === "payout.failed") {
        const account = await getConnectedAccount(getStripe(), event.account);
        await updateUserStripeStatus(uid, account);
      }
    }
  }

  const result = await processStripeEvent(event);
  return sendJson(res, 200, { received: true, duplicate: result.duplicate });
});
