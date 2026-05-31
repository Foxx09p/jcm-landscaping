const Stripe = require("stripe");
const { db, serverTimestamp } = require("./github-data");
const { httpError } = require("./http");

const STRIPE_API_VERSION = "2026-05-27.dahlia";

function stripeMode() {
  const mode = String(process.env.STRIPE_MODE || "test").trim().toLowerCase();
  if (!["test", "live"].includes(mode)) {
    throw httpError(500, "STRIPE_MODE must be test or live.");
  }
  if (mode === "live" && String(process.env.STRIPE_LIVE_ENABLED || "false").toLowerCase() !== "true") {
    throw httpError(503, "Stripe live mode is disabled. Set STRIPE_LIVE_ENABLED=true only after launch approval.");
  }
  return mode;
}

function configuredSecretKey() {
  const mode = stripeMode();
  const legacy = process.env.STRIPE_SECRET_KEY || "";
  const key = mode === "live"
    ? process.env.STRIPE_LIVE_SECRET_KEY
    : process.env.STRIPE_TEST_SECRET_KEY || (/^[sr]k_test_/.test(legacy) ? legacy : "");
  if (!key) {
    throw httpError(503, `Stripe ${mode} key is not configured.`);
  }
  if (mode === "test" && !/^[sr]k_test_/.test(key)) {
    throw httpError(503, "Stripe test mode requires a test key.");
  }
  if (mode === "live" && !/^[sr]k_live_/.test(key)) {
    throw httpError(503, "Stripe live mode requires a live key.");
  }
  return key;
}

function stripePublishableKey() {
  const mode = stripeMode();
  const key = mode === "live"
    ? process.env.STRIPE_LIVE_PUBLISHABLE_KEY
    : process.env.STRIPE_TEST_PUBLISHABLE_KEY;
  if (!key) return "";
  if (mode === "test" && !/^pk_test_/.test(key)) throw httpError(503, "Stripe test mode requires a test publishable key.");
  if (mode === "live" && !/^pk_live_/.test(key)) throw httpError(503, "Stripe live mode requires a live publishable key.");
  return key;
}

function stripeWebhookSecret() {
  const mode = stripeMode();
  const legacy = process.env.STRIPE_WEBHOOK_SECRET || "";
  return mode === "live"
    ? process.env.STRIPE_LIVE_WEBHOOK_SECRET || ""
    : process.env.STRIPE_TEST_WEBHOOK_SECRET || legacy;
}

function getStripe() {
  return new Stripe(configuredSecretKey(), {
    apiVersion: STRIPE_API_VERSION
  });
}

function stripeKeyIsLive() {
  return stripeMode() === "live";
}

function stripeModeSummary() {
  const mode = stripeMode();
  return {
    stripeMode: mode,
    stripeModeLabel: mode === "live" ? "Live Mode" : "Test Mode",
    stripeLiveEnabled: mode === "live",
    stripePublishableKey: stripePublishableKey()
  };
}

function appBaseUrl(req) {
  const explicit = process.env.APP_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (explicit) return explicit.startsWith("http") ? explicit : `https://${explicit}`;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  if (!host) throw httpError(500, "APP_BASE_URL is not configured.");
  return `${proto}://${host}`;
}

function v2RequirementLabel(requirement) {
  return requirement.description ||
    (requirement.reference && (requirement.reference.resource || requirement.reference.inquiry)) ||
    "Complete Stripe onboarding.";
}

function v2DisabledReason(capability) {
  const details = (capability && capability.status_details) || [];
  return details.map(item => item.code).filter(Boolean).join(", ");
}

function safeAccountStatus(account) {
  if (account.object === "v2.core.account") {
    const entries = (account.requirements && account.requirements.entries) || [];
    const currentlyDue = entries
      .filter(item => item.awaiting_action_from === "user" &&
        item.minimum_deadline &&
        ["currently_due", "past_due"].includes(item.minimum_deadline.status))
      .map(v2RequirementLabel);
    const stripeBalance = account.configuration &&
      account.configuration.recipient &&
      account.configuration.recipient.capabilities &&
      account.configuration.recipient.capabilities.stripe_balance || {};
    const transfers = stripeBalance.stripe_transfers || {};
    const payouts = stripeBalance.payouts || {};
    const disabledReason = v2DisabledReason(payouts) || v2DisabledReason(transfers);
    const detailsSubmitted = currentlyDue.length === 0;
    return {
      stripeAccountId: account.id,
      stripeChargesEnabled: transfers.status === "active",
      stripePayoutsEnabled: payouts.status === "active",
      stripeDetailsSubmitted: detailsSubmitted,
      stripeRequirementsCurrentlyDue: currentlyDue,
      stripeDisabledReason: disabledReason,
      stripeOnboardingComplete: Boolean(detailsSubmitted && payouts.status === "active"),
      lastStripeStatusSync: serverTimestamp()
    };
  }
  const currentlyDue = (account.requirements && account.requirements.currently_due) || [];
  const disabledReason = account.requirements && account.requirements.disabled_reason;
  return {
    stripeAccountId: account.id,
    stripeChargesEnabled: Boolean(account.charges_enabled),
    stripePayoutsEnabled: Boolean(account.payouts_enabled),
    stripeDetailsSubmitted: Boolean(account.details_submitted),
    stripeRequirementsCurrentlyDue: currentlyDue,
    stripeDisabledReason: disabledReason || "",
    stripeOnboardingComplete: Boolean(account.details_submitted && account.payouts_enabled),
    lastStripeStatusSync: serverTimestamp()
  };
}

