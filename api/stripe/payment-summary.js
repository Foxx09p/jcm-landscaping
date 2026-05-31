const { asyncHandler, methodNotAllowed, sendJson, httpError } = require("../_lib/http");
const { getSignedInUser, isAdminRole, isApprovedContractor, isSuspended } = require("../_lib/github-data");
const { createOrRetrieveAccount, getConnectedAccount, getStripe, stripeModeSummary, updateUserStripeStatus } = require("../_lib/stripe-connect");

function startOfDaySeconds(date) {
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000);
}

function startOfWeekSeconds(date) {
  const day = date.getDay();
  const diff = date.getDate() - day;
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), diff).getTime() / 1000);
}

function startOfMonthSeconds(date) {
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), 1).getTime() / 1000);
}

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const user = await getSignedInUser(req);
  if (isSuspended(user.profile)) throw httpError(403, "Your account access is limited.");
  if (!isApprovedContractor(user.profile) && !isAdminRole(user.profile)) {
    throw httpError(403, "Payment summary is available only to approved contractors.");
  }

  const { account } = await createOrRetrieveAccount(user);
  const stripe = getStripe();
  const [freshAccount, balance, payouts] = await Promise.all([
    getConnectedAccount(stripe, account.id),
    stripe.balance.retrieve({}, { stripeAccount: account.id }),
    stripe.payouts.list({ limit: 25 }, { stripeAccount: account.id })
  ]);
  const status = await updateUserStripeStatus(user.uid, freshAccount);
  const now = new Date();
  const today = startOfDaySeconds(now);
  const week = startOfWeekSeconds(now);
  const month = startOfMonthSeconds(now);
  const currency = ((balance.pending && balance.pending[0] && balance.pending[0].currency) ||
    (payouts.data[0] && payouts.data[0].currency) ||
    "usd");
  const paidPayouts = payouts.data.filter(item => item.status === "paid");
  const sumSince = since => paidPayouts
    .filter(item => item.created >= since)
    .reduce((sum, item) => sum + (item.amount || 0), 0);
  const pendingPayout = (balance.pending || [])
    .filter(item => !currency || item.currency === currency)
    .reduce((sum, item) => sum + (item.amount || 0), 0);
  return sendJson(res, 200, {
    ...stripeModeSummary(),
    profile: status,
    stripeAccountId: account.id,
    stripeChargesEnabled: status.stripeChargesEnabled,
    stripePayoutsEnabled: status.stripePayoutsEnabled,
    stripeDetailsSubmitted: status.stripeDetailsSubmitted,
    stripeOnboardingComplete: status.stripeOnboardingComplete,
    stripeRequirementsCurrentlyDue: status.stripeRequirementsCurrentlyDue,
    lastStripeStatusSync: new Date().toISOString(),
    totals: {
      currency,
      paidToday: sumSince(today),
      paidWeek: sumSince(week),
      paidMonth: sumSince(month),
      pendingPayout
    },
    history: payouts.data
      .filter(item => ["paid", "in_transit", "pending"].includes(item.status))
      .map(item => ({
        id: item.id,
        type: "payout",
        description: "Stripe payout",
        amount: item.amount,
        currency: item.currency,
        status: item.status,
        created: item.created
      }))
  });
});
