const crypto = require("crypto");
const { promisify } = require("util");
const { httpError } = require("./http");
const { stripPrivateJobFields } = require("./marketplace-rules");

const scrypt = promisify(crypto.scrypt);
const DATABASE_PATH = "data/database.json";
const ACCOUNTS_PATH = "data/accounts.json";
const ROLES_PATH = "config/roles.json";
const TIMESTAMP_KEY = "__jcmTimestamp";
const SERVER_TIMESTAMP_KEY = "__jcmServerTimestamp";
let databaseCache = null;
let databaseCacheExpiresAt = 0;
let rolesCache = null;
let rolesCacheExpiresAt = 0;
const PRIVILEGED_ROLES = ["owner", "admin", "moderator"];
const PROTECTED_USER_FIELDS = [
  "uid",
  "email",
  "emailVerified",
  "role",
  "contractorStatus",
  "suspended",
  "stripeAccountId",
  "stripeChargesEnabled",
  "stripePayoutsEnabled",
  "stripeDetailsSubmitted",
  "stripeRequirementsCurrentlyDue",
  "stripeDisabledReason",
  "stripeOnboardingComplete",
  "stripeMode",
  "lastStripeStatusSync",
  "paymentSummary",
  "lastStripePayoutEvent",
  "completedJobCount",
  "averageRating",
  "reviewCount"
];

function repoConfig() {
  const token = process.env.GITHUB_DATA_TOKEN;
  const repo = process.env.GITHUB_DATA_REPO;
  if (!token || !repo || !repo.includes("/")) {
    throw httpError(500, "GitHub data repository is not configured.");
  }
  return {
    token,
    repo,
    branch: process.env.GITHUB_DATA_BRANCH || "main"
  };
}

async function githubRequest(path, options = {}) {
  const config = repoConfig();
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "User-Agent": "jcm-landscaping-api",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const error = httpError(response.status >= 500 ? 502 : response.status, "GitHub data storage request failed.");
    error.githubStatus = response.status;
    error.githubMessage = details.message;
    throw error;
  }
  return response.json();
}

function encodeRepoPath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

async function readRepoFile(path, allowMissing = false) {
  const config = repoConfig();
  const result = await githubRequest(
    `/repos/${config.repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(config.branch)}`,
    { allowMissing }
  );
  if (!result) return null;
  return {
    sha: result.sha,
    content: Buffer.from(String(result.content || "").replace(/\n/g, ""), "base64")
  };
}

