const { asyncHandler, httpError, methodNotAllowed } = require("../_lib/http");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  throw httpError(410, "One-click job claiming has been retired. Submit a quote from Available Jobs instead.", "claim_retired");
});
