const { asyncHandler, methodNotAllowed, sendJson } = require("../_lib/http");
const { getStripe, stripeMode, stripeWebhookSecret } = require("../_lib/stripe-connect");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  res.setHeader("Cache-Control", "no-store");
  const mode = stripeMode();
  const webhookConfigured = Boolean(stripeWebhookSecret());
  let stripeApiReachable = false;
  try {
    await getStripe().balance.retrieve();
    stripeApiReachable = true;
  } catch {
    stripeApiReachable = false;
  }
  const ok = mode === "test" && webhookConfigured && stripeApiReachable;
  return sendJson(res, ok ? 200 : 503, {
    ok,
    stripeMode: mode,
    testPaymentsOnly: mode === "test",
    livePaymentsEnabled: mode === "live",
    webhookConfigured,
    stripeApiReachable
  });
});