async function readRepoBinary(path, allowMissing = false) {
  const config = repoConfig();
  const response = await fetch(
    `https://api.github.com/repos/${config.repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(config.branch)}`,
    {
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${config.token}`,
        "User-Agent": "jcm-landscaping-api",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw httpError(response.status >= 500 ? 502 : response.status, "GitHub media request failed.");
  return Buffer.from(await response.arrayBuffer());
}

async function writeRepoFile(path, content, message, sha) {
  const config = repoConfig();
  const body = {
    branch: config.branch,
    message,
    content: Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(String(content)).toString("base64")
  };
  if (sha) body.sha = sha;
  return githubRequest(`/repos/${config.repo}/contents/${encodeRepoPath(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function updateJson(path, initialValue, message, mutate) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await readRepoFile(path, true);
    const value = existing ? JSON.parse(existing.content.toString("utf8")) : structuredClone(initialValue);
    const next = await mutate(value);
    try {
      await writeRepoFile(path, JSON.stringify(next, null, 2) + "\n", message, existing && existing.sha);
      return next;
    } catch (error) {
      if (![409, 422].includes(error.githubStatus) || attempt === 4) throw error;
    }
  }
  throw httpError(409, "The data changed while saving. Please try again.");
}

function emptyDatabase() {
  return { version: 1, documents: {} };
}

function emptyAccounts() {
  return { version: 1, byEmail: {} };
}

function emptyRoles() {
  return { version: 1, assignments: {} };
}

async function readRolesConfig() {
  if (rolesCache && rolesCacheExpiresAt > Date.now()) return clone(rolesCache);
  const existing = await readRepoFile(ROLES_PATH, true);
  rolesCache = existing ? JSON.parse(existing.content.toString("utf8")) : emptyRoles();
  rolesCacheExpiresAt = Date.now() + 3000;
  return clone(rolesCache);
}

async function readDatabase() {
  if (databaseCache && databaseCacheExpiresAt > Date.now()) return clone(databaseCache);
  const existing = await readRepoFile(DATABASE_PATH, true);
  databaseCache = existing ? JSON.parse(existing.content.toString("utf8")) : emptyDatabase();
  databaseCacheExpiresAt = Date.now() + 3000;
  return clone(databaseCache);
}

function updateDatabase(message, mutate) {
  return updateJson(DATABASE_PATH, emptyDatabase(), message, mutate).then(database => {
    databaseCache = clone(database);
    databaseCacheExpiresAt = Date.now() + 3000;
    return database;
  });
}

function normalizePath(path) {
  const normalized = String(path || "").split("/").filter(Boolean).join("/");
  if (!normalized || normalized.includes("..")) throw httpError(400, "Invalid data path.");
  return normalized;
}

function splitPath(path) {
  return normalizePath(path).split("/");
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function resolveServerTimestamps(value, now = new Date().toISOString()) {
  if (Array.isArray(value)) return value.map(item => resolveServerTimestamps(item, now));
  if (!value || typeof value !== "object") return value;
  if (value[SERVER_TIMESTAMP_KEY] === true) return { [TIMESTAMP_KEY]: now };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveServerTimestamps(item, now)]));
}

function getDocument(database, path) {
  return clone(database.documents[normalizePath(path)]);
}

function setDocument(database, path, data, merge) {
  const normalized = normalizePath(path);
  const next = resolveServerTimestamps(clone(data));
  database.documents[normalized] = merge
    ? { ...(database.documents[normalized] || {}), ...next }
    : next;
  return clone(database.documents[normalized]);
}

function updateDocument(database, path, data) {
  const normalized = normalizePath(path);
  if (!database.documents[normalized]) throw httpError(404, "Document not found.");
  return setDocument(database, normalized, data, true);
}

function listDocuments(database, collectionPath) {
  const prefix = `${normalizePath(collectionPath)}/`;
  return Object.entries(database.documents)
    .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
    .map(([path, data]) => ({ id: path.slice(prefix.length), path, data: clone(data) }));
}

function applyOperations(database, operations) {
  for (const operation of operations) {
    if (operation.type === "set") setDocument(database, operation.path, operation.data, Boolean(operation.merge));
    else if (operation.type === "update") updateDocument(database, operation.path, operation.data);
    else if (operation.type === "delete") delete database.documents[normalizePath(operation.path)];
    else throw httpError(400, "Unsupported write operation.");
  }
  return database;
}

function serverTimestamp() {
  return { [SERVER_TIMESTAMP_KEY]: true };
}

function normalizedRole(profile) {
  const role = String((profile && profile.role) || "buyer").toLowerCase();
  return role === "user" ? "buyer" : role;
}

function configuredRole(roles, email) {
  const role = String((roles && roles.assignments && roles.assignments[String(email || "").trim().toLowerCase()]) || "").toLowerCase();
  return PRIVILEGED_ROLES.includes(role) ? role : null;
}

function applyConfiguredRole(profile, roles) {
  const next = { ...(profile || {}) };
  const role = configuredRole(roles, next.email);
  if (role) {
    next.role = role;
    next.roleSource = "github";
  } else if (PRIVILEGED_ROLES.includes(normalizedRole(next))) {
    next.role = "buyer";
    delete next.roleSource;
  }
  return next;
}

function isSuspended(profile) {
  return Boolean(profile && (profile.suspended || normalizedRole(profile) === "suspended"));
}

function isAdminRole(profile) {
  return ["owner", "admin"].includes(normalizedRole(profile)) && !isSuspended(profile);
}

function isModeratorRole(profile) {
  return normalizedRole(profile) === "moderator" && !isSuspended(profile);
}

function isStaffRole(profile) {
  return (isAdminRole(profile) || isModeratorRole(profile)) && !isSuspended(profile);
}

function isOwner(profile) {
  return normalizedRole(profile) === "owner" && !isSuspended(profile);
}

function isApprovedContractor(profile) {
  return normalizedRole(profile) === "contractor" && profile.contractorStatus === "approved" && !isSuspended(profile);
}

function userProfile(database, uid) {
  return getDocument(database, `users/${uid}`) || {};
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasProtectedUserChanges(before, after) {
  return PROTECTED_USER_FIELDS.some(field => !sameValue(before && before[field], after && after[field]));
}

function canReadDocument(database, user, path, data) {
  const parts = splitPath(path);
  const collection = parts[0];
  if (collection === "users") return parts[1] === user.uid || isAdminRole(user.profile);
  if (collection === "jobs" && parts.length === 2) {
    return isStaffRole(user.profile) || isApprovedContractor(user.profile) ||
      data.postedBy === user.uid || data.acceptedContractorId === user.uid;
  }
  if (collection === "jobs" && parts[2] === "private") {
    return false;
  }
  if (["contractorApplications", "supportTickets"].includes(collection)) {
    return isStaffRole(user.profile) || data.uid === user.uid;
  }
  if (["stripeAccounts", "payments"].includes(collection)) {
    return isAdminRole(user.profile) || data.uid === user.uid;
  }
  if (collection === "jobPayments") {
    const job = getDocument(database, `jobs/${data.jobId}`) || {};
    return isAdminRole(user.profile) || job.postedBy === user.uid || job.acceptedContractorId === user.uid;
  }
  if (collection === "jobQuotes") {
    const job = getDocument(database, `jobs/${data.jobId}`) || {};
    return isStaffRole(user.profile) || data.contractorId === user.uid || job.postedBy === user.uid;
  }
  if (["jobMessages", "finalOffers", "jobStatusHistory", "jobCancellations", "jobDisputes", "jobReviews", "photoMetadata"].includes(collection)) {
    const job = getDocument(database, `jobs/${data.jobId}`) || {};
    return isStaffRole(user.profile) || job.postedBy === user.uid || job.acceptedContractorId === user.uid;
  }
  if (collection === "auditLogs") return isAdminRole(user.profile);
  return false;
}

function sanitizeDocumentForUser(database, user, path, data) {
  const parts = splitPath(path);
  if (parts[0] === "jobs" && parts.length === 2) return stripPrivateJobFields(data);
  if (parts[0] === "jobPayments" && !isAdminRole(user.profile)) {
    const safe = { ...data };
    [
      "stripePaymentIntentId",
      "stripeCheckoutSessionId",
      "stripeCheckoutSessionUrl",
      "stripeChargeId",
      "stripeTransferId",
      "stripeConnectedAccountId",
      "stripeRefundId"
    ].forEach(field => delete safe[field]);
    return safe;
  }
  return data;
}

function ensureOwnUserWrite(user, before, after) {
  if (before) {
    if (hasProtectedUserChanges(before, after)) {
      const pendingOnly = after.contractorStatus === "pending" &&
        PROTECTED_USER_FIELDS.every(field => field === "contractorStatus" || sameValue(before[field], after[field]));
      if (!pendingOnly) throw httpError(403, "You cannot change protected account fields.");
    }
    return;
  }
  if (after.uid !== user.uid || !["buyer", "user"].includes(after.role)) {
    throw httpError(403, "Invalid account profile.");
  }
  if (after.email !== user.profile.email) throw httpError(403, "Invalid account profile.");
  const forbidden = PROTECTED_USER_FIELDS.filter(field => !["uid", "email", "role"].includes(field));
  if (forbidden.some(field => after[field] != null)) throw httpError(403, "Invalid account profile.");
}

function changedFields(before, after) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter(field => !sameValue(before && before[field], after && after[field]));
}

function moderatorCanReviewContractor(before, after) {
  const allowed = [
    "role",
    "contractorStatus",
    "city",
    "zipCode",
    "serviceRadius",
    "serviceRadiusMiles",
    "latitude",
    "longitude",
    "stripeOnboardingComplete",
    "stripeChargesEnabled",
    "stripePayoutsEnabled",
    "updatedAt"
  ];
  const validRole = normalizedRole(after) === "contractor" || normalizedRole(after) === normalizedRole(before);
  const validStatus = ["approved", "rejected"].includes(after.contractorStatus);
  const stripeFieldsValid = ["stripeOnboardingComplete", "stripeChargesEnabled", "stripePayoutsEnabled"]
    .every(field => after[field] == null || after[field] === false);
  return validRole && validStatus && stripeFieldsValid &&
    changedFields(before, after).every(field => allowed.includes(field));
}

function assertCanWrite(database, user, operation, roles) {
  const path = normalizePath(operation.path);
  const parts = splitPath(path);
  const collection = parts[0];
  const before = getDocument(database, path);
  const after = operation.type === "delete"
    ? null
    : operation.merge || operation.type === "update"
      ? { ...(before || {}), ...resolveServerTimestamps(operation.data) }
      : resolveServerTimestamps(operation.data);

  if (collection === "users" && parts.length === 2) {
    if (parts[1] === user.uid) {
      if (isAdminRole(user.profile) && moderatorCanReviewContractor(before, after)) return;
      ensureOwnUserWrite(user, before, after);
      return;
    }
    const effectiveBefore = applyConfiguredRole(before, roles);
    const assignedRole = configuredRole(roles, after && after.email);
    if (before && (before.uid !== after.uid || before.email !== after.email)) {
      throw httpError(403, "Account ID and email cannot be changed.");
    }
    if (isModeratorRole(user.profile)) {
      if (!moderatorCanReviewContractor(before, after)) throw httpError(403, "Moderators can only review contractor applications.");
      return;
    }
    if (!isAdminRole(user.profile)) throw httpError(403, "Admin access is required.");
    if (PRIVILEGED_ROLES.includes(normalizedRole(after)) && normalizedRole(after) !== assignedRole) {
      throw httpError(403, "Assign owner, admin, and moderator roles in config/roles.json.");
    }
    if (PRIVILEGED_ROLES.includes(normalizedRole(effectiveBefore)) && !isOwner(user.profile)) {
      throw httpError(403, "Only the owner can manage a staff account.");
    }
    return;
  }

  if (collection === "jobs" && parts.length === 2) {
    throw httpError(403, "Use the trusted marketplace workflow for service request changes.");
  }

  if (collection === "jobs" && parts[2] === "private" && parts[3] === "customer") {
    throw httpError(403, "Use the trusted marketplace workflow for private service request details.");
  }

  if (collection === "contractorApplications") {
    throw httpError(403, "Use the trusted marketplace workflow for contractor applications.");
  }

  if (collection === "supportTickets") {
    throw httpError(403, "Use the trusted marketplace workflow for support tickets.");
  }

  throw httpError(403, "This data cannot be changed from the app.");
}

function matchesQuery(document, query = {}) {
  const filters = Array.isArray(query.filters) ? query.filters : [];
  return filters.every(filter => filter.op === "==" && sameValue(document.data[filter.field], filter.value));
}

function sortDocuments(documents, query = {}) {
  if (!query.orderBy) return documents;
  const direction = query.orderDirection === "desc" ? -1 : 1;
  const timestamp = value => value && value[TIMESTAMP_KEY] ? value[TIMESTAMP_KEY] : value;
  return documents.sort((a, b) => {
    const left = timestamp(a.data[query.orderBy]);
    const right = timestamp(b.data[query.orderBy]);
    return left === right ? 0 : left > right ? direction : -direction;
  });
}

async function readForUser(user, action, payload) {
  const database = await readDatabase();
  const roles = await readRolesConfig();
  if (action === "get") {
    const data = getDocument(database, payload.path);
    if (!data) return null;
    if (!canReadDocument(database, user, payload.path, data)) throw httpError(403, "You do not have access to this data.");
    const output = splitPath(payload.path)[0] === "users"
      ? applyConfiguredRole(data, roles)
      : sanitizeDocumentForUser(database, user, payload.path, data);
    return { id: splitPath(payload.path).at(-1), path: normalizePath(payload.path), data: output };
  }
  if (action === "list") {
    let documents = listDocuments(database, payload.path)
      .filter(document => canReadDocument(database, user, document.path, document.data))
      .filter(document => matchesQuery(document, payload.query));
    documents = sortDocuments(documents, payload.query);
    if (payload.query && Number.isInteger(payload.query.limit)) documents = documents.slice(0, payload.query.limit);
    if (splitPath(payload.path)[0] === "users") {
      documents = documents.map(document => ({ ...document, data: applyConfiguredRole(document.data, roles) }));
    } else {
      documents = documents.map(document => ({ ...document, data: sanitizeDocumentForUser(database, user, document.path, document.data) }));
    }
    return documents;
  }
  throw httpError(400, "Unsupported data read.");
}

async function writeForUser(user, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 25) {
    throw httpError(400, "Invalid write batch.");
  }
  const roles = await readRolesConfig();
  return updateDatabase("Update JCM app data", database => {
    for (const operation of operations) {
      assertCanWrite(database, user, operation, roles);
      applyOperations(database, [operation]);
    }
    return database;
  });
}

