const crypto = require("crypto");
const { httpError } = require("./http");
const {
  db,
  getSignedInUser,
  isAdminRole,
  isApprovedContractor,
  isStaffRole,
  isSuspended,
  normalizedRole,
  serverTimestamp,
  systemWrite
} = require("./github-data");
const {
  CANCELLATION_REASONS,
  JOB_STATUSES,
  PAYMENT_STATUSES,
  assertCancellationReason,
  assertTransition,
  canAcceptedContractorViewPrivate,
  moneySplit,
  stripPrivateJobFields
} = require("./marketplace-rules");
const {
  createCheckoutSession,
  createContractorTransfer,
  createFullRefund,
  stripeMode,
  stripeModeSummary
} = require("./stripe-connect");

const MAX_TEXT = 4000;
const MAX_SHORT_TEXT = 240;
const MAX_PHOTOS = 8;
const PLATFORM_PAYMENTS_REQUIRED = String(process.env.PLATFORM_PAYMENTS_REQUIRED || "true").toLowerCase() !== "false";
const AUTO_RELEASE_ENABLED = String(process.env.AUTO_RELEASE_ENABLED || "false").toLowerCase() === "true";
const AUTO_RELEASE_AFTER_DAYS = Math.max(1, Number(process.env.AUTO_RELEASE_AFTER_DAYS || 7));

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowMarker() {
  return serverTimestamp();
}

function timestampMs(value) {
  if (!value) return 0;
  const raw = value.__jcmTimestamp || value;
  const number = new Date(raw).getTime();
  return Number.isFinite(number) ? number : 0;
}

function text(value, label, options = {}) {
  const normalized = String(value || "").trim();
  if (options.required && !normalized) throw httpError(400, `${label} is required.`);
  const maximum = options.maximum || MAX_TEXT;
  if (normalized.length > maximum) throw httpError(400, `${label} is too long.`);
  return normalized;
}

function arrayOfText(value, label, maximum = 24) {
  if (!Array.isArray(value)) return [];
  if (value.length > maximum) throw httpError(400, `${label} has too many values.`);
  return [...new Set(value.map(item => text(item, label, { maximum: MAX_SHORT_TEXT })).filter(Boolean))];
}

function photoUrls(value, maximum = MAX_PHOTOS) {
  if (!Array.isArray(value)) return [];
  if (value.length > maximum) throw httpError(400, `Upload no more than ${maximum} photos.`);
  return value.map(url => {
    const normalized = text(url, "Photo URL", { required: true, maximum: 1600 });
    if (!normalized.includes("/api/data/media?")) throw httpError(400, "Use photos uploaded through JCM.");
    return normalized;
  });
}

function cents(value, label = "Amount") {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 100000000) {
    throw httpError(400, `${label} must be a valid amount in cents.`);
  }
  return number;
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function actor(user) {
  return {
    actorId: user && user.uid || "system",
    actorRole: user ? normalizedRole(user.profile) : "system"
  };
}

function userName(profile) {
  return profile.displayName || profile.businessName || profile.email || "JCM user";
}

function operation(type, path, data, merge = false) {
  return { type, path, data, merge };
}

function auditOperation(user, actionType, targetType, targetId, details = {}) {
  return operation("set", `auditLogs/${id("audit")}`, {
    actionType,
    ...actor(user),
    targetType,
    targetId,
    oldValue: details.oldValue == null ? null : details.oldValue,
    newValue: details.newValue == null ? null : details.newValue,
    reason: text(details.reason, "Reason", { maximum: 800 }),
    note: text(details.note, "Note", { maximum: 1600 }),
    createdAt: nowMarker()
  });
}

function statusHistoryOperation(user, jobId, from, to, reason, note) {
  return operation("set", `jobStatusHistory/${id("status")}`, {
    jobId,
    from,
    to,
    ...actor(user),
    reason: text(reason, "Reason", { maximum: 800 }),
    note: text(note, "Note", { maximum: 1600 }),
    createdAt: nowMarker()
  });
}

function systemMessageOperation(jobId, message, code) {
  return operation("set", `jobMessages/${id("message")}`, {
    jobId,
    senderId: "system",
    senderRole: "system",
    visibility: "participants",
    text: text(message, "Message", { required: true }),
    systemCode: code || "",
    readBy: [],
    attachments: [],
    createdAt: nowMarker()
  });
}

function paymentEventOperation(paymentId, jobId, eventType, details = {}) {
  return operation("set", `paymentEvents/${id("payment_event")}`, {
    paymentId,
    jobId,
    eventType,
    stripeEventId: details.stripeEventId || "",
    stripeObjectId: details.stripeObjectId || "",
    note: text(details.note, "Payment event note", { maximum: 1600 }),
    createdAt: nowMarker()
  });
}

function supportOperation(user, details) {
  const ticketId = id("ticket");
  return {
    ticketId,
    op: operation("set", `supportTickets/${ticketId}`, {
      id: ticketId,
      uid: user.uid,
      userId: user.uid,
      userEmail: user.profile.email || "",
      name: userName(user.profile),
      email: user.profile.email || "",
      topic: text(details.topic, "Topic", { required: true, maximum: MAX_SHORT_TEXT }),
      priority: ["normal", "urgent"].includes(details.priority) ? details.priority : "normal",
      message: text(details.message, "Message", { required: true }),
      jobId: text(details.jobId, "Job ID", { maximum: MAX_SHORT_TEXT }),
      status: "open",
      createdAt: nowMarker(),
      updatedAt: nowMarker()
    })
  };
}

