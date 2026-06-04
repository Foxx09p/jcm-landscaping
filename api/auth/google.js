const { asyncHandler, methodNotAllowed, readJsonBody, sendJson } = require("../_lib/http");
const { googleClientId } = require("../_lib/google-auth");
const { googleSignInAccount } = require("../_lib/github-data");

module.exports = asyncHandler(async (req, res) => {
  if (req.method === "GET") {
    const clientId = googleClientId();
    return sendJson(res, 200, { configured: Boolean(clientId), clientId });
  }
  if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  return sendJson(res, 200, await googleSignInAccount(await readJsonBody(req)));
});