async function systemWrite(operations, message = "Update JCM system data") {
  return updateDatabase(message, database => applyOperations(database, operations));
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function authSecret() {
  if (!process.env.AUTH_SESSION_SECRET || process.env.AUTH_SESSION_SECRET.length < 32) {
    throw httpError(500, "AUTH_SESSION_SECRET must be configured with at least 32 characters.");
  }
  return process.env.AUTH_SESSION_SECRET;
}

function signSession(account) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    uid: account.uid,
    email: account.email,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
  }));
  const signature = crypto.createHmac("sha256", authSecret()).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifySession(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw httpError(401, "Invalid or expired sign-in token.");
  const expected = crypto.createHmac("sha256", authSecret()).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw httpError(401, "Invalid or expired sign-in token.");
  }
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (!payload.uid || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw httpError(401, "Invalid or expired sign-in token.");
  }
  return payload;
}

function sessionTokenFromRequest(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw httpError(401, "Sign in is required.");
  return match[1];
}

async function getSignedInUser(req) {
  const token = verifySession(sessionTokenFromRequest(req));
  const [database, roles] = await Promise.all([readDatabase(), readRolesConfig()]);
  const profile = userProfile(database, token.uid);
  return {
    token,
    uid: token.uid,
    profile: applyConfiguredRole({
      uid: token.uid,
      phoneNumber: profile.phoneNumber || "",
      role: "buyer",
      contractorStatus: null,
      ...profile,
      email: token.email || profile.email || ""
    }, roles)
  };
}

