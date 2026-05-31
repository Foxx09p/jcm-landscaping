const { asyncHandler, methodNotAllowed, sendJson, httpError } = require("../_lib/http");
const { db, getSignedInUser, isAdminRole, isApprovedContractor, isSuspended } = require("../_lib/github-data");
const {
  appBaseUrl,
  createOrRetrieveAccount,
  getConnectedAccount,
  getStripe,
  stripeModeSummary,
  stripeTestSimulationEnabled,
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

function timestampMs(value) {
  if (!value) return 0;
  const raw = value.__jcmTimestamp || value;
  const number = new Date(raw).getTime();
  return Number.isFinite(number) ? number : 0;
}

function timestampSeconds(value) {
  const ms = timestampMs(value);
  return ms ? Math.floor(ms / 1000) : 0;
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
  if (stripeTestSimulationEnabled()) {
    return { simulated: true, stripeAccountId: account.id, profile: status, ...stripeModeSummary() };
  }
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
  if (stripeTestSimulationEnabled()) {
    return { simulated: true, stripeAccountId: account.id, ...stripeModeSummary() };
  }
  const link = await getStripe().accounts.createLoginLink(account.id);
  return { url: link.url, stripeAccountId: account.id, ...stripeModeSummary() };
}

async function refreshAccount(user) {
  const { account } = await createOrRetrieveAccount(user);
  if (stripeTestSimulationEnabled()) {
    return { simulated: true, stripeAccountId: account.id, profile: await updateUserStripeStatus(user.uid, account), ...stripeModeSummary() };
  }
  const fresh = await getConnectedAccount(getStripe(), account.id);
  const status = await updateUserStripeStatus(user.uid, fresh);
  return { stripeAccountId: account.id, profile: status, ...stripeModeSummary() };
}

async function paymentSummary(user) {
  const { account } = await createOrRetrieveAccount(user);
  const mode = stripeModeSummary();
  const simulated = stripeTestSimulationEnabled();
  const stripe = simulated ? null : getStripe();
  const [freshAccount, balance, payouts, releaseSnapshot] = simulated
    ? [account, { pending: [] }, { data: [] }, await db().collection("payoutRecords").where("contractorId", "==", user.uid).get()]
    : await Promise.all([
      getConnectedAccount(stripe, account.id),
      stripe.balance.retrieve({}, { stripeAccount: account.id }),
      stripe.payouts.list({ limit: 25 }, { stripeAccount: account.id }),
      db().collection("payoutRecords").where("contractorId", "==", user.uid).get()
    ]);
  const status = await updateUserStripeStatus(user.uid, freshAccount);
  const now = new Date();
  const today = startOfDaySeconds(now);
  const week = startOfWeekSeconds(now);
  const month = startOfMonthSeconds(now);
  const releaseRecords = releaseSnapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(item => !item.stripeMode || item.stripeMode === mode.stripeMode)
    .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt));
  const currency = ((releaseRecords[0] && releaseRecords[0].currency) ||
    (balance.pending && balance.pending[0] && balance.pending[0].currency) ||
    (payouts.data[0] && payouts.data[0].currency) ||
    "usd");
  const paidPayouts = payouts.data.filter(item => item.status === "paid");
  const sumSince = since => paidPayouts
    .filter(item => item.created >= since)
    .reduce((sum, item) => sum + (item.amount || 0), 0);
  const releasedSince = since => releaseRecords
    .filter(item => timestampSeconds(item.createdAt) >= since)
    .reduce((sum, item) => sum + (item.amountCents || 0), 0);
  const pendingPayout = (balance.pending || [])
    .filter(item => !currency || item.currency === currency)
    .reduce((sum, item) => sum + (item.amount || 0), 0);
  const releaseHistory = releaseRecords.slice(0, 25).map(item => ({
    id: item.id,
    type: "transfer",
    description: "JCM payout release",
    amount: item.amountCents,
    currency: item.currency,
    status: item.status,
    created: timestampSeconds(item.createdAt),
    transferId: item.stripeTransferId || ""
  }));
  const stripePayoutHistory = payouts.data
    .filter(item => ["paid", "in_transit", "pending"].includes(item.status))
    .map(item => ({
      id: item.id,
      type: "payout",
      description: "Stripe payout",
      amount: item.amount,
      currency: item.currency,
      status: item.status,
      created: item.created
    }));
  return {
    ...mode,
    simulated,
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
      paidToday: releasedSince(today) || sumSince(today),
      paidWeek: releasedSince(week) || sumSince(week),
      paidMonth: releasedSince(month) || sumSince(month),
      pendingPayout
    },
    history: releaseHistory
      .concat(stripePayoutHistory)
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .slice(0, 25)
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
