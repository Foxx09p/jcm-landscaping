const { asyncHandler, methodNotAllowed, readJsonBody, sendJson } = require("../_lib/http");
const { getSignedInUser, readForUser, writeForUser } = require("../_lib/github-data");

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await getSignedInUser(req);
  const body = await readJsonBody(req);
  if (body.action === "commit") {
    await writeForUser(user, body.operations);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 200, { result: await readForUser(user, body.action, body) });
});