function getConnectedAccount(stripe, accountId) {
  return stripe.v2.core.accounts.retrieve(accountId, {
    include: ["configuration.recipient", "requirements"]
  });
}

async function updateUserStripeStatus(uid, account) {
  const status = { ...safeAccountStatus(account), stripeMode: stripeMode() };
  await db().collection("users").doc(uid).set(status, { merge: true });
  await db().collection("stripeAccounts").doc(account.id).set({
    uid,
    ...status
  }, { merge: true });
  return status;
}

async function findUidByStripeAccountId(accountId) {
  const direct = await db().collection("stripeAccounts").doc(accountId).get();
  if (direct.exists && direct.data().uid) return direct.data().uid;
  const query = await db().collection("users").where("stripeAccountId", "==", accountId).limit(1).get();
  return query.empty ? null : query.docs[0].id;
}

async function createOrRetrieveAccount(user) {
  const stripe = getStripe();
  if (user.profile.stripeAccountId) {
    const account = await getConnectedAccount(stripe, user.profile.stripeAccountId);
    const status = await updateUserStripeStatus(user.uid, account);
    return { account, status };
  }
  const account = await stripe.v2.core.accounts.create({
    contact_email: user.profile.email || undefined,
    display_name: user.profile.displayName || user.profile.email || "JCM contractor",
    dashboard: "express",
    defaults: {
      currency: "usd",
      responsibilities: {
        fees_collector: "application",
        losses_collector: "application"
      }
    },
    identity: {
      country: "US",
      entity_type: "individual"
    },
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: {
            stripe_transfers: { requested: true }
          }
        }
      }
    },
    include: ["configuration.recipient", "requirements"],
    metadata: {
      jcmUid: user.uid,
      role: "contractor",
      stripeMode: stripeMode()
    }
  }, { idempotencyKey: `jcm_connect_account_${stripeMode()}_${user.uid}` });
  const status = await updateUserStripeStatus(user.uid, account);
  return { account, status };
}

async function createCheckoutSession(req, payment, job, buyer) {
  const stripe = getStripe();
  const baseUrl = appBaseUrl(req);
  const transferGroup = payment.transferGroup || `JCM_JOB_${job.id}`;
  return stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: payment.id,
    customer_email: buyer.profile.email || undefined,
    success_url: `${baseUrl}/#account?payment=success&job=${encodeURIComponent(job.id)}`,
    cancel_url: `${baseUrl}/#account?payment=canceled&job=${encodeURIComponent(job.id)}`,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: payment.currency,
        unit_amount: payment.finalAmountCents,
        product_data: {
          name: `JCM secure job payment: ${job.title || "Outdoor service"}`
        }
      }
    }],
    payment_intent_data: {
      transfer_group: transferGroup,
      metadata: {
        jcmJobId: job.id,
        jcmPaymentId: payment.id,
        jcmBuyerId: payment.buyerId,
        jcmContractorId: payment.contractorId,
        stripeMode: stripeMode()
      }
    },
    metadata: {
      jcmJobId: job.id,
      jcmPaymentId: payment.id,
      stripeMode: stripeMode()
    }
  }, { idempotencyKey: `jcm_checkout_${stripeMode()}_${payment.id}` });
}

async function createContractorTransfer(payment) {
  const stripe = getStripe();
  let chargeId = payment.stripeChargeId || "";
  if (!chargeId && payment.stripePaymentIntentId) {
    const intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
    chargeId = typeof intent.latest_charge === "string"
      ? intent.latest_charge
      : intent.latest_charge && intent.latest_charge.id;
  }
  if (!chargeId) throw httpError(409, "The successful Stripe charge is not available yet.");
  if (!payment.stripeConnectedAccountId) throw httpError(409, "The contractor Stripe account is missing.");
  return stripe.transfers.create({
    amount: payment.contractorAmountCents,
    currency: payment.currency,
    destination: payment.stripeConnectedAccountId,
    source_transaction: chargeId,
    transfer_group: payment.transferGroup,
    metadata: {
      jcmJobId: payment.jobId,
      jcmPaymentId: payment.id,
      jcmContractorId: payment.contractorId,
      stripeMode: stripeMode()
    }
  }, { idempotencyKey: `jcm_release_${stripeMode()}_${payment.id}_${payment.contractorId}` });
}

async function createFullRefund(payment, reason) {
  if (!payment.stripePaymentIntentId) throw httpError(409, "This job does not have a refundable Stripe payment.");
  return getStripe().refunds.create({
    payment_intent: payment.stripePaymentIntentId,
    metadata: {
      jcmJobId: payment.jobId,
      jcmPaymentId: payment.id,
      jcmReason: String(reason || "").slice(0, 450),
      stripeMode: stripeMode()
    }
  }, { idempotencyKey: `jcm_refund_full_${stripeMode()}_${payment.id}` });
}

module.exports = {
  STRIPE_API_VERSION,
  appBaseUrl,
  configuredSecretKey,
  createCheckoutSession,
  createContractorTransfer,
  createFullRefund,
  createOrRetrieveAccount,
  findUidByStripeAccountId,
  getConnectedAccount,
  getStripe,
  safeAccountStatus,
  stripeKeyIsLive,
  stripeMode,
  stripeModeSummary,
  stripePublishableKey,
  stripeWebhookSecret,
  updateUserStripeStatus
};
