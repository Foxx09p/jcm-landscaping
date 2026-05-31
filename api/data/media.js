const path = require("path");
const { asyncHandler, httpError, methodNotAllowed } = require("../_lib/http");
const { readRepoBinary, verifyMediaSignature } = require("../_lib/github-data");

const CONTENT_TYPES = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const mediaPath = String(req.query.path || "");
  if ((!mediaPath.startsWith("media/job-photos/") && !mediaPath.startsWith("media/completion-photos/")) || !verifyMediaSignature(mediaPath, req.query.signature)) {
    throw httpError(403, "Invalid media URL.");
  }
  const file = await readRepoBinary(mediaPath, true);
  if (!file) throw httpError(404, "Image not found.");
  res.statusCode = 200;
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Content-Type", CONTENT_TYPES[path.extname(mediaPath).toLowerCase()] || "application/octet-stream");
  res.end(file);
});