async function all(collection) {
  const snapshot = await db().collection(collection).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function get(collection, recordId) {
  if (!recordId) return null;
  const snapshot = await db().collection(collection).doc(recordId).get();
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

async function getJob(jobId) {
  const job = await get("jobs", jobId);
  if (!job) throw httpError(404, "This service request no longer exists.");
  return job;
}

async function privateDetails(jobId) {
  return (await get(`jobs/${jobId}/private`, "customer")) || {};
}

async function getUser(uid) {
  return get("users", uid) || {};
}

function requireActive(user) {
  if (isSuspended(user.profile)) throw httpError(403, "Your account access is limited.");
}

function requireAdmin(user) {
  requireActive(user);
  if (!isAdminRole(user.profile)) throw httpError(403, "Admin or owner access is required.");
}

function requireStaff(user) {
  requireActive(user);
  if (!isStaffRole(user.profile)) throw httpError(403, "Staff access is required.");
}

function requireApprovedContractor(user) {
  requireActive(user);
  if (!isApprovedContractor(user.profile)) throw httpError(403, "Only approved contractors can use this action.");
}

function requirePayoutReady(profile) {
  if (!PLATFORM_PAYMENTS_REQUIRED) return;
  if (!profile.stripeAccountId || !profile.stripeOnboardingComplete || !profile.stripePayoutsEnabled) {
    throw httpError(402, "Complete Stripe Test Mode payment setup before using paid job actions.", "stripe_setup_required");
  }
}

function ownerOf(user, job) {
  return Boolean(job && job.postedBy === user.uid);
}

function acceptedContractor(user, job) {
  return Boolean(job && job.acceptedContractorId === user.uid);
}

function participant(user, job) {
  return ownerOf(user, job) || acceptedContractor(user, job);
}

function publicContractorProfile(profile) {
  return {
    uid: profile.uid || "",
    displayName: profile.displayName || "",
    businessName: profile.businessName || "",
    photoURL: profile.photoURL || "",
    city: profile.city || "",
    zipCode: profile.zipCode || "",
    serviceRadius: profile.serviceRadius || "",
    servicesOffered: profile.servicesOffered || profile.skills || [],
    skills: profile.skills || [],
    yearsExperience: profile.yearsExperience || profile.experience || "",
    contractorStatus: profile.contractorStatus || "",
    stripeTestReady: Boolean(profile.stripeOnboardingComplete && profile.stripePayoutsEnabled && profile.stripeMode !== "live"),
    completedJobCount: Number(profile.completedJobCount || 0),
    averageRating: Number(profile.averageRating || 0),
    reviewCount: Number(profile.reviewCount || 0)
  };
}

function paymentForUser(payment, user, job) {
  if (!payment) return null;
  const admin = isAdminRole(user.profile);
  const visible = admin || ownerOf(user, job) || acceptedContractor(user, job);
  if (!visible) return null;
  const output = {
    id: payment.id,
    jobId: payment.jobId,
    buyerId: payment.buyerId,
    contractorId: payment.contractorId,
    finalAmountCents: payment.finalAmountCents,
    platformFeePercentage: payment.platformFeePercentage,
    platformFeeCents: payment.platformFeeCents,
    contractorPercentage: payment.contractorPercentage,
    contractorAmountCents: payment.contractorAmountCents,
    currency: payment.currency,
    stripeMode: payment.stripeMode,
    paymentStatus: payment.paymentStatus,
    releaseStatus: payment.releaseStatus,
    refundStatus: payment.refundStatus,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    paidAt: payment.paidAt,
    releasedAt: payment.releasedAt,
    refundedAt: payment.refundedAt
  };
  if (admin) {
    output.stripePaymentIntentId = payment.stripePaymentIntentId || "";
    output.stripeCheckoutSessionId = payment.stripeCheckoutSessionId || "";
    output.stripeChargeId = payment.stripeChargeId || "";
    output.stripeTransferId = payment.stripeTransferId || "";
    output.stripeConnectedAccountId = payment.stripeConnectedAccountId || "";
  }
  return output;
}

function publicJob(job) {
  const output = stripPrivateJobFields(job);
  delete output.completionPhotoURLs;
  delete output.privateDetailsReleasedAt;
  return output;
}

function haversineMiles(aLat, aLng, bLat, bLng) {
  const values = [aLat, aLng, bLat, bLng].map(numberOrNull);
  if (values.some(value => value == null)) return null;
  const [lat1, lng1, lat2, lng2] = values;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function radiusMiles(profile) {
  const explicit = numberOrNull(profile.serviceRadiusMiles);
  if (explicit != null) return explicit;
  const match = String(profile.serviceRadius || "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

async function nearbyJob(job, profile) {
  const privateJob = await privateDetails(job.id);
  const jobLat = numberOrNull(privateJob.latitude != null ? privateJob.latitude : job.latitude);
  const jobLng = numberOrNull(privateJob.longitude != null ? privateJob.longitude : job.longitude);
  const contractorLat = numberOrNull(profile.latitude);
  const contractorLng = numberOrNull(profile.longitude);
  const distance = haversineMiles(contractorLat, contractorLng, jobLat, jobLng);
  if (distance != null) {
    const radius = radiusMiles(profile);
    return { matches: radius == null || distance <= radius, distanceMiles: Math.round(distance * 10) / 10 };
  }
  const city = String(job.city || "").trim().toLowerCase();
  const zip = String(job.zipCode || "").trim();
  const contractorCity = String(profile.city || profile.serviceCity || "").trim().toLowerCase();
  const contractorZip = String(profile.zipCode || profile.serviceZipCode || "").trim();
  return {
    matches: Boolean((zip && contractorZip && zip === contractorZip) || (city && contractorCity && city === contractorCity)),
    distanceMiles: null
  };
}

function hasServiceLocation(profile) {
  return Boolean(
    (numberOrNull(profile.latitude) != null && numberOrNull(profile.longitude) != null) ||
    profile.city ||
    profile.serviceCity ||
    profile.zipCode ||
    profile.serviceZipCode
  );
}

async function availableJobs(user) {
  if (!isApprovedContractor(user.profile) && !isAdminRole(user.profile)) return [];
  if (!isAdminRole(user.profile) && !hasServiceLocation(user.profile)) return [];
  const jobs = (await all("jobs")).filter(job => ["open", "quotes_received"].includes(job.status));
  const output = [];
  for (const job of jobs) {
    const match = isAdminRole(user.profile) ? { matches: true, distanceMiles: null } : await nearbyJob(job, user.profile);
    if (!match.matches) continue;
    output.push({ ...publicJob(job), approximateDistanceMiles: match.distanceMiles });
  }
  return output.sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt));
}

async function assertNearby(job, user) {
  if (!hasServiceLocation(user.profile)) throw httpError(400, "Add your service location before quoting jobs.", "location_required");
  if (!(await nearbyJob(job, user.profile)).matches) throw httpError(403, "This request is outside your service area.");
}

function assertRate(records, uid, field, limit, windowMs, message) {
  const cutoff = Date.now() - windowMs;
  const count = records.filter(record => record[field] === uid && timestampMs(record.createdAt || record.submittedAt) >= cutoff).length;
  if (count >= limit) throw httpError(429, message);
}

function safeJobEditFields(body) {
  return {
    title: text(body.title, "Job title", { required: true, maximum: MAX_SHORT_TEXT }),
    serviceType: text(body.serviceType, "Service type", { required: true, maximum: MAX_SHORT_TEXT }),
    city: text(body.city, "City", { required: true, maximum: 120 }),
    zipCode: text(body.zipCode, "ZIP code", { required: true, maximum: 20 }),
    propertySize: text(body.propertySize, "Property size", { required: true, maximum: MAX_SHORT_TEXT }),
    budget: text(body.budget, "Budget range", { required: true, maximum: MAX_SHORT_TEXT }),
    frequency: text(body.frequency, "Frequency", { required: true, maximum: MAX_SHORT_TEXT }),
    preferredDate: text(body.preferredDate, "Preferred date", { maximum: 80 }) || null,
    details: text(body.details, "Job details", { required: true }),
    photoURLs: photoUrls(body.photoURLs),
    petsOnProperty: Boolean(body.petsOnProperty),
    dangerousDebris: Boolean(body.dangerousDebris),
    steepSlope: Boolean(body.steepSlope),
    powerLines: Boolean(body.powerLines),
    safetyConcerns: text(body.safetyConcerns, "Safety concerns", { maximum: 1200 })
  };
}

async function createJob(user, body) {
  requireActive(user);
  const jobs = await all("jobs");
  assertRate(jobs, user.uid, "postedBy", 5, 24 * 60 * 60 * 1000, "You have submitted several requests recently. Contact support if you need help.");
  const fields = safeJobEditFields(body);
  const fullAddress = text(body.fullAddress, "Full address", { required: true, maximum: 500 });
  const posterPhone = text(body.posterPhone, "Phone number", { required: true, maximum: 80 });
  const recentOwnJobs = jobs.filter(job => job.postedBy === user.uid && timestampMs(job.createdAt) >= Date.now() - 24 * 60 * 60 * 1000);
  for (const existing of recentOwnJobs) {
    const details = await privateDetails(existing.id);
    if (existing.serviceType === fields.serviceType && String(details.fullAddress || "").toLowerCase() === fullAddress.toLowerCase()) {
      throw httpError(409, "A similar request for this address was submitted recently. Review My Requests before posting a duplicate.");
    }
  }
  const jobId = id("job");
  const verificationRequired = String(process.env.REQUIRE_EMAIL_VERIFICATION || "false").toLowerCase() === "true";
  const initialStatus = verificationRequired && user.profile.emailVerified === false ? "pending_verification" : "open";
  const publicRecord = {
    id: jobId,
    postedBy: user.uid,
    buyerId: user.uid,
    ...fields,
    status: initialStatus,
    quoteCount: 0,
    acceptedQuoteId: null,
    acceptedContractorId: null,
    acceptedContractorName: "",
    paymentStatus: "not_required",
    scheduleStatus: "preferred_only",
    proposedSchedule: null,
    confirmedSchedule: null,
    createdAt: nowMarker(),
    updatedAt: nowMarker()
  };
  const privateRecord = {
    posterName: userName(user.profile),
    posterEmail: user.profile.email || "",
    posterPhone,
    fullAddress,
    latitude: numberOrNull(body.latitude),
    longitude: numberOrNull(body.longitude),
    locationAccuracyMeters: numberOrNull(body.locationAccuracyMeters),
    gateInstructions: text(body.gateInstructions, "Gate or lock instructions", { maximum: 1200 }),
    parkingInstructions: text(body.parkingInstructions, "Parking or access instructions", { maximum: 1200 }),
    privateNotes: text(body.privateNotes, "Private notes", { maximum: 1200 }),
    createdAt: nowMarker(),
    updatedAt: nowMarker()
  };
  await systemWrite([
    operation("set", `jobs/${jobId}`, publicRecord),
    operation("set", `jobs/${jobId}/private/customer`, privateRecord),
    statusHistoryOperation(user, jobId, null, initialStatus),
    auditOperation(user, "job.created", "job", jobId, { newValue: { status: initialStatus } })
  ], "Create JCM service request");
  return { job: publicJob(publicRecord) };
}

async function updateJob(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  if (!ownerOf(user, job)) throw httpError(403, "Only the buyer who posted this request can edit it.");
  if (!["pending_verification", "open", "quotes_received"].includes(job.status)) {
    throw httpError(409, "This request can no longer be edited.");
  }
  const fields = safeJobEditFields({ ...job, ...body });
  const quoteRecords = (await all("jobQuotes")).filter(quote => quote.jobId === job.id && quote.status === "submitted");
  const changed = Object.keys(fields).filter(field => JSON.stringify(fields[field]) !== JSON.stringify(job[field]));
  if (!changed.length) return { job: publicJob(job), quotesInvalidated: 0 };
  const ops = [
    operation("update", `jobs/${job.id}`, {
      ...fields,
      status: quoteRecords.length ? "open" : job.status,
      quoteCount: quoteRecords.length ? 0 : job.quoteCount,
      updatedAt: nowMarker()
    }),
    operation("set", `jobEdits/${id("edit")}`, {
      jobId: job.id,
      ...actor(user),
      changedFields: changed,
      oldValue: Object.fromEntries(changed.map(field => [field, job[field]])),
      newValue: Object.fromEntries(changed.map(field => [field, fields[field]])),
      createdAt: nowMarker()
    }),
    auditOperation(user, "job.edited", "job", job.id, { note: `Changed fields: ${changed.join(", ")}` })
  ];
  quoteRecords.forEach(quote => {
    ops.push(operation("update", `jobQuotes/${quote.id}`, {
      status: "needs_resubmission",
      updatedAt: nowMarker()
    }));
  });
  if (quoteRecords.length) {
    ops.push(systemMessageOperation(job.id, "The buyer edited important request details. Existing quotes need to be reviewed and resubmitted.", "job_edited_quotes_invalidated"));
  }
  await systemWrite(ops, "Edit JCM service request");
  return { job: publicJob({ ...job, ...fields, status: quoteRecords.length ? "open" : job.status }), quotesInvalidated: quoteRecords.length };
}

async function submitQuote(user, body) {
  requireApprovedContractor(user);
  requirePayoutReady(user.profile);
  const job = await getJob(body.jobId);
  if (!["open", "quotes_received"].includes(job.status)) throw httpError(409, "This request is not accepting quotes.");
  if (job.postedBy === user.uid) throw httpError(403, "You cannot quote your own service request.");
  await assertNearby(job, user);
  const quotes = await all("jobQuotes");
  assertRate(quotes, user.uid, "contractorId", 15, 24 * 60 * 60 * 1000, "You have submitted several quotes recently. Try again later.");
  const existing = quotes.find(quote => quote.jobId === job.id && quote.contractorId === user.uid && quote.status === "submitted");
  if (existing) throw httpError(409, "You already submitted a quote for this request.");
  const priceCents = body.priceCents == null || body.priceCents === "" ? null : cents(body.priceCents, "Quote price");
  const priceNote = text(body.priceNote, "Price note", { maximum: 500 });
  if (priceCents == null && !priceNote) throw httpError(400, "Enter a quote price or a price note.");
  const quoteId = id("quote");
  const quote = {
    id: quoteId,
    jobId: job.id,
    contractorId: user.uid,
    contractorDisplayName: userName(user.profile),
    contractorBusinessName: user.profile.businessName || "",
    priceCents,
    priceNote,
    availabilityNote: text(body.availabilityNote, "Availability note", { required: true, maximum: 800 }),
    message: text(body.message, "Message to buyer", { required: true, maximum: 1600 }),
    estimatedDuration: text(body.estimatedDuration, "Estimated duration", { maximum: 200 }),
    status: "submitted",
    createdAt: nowMarker(),
    updatedAt: nowMarker()
  };
  const nextStatus = job.status === "open" ? "quotes_received" : job.status;
  const ops = [
    operation("set", `jobQuotes/${quoteId}`, quote),
    operation("update", `jobs/${job.id}`, { status: nextStatus, quoteCount: Number(job.quoteCount || 0) + 1, updatedAt: nowMarker() }),
    auditOperation(user, "quote.created", "jobQuote", quoteId, { newValue: { jobId: job.id, status: "submitted" } })
  ];
  if (nextStatus !== job.status) ops.push(statusHistoryOperation(user, job.id, job.status, nextStatus));
  await systemWrite(ops, "Submit JCM job quote");
  return { quote };
}

async function withdrawQuote(user, body) {
  requireApprovedContractor(user);
  const quote = await get("jobQuotes", body.quoteId);
  if (!quote || quote.contractorId !== user.uid) throw httpError(404, "Quote not found.");
  if (quote.status !== "submitted") throw httpError(409, "This quote cannot be withdrawn.");
  await systemWrite([
    operation("update", `jobQuotes/${quote.id}`, { status: "withdrawn", updatedAt: nowMarker() }),
    auditOperation(user, "quote.withdrawn", "jobQuote", quote.id, { oldValue: { status: quote.status }, newValue: { status: "withdrawn" } })
  ], "Withdraw JCM job quote");
  return { ok: true };
}

async function acceptQuote(user, body) {
  requireActive(user);
  const quote = await get("jobQuotes", body.quoteId);
  if (!quote) throw httpError(404, "Quote not found.");
  const job = await getJob(quote.jobId);
  if (!ownerOf(user, job)) throw httpError(403, "Only the buyer can accept a contractor.");
  if (!["open", "quotes_received"].includes(job.status) || job.acceptedContractorId) {
    throw httpError(409, "A contractor can no longer be accepted for this request.");
  }
  if (quote.status !== "submitted") throw httpError(409, "This quote is no longer available.");
  const contractor = await getUser(quote.contractorId);
  if (!isApprovedContractor(contractor) || isSuspended(contractor)) throw httpError(409, "This contractor is not currently available.");
  requirePayoutReady(contractor);
  const quotes = (await all("jobQuotes")).filter(item => item.jobId === job.id && item.status === "submitted");
  const ops = [
    operation("update", `jobs/${job.id}`, {
      status: "awaiting_final_offer",
      acceptedQuoteId: quote.id,
      acceptedContractorId: quote.contractorId,
      acceptedContractorName: quote.contractorBusinessName || quote.contractorDisplayName,
      paymentStatus: "awaiting_final_offer",
      acceptedAt: nowMarker(),
      updatedAt: nowMarker()
    }),
    statusHistoryOperation(user, job.id, job.status, "contractor_accepted"),
    statusHistoryOperation(user, job.id, "contractor_accepted", "awaiting_final_offer"),
    systemMessageOperation(job.id, `${quote.contractorBusinessName || quote.contractorDisplayName} was accepted. Use this chat to agree on final scope, price, and timing.`, "contractor_accepted"),
    auditOperation(user, "quote.accepted", "jobQuote", quote.id, { newValue: { jobId: job.id, contractorId: quote.contractorId } })
  ];
  quotes.forEach(item => {
    ops.push(operation("update", `jobQuotes/${item.id}`, {
      status: item.id === quote.id ? "accepted" : "not_selected",
      updatedAt: nowMarker()
    }));
  });
  await systemWrite(ops, "Accept JCM contractor quote");
  return { ok: true, jobId: job.id };
}

async function sendMessage(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  if (!participant(user, job)) throw httpError(403, "Messaging is available only to the buyer and accepted contractor.");
  if (["closed"].includes(job.status)) throw httpError(409, "This conversation is read-only because the job is closed.");
  const messageId = id("message");
  const message = {
    id: messageId,
    jobId: job.id,
    senderId: user.uid,
    senderRole: normalizedRole(user.profile),
    visibility: "participants",
    text: text(body.message, "Message", { required: true }),
    attachments: photoUrls(body.attachments || [], 4),
    readBy: [user.uid],
    createdAt: nowMarker()
  };
  await systemWrite([
    operation("set", `jobMessages/${messageId}`, message),
    auditOperation(user, "message.created", "jobMessage", messageId, { newValue: { jobId: job.id } })
  ], "Send JCM job message");
  return { message };
}

async function createFinalOffer(user, body) {
  requireApprovedContractor(user);
  requirePayoutReady(user.profile);
  const job = await getJob(body.jobId);
  if (!acceptedContractor(user, job)) throw httpError(403, "Only the accepted contractor can create the final offer.");
  if (!["awaiting_final_offer", "awaiting_buyer_offer_acceptance"].includes(job.status)) {
    throw httpError(409, "A final offer cannot be submitted at this stage.");
  }
  const offerId = id("offer");
  const finalAmountCents = cents(body.finalAmountCents, "Final price");
  const split = moneySplit(finalAmountCents);
  const offer = {
    id: offerId,
    jobId: job.id,
    buyerId: job.postedBy,
    contractorId: user.uid,
    ...split,
    currency: "usd",
    scopeSummary: text(body.scopeSummary, "Scope summary", { required: true }),
    proposedSchedule: text(body.proposedSchedule, "Proposed date, time, or arrival window", { required: true, maximum: 800 }),
    notes: text(body.notes, "Offer notes", { maximum: 1200 }),
    expiresAt: text(body.expiresAt, "Expiration timestamp", { maximum: 80 }) || null,
    status: "submitted",
    createdAt: nowMarker(),
    updatedAt: nowMarker()
  };
  await systemWrite([
    operation("set", `finalOffers/${offerId}`, offer),
    operation("update", `jobs/${job.id}`, {
      status: "awaiting_buyer_offer_acceptance",
      latestFinalOfferId: offerId,
      paymentStatus: "awaiting_buyer_acceptance",
      updatedAt: nowMarker()
    }),
    statusHistoryOperation(user, job.id, job.status, "awaiting_buyer_offer_acceptance"),
    systemMessageOperation(job.id, "The contractor submitted a formal final offer. The buyer can accept or reject it.", "final_offer_submitted"),
    auditOperation(user, "final_offer.created", "finalOffer", offerId, { newValue: { jobId: job.id, finalAmountCents } })
  ], "Create JCM final offer");
  return { offer };
}

async function respondFinalOffer(user, body) {
  requireActive(user);
  const offer = await get("finalOffers", body.offerId);
  if (!offer) throw httpError(404, "Final offer not found.");
  const job = await getJob(offer.jobId);
  if (!ownerOf(user, job)) throw httpError(403, "Only the buyer can respond to this final offer.");
  if (job.latestFinalOfferId !== offer.id || offer.status !== "submitted" || job.status !== "awaiting_buyer_offer_acceptance") {
    throw httpError(409, "This final offer is no longer awaiting a response.");
  }
  const decision = String(body.decision || "").toLowerCase();
  if (!["accept", "reject"].includes(decision)) throw httpError(400, "Choose accept or reject.");
  if (decision === "reject") {
    await systemWrite([
      operation("update", `finalOffers/${offer.id}`, {
        status: "rejected",
        buyerResponseNote: text(body.note, "Response note", { maximum: 1200 }),
        respondedAt: nowMarker(),
        updatedAt: nowMarker()
      }),
      operation("update", `jobs/${job.id}`, {
        status: "awaiting_final_offer",
        paymentStatus: "awaiting_final_offer",
        updatedAt: nowMarker()
      }),
      statusHistoryOperation(user, job.id, job.status, "awaiting_final_offer"),
      systemMessageOperation(job.id, "The buyer rejected the final offer. Continue the conversation and submit a revised offer when ready.", "final_offer_rejected"),
      auditOperation(user, "final_offer.rejected", "finalOffer", offer.id, { reason: body.note })
    ], "Reject JCM final offer");
    return { ok: true, decision };
  }
  const contractor = await getUser(job.acceptedContractorId);
  requirePayoutReady(contractor);
  const split = moneySplit(offer.finalAmountCents);
  const paymentId = `payment_${job.id}`;
  const payment = {
    id: paymentId,
    jobId: job.id,
    buyerId: job.postedBy,
    contractorId: job.acceptedContractorId,
    ...split,
    currency: "usd",
    stripeMode: stripeMode(),
    transferGroup: `JCM_JOB_${job.id}`,
    stripePaymentIntentId: "",
    stripeCheckoutSessionId: "",
    stripeChargeId: "",
    stripeTransferId: "",
    stripeConnectedAccountId: contractor.stripeAccountId,
    paymentStatus: "awaiting_payment",
    releaseStatus: "not_released",
    refundStatus: "not_refunded",
    createdAt: nowMarker(),
    updatedAt: nowMarker()
  };
  await systemWrite([
    operation("update", `finalOffers/${offer.id}`, {
      status: "accepted",
      respondedAt: nowMarker(),
      updatedAt: nowMarker()
    }),
    operation("set", `jobPayments/${paymentId}`, payment),
    operation("update", `jobs/${job.id}`, {
      status: "awaiting_payment",
      paymentId,
      paymentStatus: "awaiting_payment",
      finalAmountCents: split.finalAmountCents,
      platformFeeCents: split.platformFeeCents,
      contractorAmountCents: split.contractorAmountCents,
      finalScopeSummary: offer.scopeSummary,
      updatedAt: nowMarker()
    }),
    statusHistoryOperation(user, job.id, job.status, "awaiting_payment"),
    systemMessageOperation(job.id, "The buyer accepted the final offer. Secure Job Payment is required before scheduling and work can begin.", "final_offer_accepted"),
    auditOperation(user, "final_offer.accepted", "finalOffer", offer.id, { newValue: { paymentId, finalAmountCents: split.finalAmountCents } }),
    auditOperation(user, "payment.created", "jobPayment", paymentId, { newValue: { jobId: job.id, paymentStatus: "awaiting_payment" } })
  ], "Accept JCM final offer");
  return { ok: true, decision, payment: paymentForUser(payment, user, job) };
}

async function startCheckout(user, req, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  if (!ownerOf(user, job)) throw httpError(403, "Only the buyer can pay for this job.");
  if (job.status !== "awaiting_payment" || !job.paymentId) throw httpError(409, "This job is not awaiting payment.");
  const payment = await get("jobPayments", job.paymentId);
  if (!payment) throw httpError(409, "The job payment record is missing.");
  if (payment.paymentStatus !== "awaiting_payment" && payment.stripeCheckoutSessionUrl) {
    return { url: payment.stripeCheckoutSessionUrl, mode: stripeModeSummary() };
  }
  const session = await createCheckoutSession(req, payment, job, user);
  await systemWrite([
    operation("update", `jobPayments/${payment.id}`, {
      stripeCheckoutSessionId: session.id,
      stripeCheckoutSessionUrl: session.url,
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : "",
      updatedAt: nowMarker()
    }),
    paymentEventOperation(payment.id, job.id, "checkout.created", { stripeObjectId: session.id }),
    auditOperation(user, "payment.checkout_created", "jobPayment", payment.id, { newValue: { stripeCheckoutSessionId: session.id } })
  ], "Create JCM Stripe Checkout session");
  return { url: session.url, mode: stripeModeSummary() };
}

async function proposeSchedule(user, body) {
  requireApprovedContractor(user);
  const job = await getJob(body.jobId);
  if (!acceptedContractor(user, job)) throw httpError(403, "Only the accepted contractor can propose a schedule.");
  if (!["payment_held", "scheduling"].includes(job.status)) throw httpError(409, "The buyer payment must be held before scheduling.");
  const proposedSchedule = {
    date: text(body.date, "Proposed date", { required: true, maximum: 80 }),
    timeWindow: text(body.timeWindow, "Arrival window", { required: true, maximum: 160 }),
    notes: text(body.notes, "Schedule notes", { maximum: 800 }),
    proposedBy: user.uid,
    proposedAt: nowMarker()
  };
  const next = "scheduling";
  const ops = [
    operation("update", `jobs/${job.id}`, { status: next, scheduleStatus: "proposed", proposedSchedule, updatedAt: nowMarker() }),
    systemMessageOperation(job.id, `The contractor proposed a schedule: ${proposedSchedule.date}, ${proposedSchedule.timeWindow}.`, "schedule_proposed"),
    auditOperation(user, "schedule.proposed", "job", job.id, { newValue: proposedSchedule })
  ];
  if (job.status !== next) ops.push(statusHistoryOperation(user, job.id, job.status, next));
  await systemWrite(ops, "Propose JCM schedule");
  return { ok: true };
}

async function confirmSchedule(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  if (!ownerOf(user, job)) throw httpError(403, "Only the buyer can confirm the schedule.");
  if (job.status !== "scheduling" || !job.proposedSchedule) throw httpError(409, "There is no proposed schedule to confirm.");
  await systemWrite([
    operation("update", `jobs/${job.id}`, {
      status: "scheduled",
      scheduleStatus: "confirmed",
      confirmedSchedule: { ...job.proposedSchedule, confirmedBy: user.uid, confirmedAt: nowMarker() },
      updatedAt: nowMarker()
    }),
    statusHistoryOperation(user, job.id, job.status, "scheduled"),
    systemMessageOperation(job.id, "The buyer confirmed the proposed schedule.", "schedule_confirmed"),
    auditOperation(user, "schedule.confirmed", "job", job.id, { newValue: job.proposedSchedule })
  ], "Confirm JCM schedule");
  return { ok: true };
}

async function startWork(user, body) {
  requireApprovedContractor(user);
  requirePayoutReady(user.profile);
  const job = await getJob(body.jobId);
  if (!acceptedContractor(user, job)) throw httpError(403, "Only the accepted contractor can start work.");
  if (job.status !== "scheduled" || job.scheduleStatus !== "confirmed") throw httpError(409, "The schedule must be confirmed before work begins.");
  const payment = await get("jobPayments", job.paymentId);
  if (!payment || payment.paymentStatus !== "held_pending_completion") throw httpError(409, "Secure Job Payment must be held before work begins.");
  await systemWrite([
    operation("update", `jobs/${job.id}`, { status: "in_progress", startedAt: nowMarker(), updatedAt: nowMarker() }),
    statusHistoryOperation(user, job.id, job.status, "in_progress"),
    systemMessageOperation(job.id, "The contractor marked the job in progress.", "job_in_progress"),
    auditOperation(user, "job.started", "job", job.id)
  ], "Start JCM job");
  return { ok: true };
}

async function completeWork(user, body) {
  requireApprovedContractor(user);
  const job = await getJob(body.jobId);
  if (!acceptedContractor(user, job)) throw httpError(403, "Only the accepted contractor can mark this job complete.");
  if (job.status !== "in_progress") throw httpError(409, "This job is not in progress.");
  const completionPhotoURLs = photoUrls(body.completionPhotoURLs || []);
  await systemWrite([
    operation("update", `jobs/${job.id}`, {
      status: "contractor_completed",
      completionPhotoURLs,
      completionNote: text(body.note, "Completion note", { maximum: 1200 }),
      contractorCompletedAt: nowMarker(),
      updatedAt: nowMarker()
    }),
    statusHistoryOperation(user, job.id, job.status, "contractor_completed"),
    systemMessageOperation(job.id, "The contractor marked the job complete. The buyer can confirm completion or open a dispute.", "contractor_completed"),
    auditOperation(user, "job.contractor_completed", "job", job.id, { newValue: { completionPhotoCount: completionPhotoURLs.length } })
  ], "Complete JCM job work");
  return { ok: true };
}

async function releasePayment(user, job, reason, options = {}) {
  const payment = await get("jobPayments", job.paymentId);
  if (!payment) throw httpError(409, "The job payment record is missing.");
  if (payment.stripeTransferId || payment.paymentStatus === "released_to_contractor") {
    return { payment, alreadyReleased: true };
  }
  if (!["held_pending_completion", "release_requested"].includes(payment.paymentStatus)) {
    throw httpError(409, "This payment is not eligible for release.");
  }
  const contractor = await getUser(job.acceptedContractorId);
  requirePayoutReady(contractor);
  if (payment.contractorAmountCents !== moneySplit(payment.finalAmountCents).contractorAmountCents) {
    throw httpError(409, "Stored contractor payout does not match the server-side 70% calculation.");
  }
  await systemWrite([
    operation("update", `jobPayments/${payment.id}`, { paymentStatus: "release_requested", releaseStatus: "release_requested", updatedAt: nowMarker() }),
    paymentEventOperation(payment.id, job.id, "transfer.release_requested", { note: reason }),
    auditOperation(user, "payment.release_requested", "jobPayment", payment.id, { reason })
  ], "Request JCM contractor payment release");
  const transfer = await createContractorTransfer({ ...payment, paymentStatus: "release_requested" });
  const completedJobs = Number(contractor.completedJobCount || 0) + 1;
  await systemWrite([
    operation("update", `jobPayments/${payment.id}`, {
      stripeTransferId: transfer.id,
      paymentStatus: "released_to_contractor",
      releaseStatus: "released_to_contractor",
      releasedAt: nowMarker(),
      updatedAt: nowMarker()
    }),
    operation("set", `payoutRecords/${id("payout")}`, {
      jobId: job.id,
      paymentId: payment.id,
      contractorId: job.acceptedContractorId,
      amountCents: payment.contractorAmountCents,
      currency: payment.currency,
      stripeMode: payment.stripeMode,
      stripeTransferId: transfer.id,
      status: "released_to_contractor",
      reason: text(reason, "Release reason", { maximum: 800 }),
      createdAt: nowMarker()
    }),
    operation("update", `jobs/${job.id}`, {
      status: "completed",
      paymentStatus: "released_to_contractor",
      completedAt: nowMarker(),
      updatedAt: nowMarker()
    }),
    operation("set", `users/${job.acceptedContractorId}`, { completedJobCount: completedJobs, updatedAt: nowMarker() }, true),
    statusHistoryOperation(user, job.id, job.status, "completed", reason),
    paymentEventOperation(payment.id, job.id, "transfer.released", { stripeObjectId: transfer.id, note: reason }),
    systemMessageOperation(job.id, "Payment was released after completion. The contractor receives 70% and JCM keeps the 30% platform fee.", "payment_released"),
    auditOperation(user, "payment.released", "jobPayment", payment.id, { reason, newValue: { stripeTransferId: transfer.id } })
  ], "Release JCM contractor payment");
  return { payment: { ...payment, stripeTransferId: transfer.id, paymentStatus: "released_to_contractor" }, alreadyReleased: false };
}

async function disputeJob(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  if (!ownerOf(user, job)) throw httpError(403, "Only the buyer can dispute completion.");
  if (!["contractor_completed", "in_progress"].includes(job.status)) throw httpError(409, "This job cannot be disputed at this stage.");
  const reason = assertCancellationReason(body.reason);
  const disputeId = id("dispute");
  await systemWrite([
    operation("set", `jobDisputes/${disputeId}`, {
      id: disputeId,
      jobId: job.id,
      buyerId: job.postedBy,
      contractorId: job.acceptedContractorId,
      openedBy: user.uid,
      reason,
      note: text(body.note, "Dispute note", { required: true, maximum: 1600 }),
      status: "open",
      createdAt: nowMarker(),
      updatedAt: nowMarker()
    }),
    operation("update", `jobs/${job.id}`, { status: "disputed", activeDisputeId: disputeId, paymentStatus: "disputed_payment", updatedAt: nowMarker() }),
    operation("update", `jobPayments/${job.paymentId}`, { paymentStatus: "disputed_payment", releaseStatus: "blocked_by_dispute", updatedAt: nowMarker() }),
    statusHistoryOperation(user, job.id, job.status, "disputed", reason, body.note),
    systemMessageOperation(job.id, "The buyer opened a dispute. Contractor payment release is blocked while JCM reviews the issue.", "dispute_opened"),
    auditOperation(user, "dispute.opened", "jobDispute", disputeId, { reason, note: body.note })
  ], "Open JCM job dispute");
  return { ok: true, disputeId };
}

async function confirmCompletion(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  if (!ownerOf(user, job)) throw httpError(403, "Only the buyer can confirm completion.");
  if (job.status !== "contractor_completed") throw httpError(409, "This job is not awaiting completion confirmation.");
  const result = await releasePayment(user, job, "Buyer confirmed completion.");
  return { ok: true, alreadyReleased: result.alreadyReleased };
}

async function refundPayment(user, job, reason, finalJobStatus = "canceled") {
  const payment = await get("jobPayments", job.paymentId);
  if (!payment) throw httpError(409, "The job payment record is missing.");
  if (payment.stripeTransferId) throw httpError(409, "This payment has already been released and cannot be refunded automatically.");
  if (payment.paymentStatus === "refunded") return { payment, alreadyRefunded: true };
  const refund = await createFullRefund(payment, reason);
  await systemWrite([
    operation("update", `jobPayments/${payment.id}`, {
      paymentStatus: "refunded",
      refundStatus: "refunded",
      stripeRefundId: refund.id,
      refundedAt: nowMarker(),
      updatedAt: nowMarker()
    }),
    operation("update", `jobs/${job.id}`, { status: finalJobStatus, paymentStatus: "refunded", updatedAt: nowMarker() }),
    statusHistoryOperation(user, job.id, job.status, finalJobStatus, reason),
    paymentEventOperation(payment.id, job.id, "refund.issued", { stripeObjectId: refund.id, note: reason }),
    systemMessageOperation(job.id, "A full buyer refund was issued through Stripe.", "refund_issued"),
    auditOperation(user, "payment.refunded", "jobPayment", payment.id, { reason, newValue: { stripeRefundId: refund.id } })
  ], "Refund JCM job payment");
  return { payment: { ...payment, stripeRefundId: refund.id, paymentStatus: "refunded" }, alreadyRefunded: false };
}

async function cancelJob(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  const admin = isAdminRole(user.profile);
  const authorized = ownerOf(user, job) || acceptedContractor(user, job) || admin;
  if (!authorized) throw httpError(403, "You cannot cancel this request.");
  if (["in_progress", "contractor_completed", "completed", "disputed", "closed"].includes(job.status)) {
    throw httpError(409, "This job requires a dispute or admin review instead of direct cancellation.");
  }
  const reason = assertCancellationReason(body.reason);
  if (admin && !text(body.note, "Admin reason", { required: true, maximum: 1600 })) throw httpError(400, "Admin reason is required.");
  if (job.paymentId) {
    const payment = await get("jobPayments", job.paymentId);
    if (payment && ["payment_authorized_or_paid", "held_pending_completion", "release_requested"].includes(payment.paymentStatus)) {
      await refundPayment(user, job, reason, "canceled");
      return { ok: true, refunded: true };
    }
  }
  const cancellationId = id("cancellation");
  await systemWrite([
    operation("set", `jobCancellations/${cancellationId}`, {
      id: cancellationId,
      jobId: job.id,
      ...actor(user),
      reason,
      note: text(body.note, "Cancellation note", { maximum: 1600 }),
      createdAt: nowMarker()
    }),
    operation("update", `jobs/${job.id}`, { status: "canceled", canceledAt: nowMarker(), updatedAt: nowMarker() }),
    statusHistoryOperation(user, job.id, job.status, "canceled", reason, body.note),
    systemMessageOperation(job.id, `The job was canceled: ${reason}.`, "job_canceled"),
    auditOperation(user, "job.canceled", "job", job.id, { reason, note: body.note })
  ], "Cancel JCM job");
  return { ok: true, refunded: false };
}

async function reopenJob(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  if (!ownerOf(user, job) && !isAdminRole(user.profile)) throw httpError(403, "Only the buyer or an admin can reopen this request.");
  if (job.status !== "canceled") throw httpError(409, "Only eligible canceled requests can be reopened.");
  if (job.paymentId) {
    const payment = await get("jobPayments", job.paymentId);
    if (payment && !["refunded", "awaiting_payment", "payment_failed"].includes(payment.paymentStatus)) {
      throw httpError(409, "Resolve the existing payment before reopening this request.");
    }
  }
  const reason = text(body.note, "Reopen reason", { required: true, maximum: 1200 });
  await systemWrite([
    operation("update", `jobs/${job.id}`, {
      status: "open",
      acceptedQuoteId: null,
      acceptedContractorId: null,
      acceptedContractorName: "",
      paymentId: null,
      paymentStatus: "not_required",
      scheduleStatus: "preferred_only",
      proposedSchedule: null,
      confirmedSchedule: null,
      updatedAt: nowMarker()
    }),
    statusHistoryOperation(user, job.id, job.status, "open", reason),
    auditOperation(user, "job.reopened", "job", job.id, { reason })
  ], "Reopen JCM job");
  return { ok: true };
}

async function revealPrivateDetails(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  const allowed = ownerOf(user, job) || isAdminRole(user.profile) || canAcceptedContractorViewPrivate(job, user.uid);
  if (!allowed) throw httpError(403, "Private buyer details are not available to this account.");
  const reason = text(body.reason, "Private detail access reason", {
    required: isAdminRole(user.profile),
    maximum: 800
  }) || (ownerOf(user, job) ? "Buyer viewed own request." : "Accepted contractor viewed post-acceptance job details.");
  const details = await privateDetails(job.id);
  await systemWrite([
    auditOperation(user, "private_details.revealed", "job", job.id, { reason })
  ], "Audit JCM private detail reveal");
  return {
    details: {
      posterName: details.posterName || "",
      posterEmail: details.posterEmail || "",
      posterPhone: details.posterPhone || "",
      fullAddress: details.fullAddress || "",
      gateInstructions: details.gateInstructions || "",
      parkingInstructions: details.parkingInstructions || "",
      privateNotes: details.privateNotes || ""
    }
  };
}

async function submitReview(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  if (!ownerOf(user, job)) throw httpError(403, "Only the buyer can review this contractor.");
  if (job.status !== "completed") throw httpError(409, "Reviews are available after confirmed completion.");
  const existing = (await all("jobReviews")).find(review => review.jobId === job.id);
  if (existing) throw httpError(409, "A review was already submitted for this job.");
  const rating = (value, label) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 5) throw httpError(400, `${label} must be between 1 and 5.`);
    return number;
  };
  const reviewId = id("review");
  const review = {
    id: reviewId,
    jobId: job.id,
    contractorId: job.acceptedContractorId,
    buyerId: job.postedBy,
    communicationRating: rating(body.communicationRating, "Communication rating"),
    qualityRating: rating(body.qualityRating, "Quality rating"),
    reliabilityRating: rating(body.reliabilityRating, "Reliability rating"),
    fairPricingRating: rating(body.fairPricingRating, "Fair pricing rating"),
    overallRating: rating(body.overallRating, "Overall rating"),
    writtenReview: text(body.writtenReview, "Written review", { maximum: 1600 }),
    createdAt: nowMarker()
  };
  const reviews = (await all("jobReviews")).filter(item => item.contractorId === job.acceptedContractorId);
  const averageRating = Math.round((reviews.reduce((sum, item) => sum + Number(item.overallRating || 0), 0) + review.overallRating) / (reviews.length + 1) * 10) / 10;
  await systemWrite([
    operation("set", `jobReviews/${reviewId}`, review),
    operation("set", `users/${job.acceptedContractorId}`, { averageRating, reviewCount: reviews.length + 1, updatedAt: nowMarker() }, true),
    auditOperation(user, "review.created", "jobReview", reviewId, { newValue: { jobId: job.id, overallRating: review.overallRating } })
  ], "Create JCM contractor review");
  return { review };
}

async function submitApplication(user, body) {
  requireActive(user);
  const existing = (await all("contractorApplications")).find(application => application.uid === user.uid && application.status === "pending");
  if (existing) throw httpError(409, "Your contractor application is already pending.");
  const applicationId = id("application");
  const serviceRadiusMiles = numberOrNull(body.serviceRadiusMiles);
  if (serviceRadiusMiles == null || serviceRadiusMiles <= 0 || serviceRadiusMiles > 250) {
    throw httpError(400, "Enter a service radius between 1 and 250 miles.");
  }
  const application = {
    id: applicationId,
    uid: user.uid,
    legalName: text(body.legalName || body.name, "Legal name", { required: true, maximum: MAX_SHORT_TEXT }),
    name: text(body.displayName || body.name, "Display name", { required: true, maximum: MAX_SHORT_TEXT }),
    businessName: text(body.businessName, "Business name", { maximum: MAX_SHORT_TEXT }),
    email: text(body.email || user.profile.email, "Email", { required: true, maximum: MAX_SHORT_TEXT }),
    phone: text(body.phone, "Phone", { required: true, maximum: 80 }),
    city: text(body.city, "City", { required: true, maximum: 120 }),
    zipCode: text(body.zipCode, "ZIP code", { required: true, maximum: 20 }),
    serviceLocation: text(body.serviceLocation, "Service location", { maximum: MAX_SHORT_TEXT }),
    latitude: numberOrNull(body.latitude),
    longitude: numberOrNull(body.longitude),
    serviceRadiusMiles,
    serviceRadius: `${serviceRadiusMiles} miles`,
    servicesOffered: arrayOfText(body.servicesOffered || body.skills, "Services offered"),
    skills: arrayOfText(body.skills, "Skills"),
    equipment: text(body.equipment, "Equipment", { required: true, maximum: 1600 }),
    yearsExperience: text(body.yearsExperience || body.experience, "Years of experience", { required: true, maximum: 120 }),
    experience: text(body.experience || body.yearsExperience, "Experience", { required: true, maximum: 800 }),
    availability: text(body.availability, "Availability", { required: true, maximum: 800 }),
    references: text(body.references, "References", { maximum: 1200 }),
    insuranceInfo: text(body.insuranceInfo, "Insurance information", { maximum: 1200 }),
    licenseInfo: text(body.licenseInfo, "License information", { maximum: 1200 }),
    agreedToRules: Boolean(body.agreedToRules),
    status: "pending",
    submittedAt: nowMarker(),
    reviewedAt: null,
    reviewedBy: null
  };
  if (!application.agreedToRules) throw httpError(400, "Agree to the contractor rules before submitting.");
  if (!application.servicesOffered.length && !application.skills.length) throw httpError(400, "Choose at least one service or skill.");
  await systemWrite([
    operation("set", `contractorApplications/${applicationId}`, application),
    operation("set", `users/${user.uid}`, {
      contractorStatus: "pending",
      city: application.city,
      zipCode: application.zipCode,
      serviceRadius: application.serviceRadius,
      serviceRadiusMiles,
      latitude: application.latitude,
      longitude: application.longitude,
      updatedAt: nowMarker()
    }, true),
    auditOperation(user, "contractor_application.created", "contractorApplication", applicationId)
  ], "Submit JCM contractor application");
  return { application };
}

async function submitSupport(user, body) {
  requireActive(user);
  const tickets = await all("supportTickets");
  assertRate(tickets, user.uid, "uid", 8, 24 * 60 * 60 * 1000, "You have submitted several support requests recently. Please wait before sending another.");
  const ticket = supportOperation(user, body);
  await systemWrite([
    ticket.op,
    auditOperation(user, "support.created", "supportTicket", ticket.ticketId, { newValue: { topic: body.topic, jobId: body.jobId || "" } })
  ], "Create JCM support ticket");
  return { ticketId: ticket.ticketId };
}

async function reportIssue(user, body) {
  const job = await getJob(body.jobId);
  if (!participant(user, job)) throw httpError(403, "Only job participants can report a job issue.");
  return submitSupport(user, {
    topic: text(body.topic || "Job problem", "Issue topic", { required: true, maximum: MAX_SHORT_TEXT }),
    priority: body.priority === "urgent" ? "urgent" : "normal",
    message: text(body.message, "Issue details", { required: true }),
    jobId: job.id
  });
}

async function adminReviewApplication(user, body) {
  requireStaff(user);
  const application = await get("contractorApplications", body.applicationId);
  if (!application || application.status !== "pending") throw httpError(409, "This application is no longer pending.");
  const decision = String(body.decision || "").toLowerCase();
  if (!["approve", "reject"].includes(decision)) throw httpError(400, "Choose approve or reject.");
  const reason = text(body.reason, "Review reason", { required: decision === "reject", maximum: 1200 });
  const approved = decision === "approve";
  await systemWrite([
    operation("update", `contractorApplications/${application.id}`, {
      status: approved ? "approved" : "rejected",
      reviewedAt: nowMarker(),
      reviewedBy: user.uid,
      reviewReason: reason
    }),
    operation("set", `users/${application.uid}`, {
      role: approved ? "contractor" : "buyer",
      contractorStatus: approved ? "approved" : "rejected",
      businessName: application.businessName || "",
      skills: application.skills || application.servicesOffered || [],
      servicesOffered: application.servicesOffered || application.skills || [],
      equipment: application.equipment || "",
      yearsExperience: application.yearsExperience || application.experience || "",
      experience: application.experience || "",
      availability: application.availability || "",
      city: application.city || "",
      zipCode: application.zipCode || "",
      serviceRadius: application.serviceRadius || "",
      serviceRadiusMiles: application.serviceRadiusMiles || null,
      latitude: application.latitude == null ? null : application.latitude,
      longitude: application.longitude == null ? null : application.longitude,
      updatedAt: nowMarker()
    }, true),
    auditOperation(user, approved ? "contractor_application.approved" : "contractor_application.rejected", "contractorApplication", application.id, { reason })
  ], approved ? "Approve JCM contractor application" : "Reject JCM contractor application");
  return { ok: true, status: approved ? "approved" : "rejected" };
}

async function adminUpdateUser(user, body) {
  requireAdmin(user);
  const target = await getUser(body.uid);
  if (!target.uid) throw httpError(404, "User not found.");
  if (["owner", "admin", "moderator"].includes(normalizedRole(target))) {
    throw httpError(403, "Manage staff access in config/roles.json.");
  }
  if (target.uid === user.uid && body.suspended) throw httpError(403, "You cannot suspend your own account.");
  const suspended = Boolean(body.suspended);
  await systemWrite([
    operation("set", `users/${target.uid}`, { suspended, updatedAt: nowMarker() }, true),
    auditOperation(user, suspended ? "user.suspended" : "user.unsuspended", "user", target.uid, { reason: body.reason, oldValue: { suspended: Boolean(target.suspended) }, newValue: { suspended } })
  ], "Update JCM user suspension");
  return { ok: true };
}

async function adminResolveDispute(user, body) {
  requireAdmin(user);
  const job = await getJob(body.jobId);
  if (job.status !== "disputed") throw httpError(409, "This job is not disputed.");
  const reason = text(body.reason, "Resolution reason", { required: true, maximum: 1600 });
  const action = String(body.resolution || "");
  const dispute = await get("jobDisputes", job.activeDisputeId);
  if (!dispute) throw httpError(409, "The active dispute record is missing.");
  if (action === "release_contractor") {
    await releasePayment(user, job, reason, { adminResolved: true });
  } else if (action === "refund_buyer") {
    await refundPayment(user, job, reason, "closed");
  } else if (action === "close_without_payout") {
    const payment = job.paymentId ? await get("jobPayments", job.paymentId) : null;
    if (payment && !["awaiting_payment", "payment_failed", "refunded"].includes(payment.paymentStatus)) {
      throw httpError(409, "A collected payment must be refunded or released before closing.");
    }
    await systemWrite([
      operation("update", `jobs/${job.id}`, { status: "closed", updatedAt: nowMarker() }),
      statusHistoryOperation(user, job.id, job.status, "closed", reason),
      auditOperation(user, "dispute.closed_without_payout", "jobDispute", dispute.id, { reason })
    ], "Close JCM dispute without payout");
  } else if (action === "reopen_job") {
    if (job.paymentId) {
      const payment = await get("jobPayments", job.paymentId);
      if (payment && !["refunded", "awaiting_payment", "payment_failed"].includes(payment.paymentStatus)) {
        throw httpError(409, "Refund or resolve the collected payment before reopening.");
      }
    }
    await systemWrite([
      operation("update", `jobs/${job.id}`, {
        status: "open",
        acceptedQuoteId: null,
        acceptedContractorId: null,
        acceptedContractorName: "",
        paymentId: null,
        paymentStatus: "not_required",
        activeDisputeId: null,
        scheduleStatus: "preferred_only",
        proposedSchedule: null,
        confirmedSchedule: null,
        updatedAt: nowMarker()
      }),
      statusHistoryOperation(user, job.id, job.status, "open", reason),
      auditOperation(user, "dispute.reopened_job", "jobDispute", dispute.id, { reason })
    ], "Reopen JCM disputed job");
  } else {
    throw httpError(400, "Choose a supported dispute resolution.");
  }
  await systemWrite([
    operation("update", `jobDisputes/${dispute.id}`, { status: "resolved", resolution: action, resolutionReason: reason, resolvedBy: user.uid, resolvedAt: nowMarker(), updatedAt: nowMarker() }),
    systemMessageOperation(job.id, `JCM resolved the dispute: ${action.replace(/_/g, " ")}.`, "dispute_resolved"),
    auditOperation(user, "dispute.resolved", "jobDispute", dispute.id, { reason, newValue: { resolution: action } })
  ], "Resolve JCM dispute");
  return { ok: true };
}

async function adminForceStatus(user, body) {
  requireAdmin(user);
  const job = await getJob(body.jobId);
  const next = text(body.status, "Status", { required: true, maximum: 80 });
  const reason = text(body.reason, "Admin reason", { required: true, maximum: 1600 });
  if (!JOB_STATUSES.includes(next)) throw httpError(400, "Choose a valid job status.");
  assertTransition(job.status, next, { adminOverride: true, reason });
  await systemWrite([
    operation("update", `jobs/${job.id}`, { status: next, updatedAt: nowMarker() }),
    statusHistoryOperation(user, job.id, job.status, next, reason),
    auditOperation(user, "job.admin_force_status", "job", job.id, { reason, oldValue: { status: job.status }, newValue: { status: next } })
  ], "Force JCM job status");
  return { ok: true };
}

async function adminCloseTicket(user, body) {
  requireStaff(user);
  const ticket = await get("supportTickets", body.ticketId);
  if (!ticket) throw httpError(404, "Support ticket not found.");
  const reason = text(body.reason, "Support note", { required: true, maximum: 1200 });
  await systemWrite([
    operation("update", `supportTickets/${ticket.id}`, { status: "closed", adminNote: reason, closedAt: nowMarker(), updatedAt: nowMarker() }),
    auditOperation(user, "support.closed", "supportTicket", ticket.id, { reason })
  ], "Close JCM support ticket");
  return { ok: true };
}

async function jobDetails(user, body) {
  requireActive(user);
  const job = await getJob(body.jobId);
  const openForContractor = isApprovedContractor(user.profile) && ["open", "quotes_received"].includes(job.status);
  const staff = isStaffRole(user.profile);
  if (!participant(user, job) && !openForContractor && !staff) throw httpError(403, "You do not have access to this request.");
  if (staff && !participant(user, job) && !text(body.moderationReason, "Moderation reason", { required: true, maximum: 800 })) {
    throw httpError(400, "Enter a moderation reason to view job details.");
  }
  const [quotes, messages, offers, payments, reviews, contractor, users] = await Promise.all([
    all("jobQuotes"),
    all("jobMessages"),
    all("finalOffers"),
    all("jobPayments"),
    all("jobReviews"),
    job.acceptedContractorId ? getUser(job.acceptedContractorId) : Promise.resolve({}),
    all("users")
  ]);
  const profilesById = Object.fromEntries(users.map(profile => [profile.uid || profile.id, profile]));
  const canSeeThread = participant(user, job) || staff;
  const canSeeAllQuotes = ownerOf(user, job) || staff;
  return {
    job: {
      ...publicJob(job),
      completionPhotoURLs: canSeeThread ? job.completionPhotoURLs || [] : []
    },
    quotes: quotes
      .filter(quote => quote.jobId === job.id && (canSeeAllQuotes || quote.contractorId === user.uid))
      .map(quote => ({ ...quote, contractorProfile: publicContractorProfile(profilesById[quote.contractorId] || {}) })),
    messages: canSeeThread ? messages.filter(message => message.jobId === job.id).sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt)) : [],
    finalOffers: canSeeThread ? offers.filter(offer => offer.jobId === job.id).sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)) : [],
    payment: paymentForUser(payments.find(payment => payment.jobId === job.id), user, job),
    acceptedContractorProfile: job.acceptedContractorId ? publicContractorProfile(contractor) : null,
    reviews: reviews.filter(review => review.jobId === job.id),
    canRevealPrivate: ownerOf(user, job) || isAdminRole(user.profile) || canAcceptedContractorViewPrivate(job, user.uid),
    stripe: stripeModeSummary()
  };
}

