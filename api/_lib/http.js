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
      sendJson(res, status, {
        error: status >= 500 ? "Server error." : error.message,
        code: error.code || undefined
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
