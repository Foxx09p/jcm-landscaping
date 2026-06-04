const crypto = require("crypto");
const { httpError } = require("./http");

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
let cachedKeys = null;
let cachedKeysExpiresAt = 0;

function googleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
}

function requireGoogleClientId() {
  const clientId = googleClientId();
  if (!clientId) {
    throw httpError(503, "Google sign-in is not configured yet.", "google_auth_not_configured");
  }
  return clientId;
}

function decodeJson(part, label) {
  try {
    return JSON.parse(Buffer.from(String(part || ""), "base64url").toString("utf8"));
  } catch {
    throw httpError(400, `Invalid Google sign-in ${label}.`);
  }
}

function decodeCredential(credential) {
  const parts = String(credential || "").split(".");
  if (parts.length !== 3) throw httpError(400, "Invalid Google sign-in response.");
  return {
    header: decodeJson(parts[0], "header"),
    payload: decodeJson(parts[1], "payload"),
    signature: Buffer.from(parts[2], "base64url"),
    signed: `${parts[0]}.${parts[1]}`
  };
}

function maxAgeSeconds(cacheControl) {
  const match = String(cacheControl || "").match(/max-age=(\d+)/i);
  return match ? Math.min(86400, Math.max(60, Number(match[1]))) : 3600;
}

async function googleKeys(forceRefresh = false) {
  if (!forceRefresh && cachedKeys && cachedKeysExpiresAt > Date.now()) return cachedKeys;
  const response = await fetch(GOOGLE_JWKS_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw httpError(503, "Google sign-in is temporarily unavailable.");
  const data = await response.json();
  const keys = new Map((data.keys || []).map(key => [key.kid, key]));
  cachedKeys = keys;
  cachedKeysExpiresAt = Date.now() + maxAgeSeconds(response.headers.get("cache-control")) * 1000;
  return keys;
}

function verifySignature(decoded, jwk) {
  if (!jwk) return false;
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(decoded.signed);
  verifier.end();
  return verifier.verify(crypto.createPublicKey({ key: jwk, format: "jwk" }), decoded.signature);
}

function assertClaims(payload, clientId) {
  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!GOOGLE_ISSUERS.has(payload.iss)) throw httpError(401, "Google sign-in could not be verified.");
  if (!audiences.includes(clientId)) throw httpError(401, "Google sign-in is not authorized for this site.");
  if (payload.azp && payload.azp !== clientId) throw httpError(401, "Google sign-in is not authorized for this site.");
  if (!payload.exp || Number(payload.exp) < now - skew) throw httpError(401, "Google sign-in has expired. Try again.");
  if (payload.nbf && Number(payload.nbf) > now + skew) throw httpError(401, "Google sign-in is not active yet.");
  if (!payload.sub || !payload.email) throw httpError(401, "Google did not return the required account details.");
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw httpError(403, "Use a Google account with a verified email address.");
  }
}

async function verifyGoogleCredential(credential) {
  const clientId = requireGoogleClientId();
  const decoded = decodeCredential(credential);
  if (decoded.header.alg !== "RS256" || !decoded.header.kid) {
    throw httpError(401, "Google sign-in could not be verified.");
  }
  let keys = await googleKeys();
  let jwk = keys.get(decoded.header.kid);
  if (!jwk) {
    keys = await googleKeys(true);
    jwk = keys.get(decoded.header.kid);
  }
  if (!verifySignature(decoded, jwk)) throw httpError(401, "Google sign-in could not be verified.");
  assertClaims(decoded.payload, clientId);
  return {
    sub: String(decoded.payload.sub),
    email: String(decoded.payload.email).trim().toLowerCase(),
    emailVerified: true,
    displayName: String(decoded.payload.name || "").trim(),
    photoURL: String(decoded.payload.picture || "").trim()
  };
}

module.exports = {
  googleClientId,
  verifyGoogleCredential
};