async function overview(user) {
  requireActive(user);
  const [jobs, quotes, tickets, application] = await Promise.all([
    all("jobs"),
    all("jobQuotes"),
    all("supportTickets"),
    all("contractorApplications")
  ]);
  const myRequests = jobs.filter(job => job.postedBy === user.uid).map(publicJob).sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt));
  const myWork = jobs.filter(job => job.acceptedContractorId === user.uid).map(publicJob).sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt));
  return {
    profile: user.profile,
    myRequests,
    myWork,
    availableJobs: await availableJobs(user),
    myQuotes: quotes.filter(quote => quote.contractorId === user.uid),
    supportTickets: tickets.filter(ticket => ticket.uid === user.uid).sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)),
    contractorApplication: application.filter(item => item.uid === user.uid).sort((a, b) => timestampMs(b.submittedAt) - timestampMs(a.submittedAt))[0] || null,
    cancellationReasons: CANCELLATION_REASONS,
    jobStatuses: JOB_STATUSES,
    paymentStatuses: PAYMENT_STATUSES,
    platformPaymentsRequired: PLATFORM_PAYMENTS_REQUIRED,
    autoRelease: { enabled: AUTO_RELEASE_ENABLED, afterDays: AUTO_RELEASE_AFTER_DAYS },
    stripe: stripeModeSummary()
  };
}

