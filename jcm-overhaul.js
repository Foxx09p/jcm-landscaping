(function () {
  "use strict";

  var stripeJsPromise = null;
  var orderBusy = false;
  var activePayment = null;

  var PACKAGES = [
    { id: "lawn-basic", name: "Lawn mowing and trim", amountCents: 8900, budget: "$75-$150" },
    { id: "lawn-large", name: "Large lawn service", amountCents: 14900, budget: "$75-$150" },
    { id: "cleanup-basic", name: "Yard cleanup or leaf removal", amountCents: 22500, budget: "$150-$300" },
    { id: "mulch-beds", name: "Mulch or bed refresh", amountCents: 34900, budget: "$300-$600" },
    { id: "snow-ice", name: "Snow and ice service", amountCents: 9900, budget: "$75-$150" },
    { id: "site-visit", name: "Site visit and first hour", amountCents: 7500, budget: "$75-$150" }
  ];

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    if (typeof escapeHtml === "function") return escapeHtml(value == null ? "" : String(value));
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char];
    });
  }
  function money(cents) {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(cents || 0) / 100);
  }
  function value(id) { return $(id) ? $(id).value.trim() : ""; }
  function checked(id) { return Boolean($(id) && $(id).checked); }
  function selectedPackage() {
    var id = value("prepaidPackage");
    return PACKAGES.find(function (item) { return item.id === id; }) || null;
  }
  function setBusy(button, busy) {
    if (typeof setButtonLoading === "function") return setButtonLoading(button, busy);
    if (button) button.disabled = busy;
  }
  function notify(message, type) {
    if (typeof toast === "function") toast(message, type || "error");
  }
  async function workflow(action, payload) {
    if (!window.jcmAuthFetch) throw new Error("Sign in first.");
    return window.jcmAuthFetch("/api/jobs/workflow", {
      method: "POST",
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
  }

  function installPolish() {
    if (!document.body || document.body.dataset.jcmOverhauled === "true") return;
    document.body.dataset.jcmOverhauled = "true";

    var nav = document.querySelector(".app-nav");
    if (nav && !$(".testRibbon")) {
      nav.insertAdjacentHTML("afterend", '<div class="test-ribbon" id="testRibbon">Test build for the new JCM booking and payment flow <a href="/admin">Back to admin</a></div>');
    }

    var heroTitle = document.querySelector("#homeHero h1");
    if (heroTitle) heroTitle.textContent = "Book JCM Landscaping with upfront payment.";
    var heroCopy = document.querySelector("#homeHero p");
    if (heroCopy) heroCopy.textContent = "Choose a service, pay securely on-site, and let approved contractors pick up the job. If the work is canceled before payout release, JCM can refund the payment through Stripe.";
    var heroButtons = document.querySelector("#homeHero .hero-actions");
    if (heroButtons) {
      heroButtons.innerHTML = '<button class="btn btn-primary" type="button" onclick="goPostJob()">Start an Order</button><button class="btn btn-secondary" type="button" onclick="navigatePage(\'how-it-works\')">View Process</button>';
    }

    var postHeader = document.querySelector("#page-post-job .page-header");
    if (postHeader) {
      var h1 = postHeader.querySelector("h1");
      var lead = postHeader.querySelector(".lead");
      if (h1) h1.textContent = "Order outdoor service.";
      if (lead) lead.textContent = "Your payment is collected before the request goes live. Private address details stay hidden until you accept a contractor.";
    }

    var form = $("jobRequestForm");
    if (form && !$("prepaidPackage")) {
      var service = $("serviceType");
      var html = [
        '<div class="form-field full" id="prepaidPackageField">',
        '  <label for="prepaidPackage">Upfront Service Package</label>',
        '  <select id="prepaidPackage" required>',
        '    <option value="">Choose service package</option>',
        PACKAGES.map(function (item) {
          return '<option value="' + esc(item.id) + '">' + esc(item.name) + ' - ' + esc(money(item.amountCents)) + '</option>';
        }).join(""),
        '  </select>',
        '  <span class="hint">Charged securely before the job is posted. Refunds are handled through Stripe if the job is canceled before payout release.</span>',
        '  <span class="error-message"></span>',
        '</div>',
        '<div class="form-field full" id="upfrontSummaryField">',
        '  <div class="upfront-summary"><span>Due today</span><strong id="upfrontDue">$0.00</strong><span id="upfrontPackageName">Choose a package to continue.</span></div>',
        '</div>'
      ].join("");
      if (service && service.closest(".form-field")) service.closest(".form-field").insertAdjacentHTML("afterend", html);
      else form.insertAdjacentHTML("afterbegin", html);
      $("prepaidPackage").addEventListener("change", updatePackageSummary);
      updatePackageSummary();
    }

    var submit = $("submitJobBtn");
    if (submit) submit.textContent = "Continue to Payment";

    var buyerPayment = $("buyerPaymentContent");
    if (buyerPayment) {
      var buyerLead = buyerPayment.querySelector(".lead");
      if (buyerLead) buyerLead.textContent = "Payments appear here after you place a prepaid service order.";
    }

    var footerBottom = document.querySelector(".footer-bottom");
    if (footerBottom && !footerBottom.querySelector(".stripe-powered-footer")) {
      footerBottom.insertAdjacentHTML("beforeend", '<span class="stripe-powered-footer">Payments powered by Stripe</span>');
    }

    installPaymentModal();
  }

  function updatePackageSummary() {
    var item = selectedPackage();
    if ($("upfrontDue")) $("upfrontDue").textContent = item ? money(item.amountCents) : "$0.00";
    if ($("upfrontPackageName")) $("upfrontPackageName").textContent = item ? item.name : "Choose a package to continue.";
    if (item && $("budget") && !$("budget").value) $("budget").value = item.budget;
  }

  function installPaymentModal() {
    if ($("stripePaymentModal")) return;
    document.body.insertAdjacentHTML("beforeend", [
      '<div class="modal-backdrop stripe-order-modal" id="stripePaymentModal" role="dialog" aria-modal="true" aria-labelledby="stripePaymentTitle">',
      '  <div class="modal-card">',
      '    <div class="stripe-order-header">',
      '      <div><h2 id="stripePaymentTitle">Secure upfront payment</h2><p id="stripePaymentSubtitle">Your order will be posted after payment succeeds.</p></div>',
      '      <div class="stripe-price" id="stripePaymentAmount">$0.00</div>',
      '    </div>',
      '    <form id="stripePaymentForm">',
      '      <div id="stripePaymentElement"></div>',
      '      <div class="stripe-order-error" id="stripePaymentError" hidden></div>',
      '      <div class="payment-note">JCM holds the buyer payment before work starts. If no contractor accepts or the job is canceled before payout release, JCM can issue a Stripe refund.</div>',
      '      <div class="modal-actions">',
      '        <button class="btn btn-secondary" type="button" id="stripeCancelBtn">Cancel</button>',
      '        <button class="btn btn-primary" type="submit" id="stripePayBtn">Pay</button>',
      '      </div>',
      '      <p class="stripe-powered">Powered by <strong>Stripe</strong></p>',
      '    </form>',
      '  </div>',
      '</div>'
    ].join(""));
    $("stripeCancelBtn").addEventListener("click", closePaymentModal);
    $("stripePaymentForm").addEventListener("submit", confirmStripePayment);
  }

  function openPaymentModal() {
    $("stripePaymentModal").classList.add("active");
    document.body.classList.add("modal-open");
  }

  function closePaymentModal(force) {
    if (orderBusy && !force) return;
    $("stripePaymentModal").classList.remove("active");
    document.body.classList.remove("modal-open");
  }

  function paymentReturnUrl() {
    var path = window.location.pathname && window.location.pathname.includes("test") ? window.location.pathname : "/test";
    return window.location.origin + path + "#account";
  }

  function loadStripeJs() {
    if (window.Stripe) return Promise.resolve();
    if (stripeJsPromise) return stripeJsPromise;
    stripeJsPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { reject(new Error("Stripe.js could not load.")); };
      document.head.appendChild(script);
    });
    return stripeJsPromise;
  }

  function collectOrderPayload(photoURLs) {
    var item = selectedPackage();
    if (!item) throw new Error("Choose an upfront service package.");
    return {
      prepaidPackageId: item.id,
      title: value("jobTitle"),
      serviceType: value("serviceType"),
      city: value("job-city"),
      zipCode: value("job-zip"),
      fullAddress: value("fullAddress"),
      posterPhone: value("jobPhone"),
      propertySize: value("propertySize"),
      preferredDate: value("preferredDate"),
      budget: value("budget") || item.budget,
      frequency: value("frequency"),
      details: value("jobDetails"),
      photoURLs: photoURLs || [],
      latitude: window.state && state.jobLocation && state.jobLocation.latitude,
      longitude: window.state && state.jobLocation && state.jobLocation.longitude,
      locationAccuracyMeters: window.state && state.jobLocation && state.jobLocation.accuracyMeters,
      petsOnProperty: checked("petsOnProperty"),
      dangerousDebris: checked("dangerousDebris"),
      steepSlope: checked("steepSlope"),
      powerLines: checked("powerLines"),
      gateInstructions: value("gateInstructions"),
      parkingInstructions: value("parkingInstructions"),
      safetyConcerns: value("safetyConcerns"),
      privateNotes: value("privateNotes")
    };
  }

  async function mountStripePayment(intent) {
    if (!intent.stripePublishableKey) throw new Error("Stripe publishable key is not configured.");
    await loadStripeJs();
    var stripe = window.Stripe(intent.stripePublishableKey);
    var elements = stripe.elements({
      clientSecret: intent.clientSecret,
      appearance: {
        theme: "stripe",
        variables: {
          colorPrimary: "#17452f",
          colorText: "#13231a",
          borderRadius: "6px",
          fontFamily: "Inter, system-ui, sans-serif"
        }
      }
    });
    $("stripePaymentElement").innerHTML = "";
    elements.create("payment", { layout: "tabs" }).mount("#stripePaymentElement");
    activePayment = { stripe: stripe, elements: elements, intent: intent };
    $("stripePaymentAmount").textContent = money(intent.amountCents);
    $("stripePayBtn").textContent = "Pay " + money(intent.amountCents);
    $("stripePaymentError").hidden = true;
    openPaymentModal();
  }

  async function finishOrder(intent, paymentIntentId) {
    var result = await workflow("finalizePrepaidJob", {
      draftId: intent.draftId,
      paymentIntentId: paymentIntentId || intent.paymentIntentId
    });
    closePaymentModal(true);
    activePayment = null;
    if ($("jobRequestForm")) $("jobRequestForm").reset();
    if (window.state) {
      state.selectedPhotos = [];
      state.jobLocation = null;
    }
    if (typeof renderPhotoPreviews === "function") renderPhotoPreviews();
    if (typeof loadMarketplaceOverview === "function") await loadMarketplaceOverview(true);
    var panel = $("jobRequestResult");
    if (panel) {
      panel.hidden = false;
      panel.classList.remove("error");
      panel.textContent = result.alreadyFinalized
        ? "This paid order was already posted. Check My Requests for the latest status."
        : "Payment received. Your service request is now posted for approved contractors.";
    }
    if (typeof showPage === "function") showPage("account");
    notify("Payment received. Your request is posted.", "success");
  }

  async function confirmStripePayment(event) {
    event.preventDefault();
    if (!activePayment || orderBusy) return;
    orderBusy = true;
    setBusy($("stripePayBtn"), true);
    $("stripePaymentError").hidden = true;
    try {
      if (activePayment.elements.submit) {
        var submitResult = await activePayment.elements.submit();
        if (submitResult.error) throw submitResult.error;
      }
      var result = await activePayment.stripe.confirmPayment({
        elements: activePayment.elements,
        confirmParams: { return_url: paymentReturnUrl() },
        redirect: "if_required"
      });
      if (result.error) throw result.error;
      var paymentIntent = result.paymentIntent;
      if (!paymentIntent || paymentIntent.status !== "succeeded") {
        throw new Error("Stripe is still processing this payment. Refresh My Requests in a moment.");
      }
      await finishOrder(activePayment.intent, paymentIntent.id);
    } catch (error) {
      var box = $("stripePaymentError");
      box.textContent = error.message || "Payment could not be completed.";
      box.hidden = false;
    } finally {
      orderBusy = false;
      setBusy($("stripePayBtn"), false);
    }
  }

  window.marketplaceCreateJobFromForm = async function () {
    if (!window.state || !state.authUser) return openSignInModal();
    if (typeof isSuspended === "function" && isSuspended()) {
      notify("Your account is suspended and cannot submit service requests.");
      return;
    }
    if (typeof validateForm === "function" && !validateForm($("jobRequestForm"))) {
      notify("Please fix the highlighted fields.");
      return;
    }
    if (typeof validatePhotos === "function" && !validatePhotos()) {
      notify("Please fix the highlighted fields.");
      return;
    }
    if (!selectedPackage()) {
      notify("Choose an upfront service package.");
      return;
    }
    var button = $("submitJobBtn");
    setBusy(button, true);
    try {
      var urls = state.selectedPhotos && state.selectedPhotos.length && typeof uploadJobPhotos === "function"
        ? await uploadJobPhotos()
        : [];
      var intent = await workflow("createPrepaidIntent", collectOrderPayload(urls));
      if (intent.simulated) {
        await finishOrder(intent, intent.paymentIntentId);
        return;
      }
      await mountStripePayment(intent);
    } catch (error) {
      var result = $("jobRequestResult");
      if (result) {
        result.hidden = false;
        result.classList.add("error");
        result.textContent = error.message || "The order could not be started.";
      }
      notify(error.message || "The order could not be started.");
    } finally {
      setBusy(button, false);
    }
  };

  document.addEventListener("DOMContentLoaded", installPolish);
  installPolish();
})();
