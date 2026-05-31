const path = require("path");
const { asyncHandler, httpError, methodNotAllowed, readRawBody, sendJson } = require("../_lib/http");
const { getSignedInUser, mediaUrl, readRepoFile, serverTimestamp, systemWrite, writeRepoFile } = require("../_lib/github-data");

function isSupportedImage(content, contentType) {
  if (contentType === "image/png") {
    return content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (contentType === "image/jpeg") return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (contentType === "image/gif") return content.length >= 6 && ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii"));
  if (contentType === "image/webp") return content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

module.exports = asyncHandler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await getSignedInUser(req);
  const uploadPath = String(req.query.path || "").split("/").filter(Boolean).join("/");
  const requestPhoto = uploadPath.startsWith(`job-photos/${user.uid}/`);
  const completionPhoto = uploadPath.startsWith(`completion-photos/${user.uid}/`);
  if ((!requestPhoto && !completionPhoto) || uploadPath.includes("..")) {
    throw httpError(403, "Invalid upload path.");
  }
  const contentType = String(req.headers["content-type"] || "").toLowerCase().split(";")[0];
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(contentType)) {
    throw httpError(400, "Only image uploads are allowed.");
  }
  const content = await readRawBody(req);
  if (!content.length || content.length > 3 * 1024 * 1024) {
    throw httpError(413, "Each image must be smaller than 3 MB.");
  }
  if (!isSupportedImage(content, contentType)) throw httpError(400, "The uploaded file is not a supported image.");
  const repoPath = `media/${uploadPath}`;
  const existing = await readRepoFile(repoPath, true);
  await writeRepoFile(repoPath, content, `Upload JCM image ${path.basename(uploadPath)}`, existing && existing.sha);
  const url = mediaUrl(req, repoPath);
  const photoId = `photo_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await systemWrite([{
    type: "set",
    path: `photoMetadata/${photoId}`,
    data: {
      id: photoId,
      ownerId: user.uid,
      jobId: String(req.query.jobId || "").trim(),
      kind: completionPhoto ? "completion" : "request",
      visibility: completionPhoto ? "participants" : "approved_contractors",
      repoPath,
      url,
      contentType,
      sizeBytes: content.length,
      createdAt: serverTimestamp()
    }
  }], "Record JCM photo metadata");
  return sendJson(res, 201, { url, photoId });
});