async function adminOverview(user) {
  requireStaff(user);
  const [jobs, applications, users, quotes, disputes, tickets, payments, audits, histories] = await Promise.all([
    all("jobs"),
    all("contractorApplications"),
    all("users"),
    all("jobQuotes"),
    all("jobDisputes"),
    all("supportTickets"),
    all("jobPayments"),
    all("auditLogs"),
    all("jobStatusHistory")
  ]);
  return {
    jobs: jobs.map(publicJob).sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)),
    applications: applications.filter(application => application.status === "pending").sort((a, b) => timestampMs(b.submittedAt) - timestampMs(a.submittedAt)),
    applicationHistory: applications.filter(application => application.status !== "pending").sort((a, b) => timestampMs(b.reviewedAt) - timestampMs(a.reviewedAt)),
    users,
    quotes: quotes.sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)),
    disputes: disputes.sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)),
    tickets: tickets.sort((a, b) => (a.priority === "urgent" ? -1 : 1) - (b.priority === "urgent" ? -1 : 1) || timestampMs(b.createdAt) - timestampMs(a.createdAt)),
    payments: payments.sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)),
    audits: audits.sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)).slice(0, 250),
    histories: histories.sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)),
    stripe: stripeModeSummary(),
    cancellationReasons: CANCELLATION_REASONS,
    jobStatuses: JOB_STATUSES
  };
}

