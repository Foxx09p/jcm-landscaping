const { asyncHandler, methodNotAllowed, sendJson, httpError } = require("../_lib/http");
const { getSignedInUser, isAdminRole, isApprovedContractor, isSuspended } = require("../_lib/github-data");
const {
  appBaseUrl,
  createOrRetrieveAccount,
  getConnectedAccount,
  getStripe,
  stripeModeSummary,
  updateUserStripeStatus
} = require("../_lib/stripe-connect");

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

function actionFromRequest(req) {
  const url = new URL(req.url || "/", "https://jcm.local");
  return String(url.searchParams.get("action") || "").trim();
}

async function requirePaymentUser(req, summaryOnly) {
  const user = await getSignedInUser(req);
  if (isSuspended(user.profile)) throw httpError(403, "Your account access is limited.");
  if (!isApprovedContractor(user.profile) && !isAdminRole(user.profile)) {
    throw httpError(403, summaryOnly
      ? "Payment summary is available only to approved contractors."
      : "Payment setup is available only to approved contractors.");
  }
  return user;
}

async function createOnboardingLink(req, user) {
  const { account, status } = await createOrRetrieveAccount(user);
  const baseUrl = appBaseUrl(req);
  const stripe = getStripe();
  const link = await stripe.v2.core.accountLinks.create({
    account: account.id,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["recipient"],
        refresh_url: `${baseUrl}/#payment`,
        return_url: `${baseUrl}/#payment`
      }
    }
  });
  return { url: link.url, stripeAccountId: account.id, profile: status, ...stripeModeSummary() };
}

async function createDashboardLink(user) {
  const { account } = await createOrRetrieveAccount(user);
  const link = await getStripe().accounts.createLoginLink(account.id);
  return { url: link.url, stripeAccountId: account.id, ...stripeModeSummary() };
}

async function refreshAccount(user) {
  const { account } = await createOrRetrieveAccount(user);
  const fresh = await getConnectedAccount(getStripe(), account.id);
  const status = await updateUserStripeStatus(user.uid, fresh);
  return { stripeAccountId: account.id, profile: status, ...stripeModeSummary() };
}

async function paymentSummary(user) {
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
  return {
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
  };
}

module.exports = asyncHandler(async (req, res) => {
  const action = actionFromRequest(req);
  if (!action) throw httpError(400, "Missing Stripe Connect action.");

  if (action === "payment-summary") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const user = await requirePaymentUser(req, true);
    return sendJson(res, 200, await paymentSummary(user));
  }

  if (!["onboarding-link", "refresh-account", "dashboard-link"].includes(action)) {
    throw httpError(404, "Unknown Stripe Connect action.");
  }
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requirePaymentUser(req, false);
  if (action === "onboarding-link") return sendJson(res, 200, await createOnboardingLink(req, user));
  if (action === "refresh-account") return sendJson(res, 200, await refreshAccount(user));
  return sendJson(res, 200, await createDashboardLink(user));
});