async function hashPassword(password, salt) {
  return (await scrypt(password, salt, 64)).toString("hex");
}

function publicAuthUser(account) {
  return {
    uid: account.uid,
    email: account.email,
    phoneNumber: account.phoneNumber || "",
    displayName: account.displayName || "",
    photoURL: account.photoURL || "",
    emailVerified: account.emailVerified !== false
  };
}

function validatePassword(password) {
  if (String(password || "").length < 8) throw httpError(400, "Use a password with at least 8 characters.");
}

async function registerAccount({ email, password, displayName }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes("@")) throw httpError(400, "Enter a valid email address.");
  validatePassword(password);
  const salt = crypto.randomBytes(16).toString("hex");
  const account = {
    uid: crypto.randomUUID(),
    email: normalizedEmail,
    displayName: String(displayName || "").trim(),
    emailVerified: String(process.env.REQUIRE_EMAIL_VERIFICATION || "false").toLowerCase() !== "true",
    passwordSalt: salt,
    passwordHash: await hashPassword(password, salt),
    createdAt: new Date().toISOString()
  };
  await updateJson(ACCOUNTS_PATH, emptyAccounts(), "Register JCM account", accounts => {
    if (accounts.byEmail[normalizedEmail]) throw httpError(409, "An account with that email already exists.");
    accounts.byEmail[normalizedEmail] = account;
    return accounts;
  });
  const role = configuredRole(await readRolesConfig(), account.email) || "buyer";
  await systemWrite([{
    type: "set",
    path: `users/${account.uid}`,
    data: {
      uid: account.uid,
      email: account.email,
      emailVerified: account.emailVerified,
      phoneNumber: "",
      displayName: account.displayName,
      photoURL: "",
      role,
      contractorStatus: null,
      createdAt: serverTimestamp(),
      lastSeen: serverTimestamp()
    }
  }], "Create JCM user profile");
  return { token: signSession(account), user: publicAuthUser(account) };
}