function stripeObjectMetadata(object) {
  return object && object.metadata || {};
}

async function paymentFromStripeObject(object) {
  const metadata = stripeObjectMetadata(object);
  if (metadata.jcmPaymentId) return get("jobPayments", metadata.jcmPaymentId);
  if (metadata.jcmJobId) return get("jobPayments", `payment_${metadata.jcmJobId}`);
  if (object.client_reference_id) return get("jobPayments", object.client_reference_id);
  const payments = await all("jobPayments");
  return payments.find(payment =>
    payment.stripePaymentIntentId === object.id ||
    payment.stripeCheckoutSessionId === object.id ||
    payment.stripeChargeId === object.id
  ) || null;
}

async function markStripePaymentHeld(payment, object, event) {
  const job = await getJob(payment.jobId);
  if (["held_pending_completion", "released_to_contractor", "refunded"].includes(payment.paymentStatus)) return;
  const paymentIntentId = object.object === "checkout.session"
    ? (typeof object.payment_intent === "string" ? object.payment_intent : payment.stripePaymentIntentId)
    : object.object === "payment_intent" ? object.id : payment.stripePaymentIntentId;
  const chargeId = object.object === "charge"
    ? object.id
    : object.latest_charge && (typeof object.latest_charge === "string" ? object.latest_charge : object.latest_charge.id) || payment.stripeChargeId;
  await systemWrite([
    operation("update", `jobPayments/${payment.id}`, {
      paymentStatus: "held_pending_completion",
      releaseStatus: "not_released",
      stripePaymentIntentId: paymentIntentId || "",
      stripeChargeId: chargeId || "",
      paidAt: nowMarker(),
      updatedAt: nowMarker()
    }),
    operation("update", `jobs/${job.id}`, { status: "payment_held", paymentStatus: "held_pending_completion", updatedAt: nowMarker() }),
    statusHistoryOperation(null, job.id, job.status, "payment_held", "Stripe confirmed buyer payment."),
    paymentEventOperation(payment.id, job.id, event.type, { stripeEventId: event.id, stripeObjectId: object.id }),
    systemMessageOperation(job.id, "Buyer payment succeeded in Stripe Test Mode. Payment is held until completion and the job can move to scheduling.", "buyer_paid"),
    auditOperation(null, "payment.succeeded", "jobPayment", payment.id, { newValue: { stripePaymentIntentId: paymentIntentId || "", stripeChargeId: chargeId || "" } })
  ], "Record JCM Stripe payment success");
}

