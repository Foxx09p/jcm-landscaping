const { asyncHandler, methodNotAllowed, sendJson, httpError } = require("../_lib/http");
const { getSignedInUser, isAdminRole, isApprovedContractor, isSuspended } = require("../_lib/github-data");
const { createOrRetrieveAccount, getConnectedAccount, getStripe, stripeModeSummary, updateUserStripeStatus } = require("../_lib/stripe-connect");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await getSignedInUser(req);
  if (isSuspended(user.profile)) throw httpError(403, "Your account access is limited.");
  if (!isApprovedContractor(user.profile) && !isAdminRole(user.profile)) {
    throw httpError(403, "Payment setup is available only to approved contractors.");
  }
  const { account } = await createOrRetrieveAccount(user);
  const fresh = await getConnectedAccount(getStripe(), account.id);
  const status = await updateUserStripeStatus(user.uid, fresh);
  return sendJson(res, 200, { stripeAccountId: account.id, profile: status, ...stripeModeSummary() });
});