async function loginAccount({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const existing = await readRepoFile(ACCOUNTS_PATH, true);
  const accounts = existing ? JSON.parse(existing.content.toString("utf8")) : emptyAccounts();
  const account = accounts.byEmail[normalizedEmail];
  if (!account) throw httpError(401, "Invalid email or password.");
  const attempted = Buffer.from(await hashPassword(String(password || ""), account.passwordSalt), "hex");
  const expected = Buffer.from(account.passwordHash, "hex");
  if (attempted.length !== expected.length || !crypto.timingSafeEqual(attempted, expected)) {
    throw httpError(401, "Invalid email or password.");
  }
  return { token: signSession(account), user: publicAuthUser(account) };
}

async function updateAccountProfile(uid, updates) {
  let updated = null;
  await updateJson(ACCOUNTS_PATH, emptyAccounts(), "Update JCM account profile", accounts => {
    for (const account of Object.values(accounts.byEmail)) {
      if (account.uid !== uid) continue;
      account.displayName = String(updates.displayName || account.displayName || "").trim();
      account.photoURL = String(updates.photoURL || account.photoURL || "").trim();
      updated = account;
      break;
    }
    if (!updated) throw httpError(404, "Account not found.");
    return accounts;
  });
  await systemWrite([{
    type: "set",
    path: `users/${uid}`,
    data: {
      displayName: updated.displayName,
      photoURL: updated.photoURL,
      lastSeen: serverTimestamp()
    },
    merge: true
  }], "Update JCM user profile");
  return publicAuthUser(updated);
}

function mediaSecret() {
  return process.env.MEDIA_URL_SECRET || authSecret();
}

function mediaSignature(path) {
  return crypto.createHmac("sha256", mediaSecret()).update(normalizePath(path)).digest("base64url");
}

function verifyMediaSignature(path, signature) {
  const expected = Buffer.from(mediaSignature(path), "base64url");
  const actual = Buffer.from(String(signature || ""), "base64url");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function mediaUrl(req, path) {
  const relative = `/api/data/media?path=${encodeURIComponent(path)}&signature=${encodeURIComponent(mediaSignature(path))}`;
  const explicit = process.env.APP_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (explicit) return `${explicit.startsWith("http") ? explicit : `https://${explicit}`}${relative}`;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}${relative}` : relative;
}

class DocumentSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = Boolean(data);
    this._data = data;
  }
  data() {
    return clone(this._data);
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
    this.size = docs.length;
  }
}

