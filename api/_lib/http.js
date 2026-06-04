function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  return sendJson(res, 405, { error: "Method not allowed." });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

function asyncHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.statusCode || error.status || 500;
      const stripeType = String(error.type || "");
      const stripeMessage = String(error.message || "");
      const code = /StripePermissionError/i.test(stripeType) || /API Key does not have permission/i.test(stripeMessage)
        ? "stripe_permissions_insufficient"
        : /StripeAuthenticationError/i.test(stripeType) || /Invalid API Key/i.test(stripeMessage)
          ? "stripe_test_credentials_invalid"
          : error.code;
      const publicServerErrors = {
        google_auth_not_configured: "Google sign-in is not configured yet. Email sign-in is still available.",
        stripe_test_credentials_missing: "Test payment setup is not configured yet. Please contact JCM support.",
        stripe_test_credentials_invalid: "Test payment setup is temporarily unavailable. Please contact JCM support.",
        stripe_permissions_insufficient: "Test payment setup needs additional Stripe permissions. Please contact JCM support."
      };
      sendJson(res, status, {
        error: publicServerErrors[code] || (status >= 500 ? "Server error." : error.message),
        code: code || undefined
      });
    }
  };
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

module.exports = {
  asyncHandler,
  httpError,
  methodNotAllowed,
  readJsonBody,
  readRawBody,
  sendJson
};
