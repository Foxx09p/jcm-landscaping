const crypto = require("crypto");
const assert = require("node:assert/strict");
const test = require("node:test");

const { verifyGoogleCredential } = require("../api/_lib/google-auth");

const CLIENT_ID = "jcm-web-client.apps.googleusercontent.com";
const OTHER_CLIENT_ID = "other-client.apps.googleusercontent.com";

const keyPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = keyPair.publicKey.export({ format: "jwk" });
jwk.kid = "jcm-test-key";
jwk.alg = "RS256";
jwk.use = "sig";

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function credential(payloadOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT", kid: jwk.kid });
  const payload = encode({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-user-123",
    email: "User@Example.com",
    email_verified: true,
    name: "JCM Customer",
    picture: "https://example.com/avatar.jpg",
    exp: now + 300,
    iat: now,
    ...payloadOverrides
  });
  const signed = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(signed).end().sign(keyPair.privateKey).toString("base64url");
  return `${signed}.${signature}`;
}

test("Google credential verification requires a configured client ID", async () => {
  const originalFetch = global.fetch;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  const originalOAuthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;

  try {
    await assert.rejects(
      () => verifyGoogleCredential(credential()),
      error => error.statusCode === 503 && error.code === "google_auth_not_configured"
    );
  } finally {
    global.fetch = originalFetch;
    if (originalClientId == null) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalClientId;
    if (originalOAuthClientId == null) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = originalOAuthClientId;
  }
});

test("Google credential verification accepts signed Google ID tokens", async () => {
  const originalFetch = global.fetch;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  global.fetch = async () => ({
    ok: true,
    headers: { get: () => "max-age=60" },
    json: async () => ({ keys: [jwk] })
  });

  try {
    const profile = await verifyGoogleCredential(credential());
    assert.deepEqual(profile, {
      sub: "google-user-123",
      email: "user@example.com",
      emailVerified: true,
      displayName: "JCM Customer",
      photoURL: "https://example.com/avatar.jpg"
    });
  } finally {
    global.fetch = originalFetch;
    if (originalClientId == null) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalClientId;
  }
});

test("Google credential verification rejects tokens for another audience", async () => {
  const originalFetch = global.fetch;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  global.fetch = async () => ({
    ok: true,
    headers: { get: () => "max-age=60" },
    json: async () => ({ keys: [jwk] })
  });

  try {
    await assert.rejects(
      () => verifyGoogleCredential(credential({ aud: OTHER_CLIENT_ID })),
      error => error.statusCode === 401 && /not authorized/i.test(error.message)
    );
  } finally {
    global.fetch = originalFetch;
    if (originalClientId == null) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalClientId;
  }
});
