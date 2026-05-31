const { asyncHandler, methodNotAllowed, sendJson, httpError } = require("../_lib/http");
const { getSignedInUser, isAdminRole, isApprovedContractor, isSuspended } = require("../_lib/github-data");
const { createOrRetrieveAccount, getStripe, stripeModeSummary } = require("../_lib/stripe-connect");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await getSignedInUser(req);
  if (isSuspended(user.profile)) throw httpError(403, "Your account access is limited.");
  if (!isApprovedContractor(user.profile) && !isAdminRole(user.profile)) {
    throw httpError(403, "Payment setup is available only to approved contractors.");
  }
  const { account } = await createOrRetrieveAccount(user);
  const link = await getStripe().accounts.createLoginLink(account.id);
  return sendJson(res, 200, { url: link.url, stripeAccountId: account.id, ...stripeModeSummary() });
});
