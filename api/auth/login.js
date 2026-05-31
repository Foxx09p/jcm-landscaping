const { asyncHandler, methodNotAllowed, readJsonBody, sendJson } = require("../_lib/http");
const { loginAccount } = require("../_lib/github-data");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  return sendJson(res, 200, await loginAccount(body));
});