async function processStripeEvent(event) {
  const existing = await get("stripeWebhookEvents", event.id);
  if (existing && existing.processedAt) return { duplicate: true };
  if (!existing) {
    await systemWrite([operation("set", `stripeWebhookEvents/${event.id}`, {
      id: event.id,
      type: event.type,
      livemode: Boolean(event.livemode),
      stripeAccount: event.account || "",
      receivedAt: nowMarker()
    })], "Record JCM Stripe webhook receipt");
  }
  const object = event.data && event.data.object || {};
  const payment = await paymentFromStripeObject(object);
  if (event.type === "checkout.session.completed" && payment) {
    await systemWrite([
      operation("update", `jobPayments/${payment.id}`, {
        stripeCheckoutSessionId: object.id,
        stripePaymentIntentId: typeof object.payment_intent === "string" ? object.payment_intent : payment.stripePaymentIntentId || "",
        updatedAt: nowMarker()
      }),
      paymentEventOperation(payment.id, payment.jobId, event.type, { stripeEventId: event.id, stripeObjectId: object.id })
    ], "Record JCM Checkout completion");
    if (object.payment_status === "paid") await markStripePaymentHeld(payment, object, event);
  } else if (["payment_intent.succeeded", "charge.succeeded"].includes(event.type) && payment) {
    await markStripePaymentHeld(payment, object, event);
  } else if (event.type === "payment_intent.payment_failed" && payment) {
    await systemWrite([
      operation("update", `jobPayments/${payment.id}`, { paymentStatus: "payment_failed", updatedAt: nowMarker() }),
      operation("update", `jobs/${payment.jobId}`, { paymentStatus: "payment_failed", updatedAt: nowMarker() }),
      paymentEventOperation(payment.id, payment.jobId, event.type, { stripeEventId: event.id, stripeObjectId: object.id }),
      auditOperation(null, "payment.failed", "jobPayment", payment.id)
    ], "Record JCM Stripe payment failure");
  } else if (event.type === "charge.refunded" && payment) {
    await systemWrite([
      operation("update", `jobPayments/${payment.id}`, { paymentStatus: "refunded", refundStatus: "refunded", stripeChargeId: object.id, refundedAt: nowMarker(), updatedAt: nowMarker() }),
      paymentEventOperation(payment.id, payment.jobId, event.type, { stripeEventId: event.id, stripeObjectId: object.id }),
      auditOperation(null, "payment.refund_webhook", "jobPayment", payment.id)
    ], "Record JCM Stripe refund");
  } else if (event.type.startsWith("charge.dispute.") && payment) {
    const job = await getJob(payment.jobId);
    await systemWrite([
      operation("update", `jobPayments/${payment.id}`, { paymentStatus: "disputed_payment", releaseStatus: "blocked_by_dispute", updatedAt: nowMarker() }),
      operation("update", `jobs/${job.id}`, { status: "disputed", paymentStatus: "disputed_payment", updatedAt: nowMarker() }),
      paymentEventOperation(payment.id, job.id, event.type, { stripeEventId: event.id, stripeObjectId: object.id }),
      auditOperation(null, "payment.stripe_dispute", "jobPayment", payment.id)
    ], "Record JCM Stripe dispute");
  }
  await systemWrite([
    operation("set", `stripeWebhookEvents/${event.id}`, { processedAt: nowMarker() }, true)
  ], "Mark JCM Stripe webhook processed");
  return { duplicate: false };
}

