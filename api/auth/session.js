const { asyncHandler, methodNotAllowed, readJsonBody, sendJson } = require("../_lib/http");
const { getSignedInUser, updateAccountProfile } = require("../_lib/github-data");

module.exports = asyncHandler(async (req, res) => {
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);
  const user = await getSignedInUser(req);
  const profile = req.method === "POST"
    ? await updateAccountProfile(user.uid, await readJsonBody(req))
    : user.profile;
  return sendJson(res, 200, {
    user: {
      uid: user.uid,
      email: profile.email || "",
      phoneNumber: profile.phoneNumber || "",
      displayName: profile.displayName || "",
      photoURL: profile.photoURL || "",
      emailVerified: profile.emailVerified !== false
    }
  });
});