class DocumentReference {
  constructor(database, path) {
    this.database = database;
    this.path = normalizePath(path);
    this.id = splitPath(path).at(-1);
  }
  collection(name) {
    return new CollectionReference(this.database, `${this.path}/${name}`);
  }
  async get() {
    const database = await readDatabase();
    return new DocumentSnapshot(this, getDocument(database, this.path));
  }
  set(data, options = {}) {
    return systemWrite([{ type: "set", path: this.path, data, merge: Boolean(options.merge) }]);
  }
  update(data) {
    return systemWrite([{ type: "update", path: this.path, data }]);
  }
}

class QueryReference {
  constructor(database, path, filters = [], maximum = null) {
    this.database = database;
    this.path = normalizePath(path);
    this.filters = filters;
    this.maximum = maximum;
  }
  where(field, op, value) {
    return new QueryReference(this.database, this.path, [...this.filters, { field, op, value }], this.maximum);
  }
  limit(maximum) {
    return new QueryReference(this.database, this.path, this.filters, maximum);
  }
  async get() {
    const database = await readDatabase();
    let docs = listDocuments(database, this.path)
      .filter(document => matchesQuery(document, { filters: this.filters }));
    if (this.maximum != null) docs = docs.slice(0, this.maximum);
    return new QuerySnapshot(docs.map(document => new DocumentSnapshot(new DocumentReference(this.database, document.path), document.data)));
  }
}

class CollectionReference extends QueryReference {
  doc(id = crypto.randomUUID()) {
    return new DocumentReference(this.database, `${this.path}/${id}`);
  }
}

class WriteBatch {
  constructor() {
    this.operations = [];
  }
  set(ref, data, options = {}) {
    this.operations.push({ type: "set", path: ref.path, data, merge: Boolean(options.merge) });
    return this;
  }
  update(ref, data) {
    this.operations.push({ type: "update", path: ref.path, data });
    return this;
  }
  commit() {
    return systemWrite(this.operations);
  }
}

class Transaction {
  constructor(database) {
    this.database = database;
    this.operations = [];
  }
  get(ref) {
    return Promise.resolve(new DocumentSnapshot(ref, getDocument(this.database, ref.path)));
  }
  set(ref, data, options = {}) {
    this.operations.push({ type: "set", path: ref.path, data, merge: Boolean(options.merge) });
    return this;
  }
  update(ref, data) {
    this.operations.push({ type: "update", path: ref.path, data });
    return this;
  }
}

class GithubDatabase {
  collection(path) {
    return new CollectionReference(this, path);
  }
  batch() {
    return new WriteBatch();
  }
  runTransaction(callback) {
    return updateDatabase("Update JCM transaction", async database => {
      const transaction = new Transaction(database);
      await callback(transaction);
      return applyOperations(database, transaction.operations);
    });
  }
}

const database = new GithubDatabase();

function db() {
  return database;
}

module.exports = {
  db,
  getSignedInUser,
  isAdminRole,
  isApprovedContractor,
  isModeratorRole,
  isOwner,
  isStaffRole,
  isSuspended,
  loginAccount,
  mediaSignature,
  mediaUrl,
  normalizedRole,
  publicAuthUser,
  readForUser,
  readRepoBinary,
  readRepoFile,
  registerAccount,
  repoConfig,
  serverTimestamp,
  sessionTokenFromRequest,
  signSession,
  systemWrite,
  updateAccountProfile,
  verifyMediaSignature,
  verifySession,
  writeForUser,
  writeRepoFile
};