async function dispatch(user, req, body) {
  const action = String(body.action || "");
  if (action === "overview") return overview(user);
  if (action === "jobDetails") return jobDetails(user, body);
  if (action === "createJob") return createJob(user, body);
  if (action === "updateJob") return updateJob(user, body);
  if (action === "submitQuote") return submitQuote(user, body);
  if (action === "withdrawQuote") return withdrawQuote(user, body);
  if (action === "acceptQuote") return acceptQuote(user, body);
  if (action === "sendMessage") return sendMessage(user, body);
  if (action === "createFinalOffer") return createFinalOffer(user, body);
  if (action === "respondFinalOffer") return respondFinalOffer(user, body);
  if (action === "startCheckout") return startCheckout(user, req, body);
  if (action === "proposeSchedule") return proposeSchedule(user, body);
  if (action === "confirmSchedule") return confirmSchedule(user, body);
  if (action === "startWork") return startWork(user, body);
  if (action === "completeWork") return completeWork(user, body);
  if (action === "confirmCompletion") return confirmCompletion(user, body);
  if (action === "disputeJob") return disputeJob(user, body);
  if (action === "cancelJob") return cancelJob(user, body);
  if (action === "reopenJob") return reopenJob(user, body);
  if (action === "revealPrivateDetails") return revealPrivateDetails(user, body);
  if (action === "submitReview") return submitReview(user, body);
  if (action === "submitApplication") return submitApplication(user, body);
  if (action === "submitSupport") return submitSupport(user, body);
  if (action === "reportIssue") return reportIssue(user, body);
  if (action === "adminOverview") return adminOverview(user);
  if (action === "adminReviewApplication") return adminReviewApplication(user, body);
  if (action === "adminUpdateUser") return adminUpdateUser(user, body);
  if (action === "adminResolveDispute") return adminResolveDispute(user, body);
  if (action === "adminForceStatus") return adminForceStatus(user, body);
  if (action === "adminCloseTicket") return adminCloseTicket(user, body);
  throw httpError(400, "Unsupported marketplace action.");
}

async function handleWorkflow(req, body) {
  const user = await getSignedInUser(req);
  return dispatch(user, req, body);
}

module.exports = {
  AUTO_RELEASE_AFTER_DAYS,
  AUTO_RELEASE_ENABLED,
  PLATFORM_PAYMENTS_REQUIRED,
  adminOverview,
  availableJobs,
  dispatch,
  handleWorkflow,
  jobDetails,
  overview,
  processStripeEvent
};
