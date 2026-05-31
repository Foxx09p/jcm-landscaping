const { asyncHandler, methodNotAllowed, sendJson } = require("../_lib/http");
const { getStripe, stripeMode, stripeTestSimulationEnabled, stripeWebhookSecret } = require("../_lib/stripe-connect");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  res.setHeader("Cache-Control", "no-store");
  const mode = stripeMode();
  const simulatedTestPayments = stripeTestSimulationEnabled();
  const webhookConfigured = Boolean(stripeWebhookSecret());
  let stripeApiReachable = false;
  let stripeBalanceReadable = false;
  let stripeAccountsReadable = false;
  let stripeApiStatus = simulatedTestPayments ? "simulated" : "ready";
  if (!simulatedTestPayments) {
    try {
      const stripe = getStripe();
      await stripe.balance.retrieve();
      stripeBalanceReadable = true;
      await stripe.v2.core.accounts.list({ limit: 1 });
      stripeAccountsReadable = true;
      stripeApiReachable = true;
    } catch (error) {
      stripeApiReachable = false;
      const statusCode = Number(error.statusCode || error.status || 0);
      const code = String(error.code || "");
      const message = String(error.message || "");
      stripeApiStatus = /not configured/i.test(message)
        ? "missing_credentials"
        : statusCode === 401 || /invalid|expired/i.test(code)
          ? "invalid_credentials"
          : statusCode === 403
            ? "insufficient_permissions"
            : statusCode >= 500
              ? "stripe_unavailable"
              : "stripe_api_error";
    }
  }
  const ok = mode === "test" && (simulatedTestPayments || (webhookConfigured && stripeApiReachable));
  return sendJson(res, ok ? 200 : 503, {
    ok,
    stripeMode: mode,
    testPaymentsOnly: mode === "test",
    simulatedTestPayments,
    livePaymentsEnabled: mode === "live",
    webhookConfigured,
    stripeApiReachable,
    stripeBalanceReadable,
    stripeAccountsReadable,
    stripeApiStatus
  });
});
