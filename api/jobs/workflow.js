const { asyncHandler, methodNotAllowed, readJsonBody, sendJson } = require("../_lib/http");
const { handleWorkflow } = require("../_lib/marketplace");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  return sendJson(res, 200, await handleWorkflow(req, await readJsonBody(req)));
});
