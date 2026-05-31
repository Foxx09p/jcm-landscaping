const { asyncHandler, methodNotAllowed, sendJson, httpError } = require("../_lib/http");
const { getSignedInUser, isAdminRole, isApprovedContractor, isSuspended } = require("../_lib/github-data");
const { appBaseUrl, createOrRetrieveAccount, getStripe, stripeModeSummary } = require("../_lib/stripe-connect");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await getSignedInUser(req);
  if (isSuspended(user.profile)) throw httpError(403, "Your account access is limited.");
  if (!isApprovedContractor(user.profile) && !isAdminRole(user.profile)) {
    throw httpError(403, "Payment setup is available only to approved contractors.");
  }
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
  return sendJson(res, 200, { url: link.url, stripeAccountId: account.id, profile: status, ...stripeModeSummary() });
});
