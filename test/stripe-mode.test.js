const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPaymentStripeMode, configuredSecretKey, stripeMode, stripeTestSimulationEnabled } = require("../api/_lib/stripe-connect");

function withEnv(values, callback) {
  const previous = {};
  Object.keys(values).forEach(key => {
    previous[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  });
  try {
    callback();
  } finally {
    Object.keys(values).forEach(key => {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
}

test("Stripe defaults to test mode", () => {
  withEnv({ STRIPE_MODE: null, STRIPE_LIVE_ENABLED: null }, () => {
    assert.equal(stripeMode(), "test");
  });
});

test("Stripe live mode remains blocked without the explicit live safety flag", () => {
  withEnv({ STRIPE_MODE: "live", STRIPE_LIVE_ENABLED: "false" }, () => {
    assert.throws(() => stripeMode(), /live mode is disabled/i);
  });
});

test("Stripe test mode refuses live credentials", () => {
  withEnv({
    STRIPE_MODE: "test",
    STRIPE_LIVE_ENABLED: "false",
    STRIPE_TEST_SECRET_KEY: "sk_live_not_allowed",
    STRIPE_SECRET_KEY: null
  }, () => {
    assert.throws(() => configuredSecretKey(), /test mode requires a test key/i);
  });
});

test("Stripe test mode accepts a test restricted key", () => {
  withEnv({
    STRIPE_MODE: "test",
    STRIPE_LIVE_ENABLED: "false",
    STRIPE_TEST_SECRET_KEY: "rk_test_example",
    STRIPE_SECRET_KEY: null
  }, () => {
    assert.equal(configuredSecretKey(), "rk_test_example");
  });
});

test("Stripe test mode rejects live-mode payment records", () => {
  withEnv({ STRIPE_MODE: "test", STRIPE_LIVE_ENABLED: "false" }, () => {
    assert.throws(() => assertPaymentStripeMode({ stripeMode: "live" }), /different Stripe environment/i);
    assert.doesNotThrow(() => assertPaymentStripeMode({ stripeMode: "test" }));
  });
});

test("Stripe test simulation requires the explicit sandbox flag", () => {
  withEnv({ STRIPE_MODE: "test", STRIPE_TEST_SIMULATED: "false" }, () => {
    assert.equal(stripeTestSimulationEnabled(), false);
  });
  withEnv({ STRIPE_MODE: "test", STRIPE_TEST_SIMULATED: "true" }, () => {
    assert.equal(stripeTestSimulationEnabled(), true);
  });
});

test("Stripe test simulation can never run in live mode", () => {
  withEnv({ STRIPE_MODE: "live", STRIPE_LIVE_ENABLED: "true", STRIPE_TEST_SIMULATED: "true" }, () => {
    assert.equal(stripeTestSimulationEnabled(), false);
  });
});
