const { asyncHandler, methodNotAllowed, readJsonBody, sendJson } = require("../_lib/http");
const { registerAccount } = require("../_lib/github-data");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  return sendJson(res, 201, await registerAccount(body));
});
