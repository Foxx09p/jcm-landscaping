(function () {
  "use strict";

  var refreshTimer = null;
  var activeJobId = "";

  function byId(id) { return document.getElementById(id); }
  function esc(value) { return typeof escapeHtml === "function" ? escapeHtml(value == null ? "" : String(value)) : String(value == null ? "" : value); }
  function role() {
    var value = String((state.currentUser && state.currentUser.role) || "buyer").toLowerCase();
    return value === "user" ? "buyer" : value;
  }
  function isBuyer() { return Boolean(state.authUser); }
  function isApprovedContractorAccount() { return role() === "contractor" && state.currentUser && state.currentUser.contractorStatus === "approved" && !state.currentUser.suspended; }
  function contractorReady() { return Boolean(state.currentUser && state.currentUser.stripeOnboardingComplete && state.currentUser.stripePayoutsEnabled); }
  function money(cents) {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(cents || 0) / 100);
  }
  function dollarsToCents(value) {
    var match = String(value || "").trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) throw new Error("Enter a dollar amount with no more than two decimal places.");
    var result = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
    if (!Number.isSafeInteger(result) || result <= 0) throw new Error("Enter a valid amount.");
    return result;
  }
  function field(id) { return byId(id) ? byId(id).value.trim() : ""; }
  function checked(id) { return Boolean(byId(id) && byId(id).checked); }
  function values(name) {
    return Array.from(document.querySelectorAll('input[name="' + name + '"]:checked')).map(function (item) { return item.value; });
  }
  function setBusy(button, busy) {
    if (!button) return;
    if (typeof setButtonLoading === "function") return setButtonLoading(button, busy);
    button.disabled = busy;
  }
  async function api(action, payload) {
    if (!window.jcmAuthFetch) throw new Error("Sign in first.");
    return window.jcmAuthFetch("/api/jobs/workflow", {
      method: "POST",
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
  }
  function notify(error, fallback) {
    toast((error && error.message) || fallback || "Something went wrong.", "error");
  }

  function installStyles() {
    if (byId("marketplaceStyles")) return;
    var style = document.createElement("style");
    style.id = "marketplaceStyles";
    style.textContent = [
      ".sandbox-banner{border:1px solid #e0a92f;background:#fff7df;color:#684500;border-radius:12px;padding:12px 14px;margin:0 0 18px;font-weight:700}",
      ".market-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}",
      ".market-section{border-top:1px solid var(--border);margin-top:18px;padding-top:18px}",
      ".market-section h3{margin:0 0 10px}",
      ".market-list{display:grid;gap:10px}",
      ".market-row{border:1px solid var(--border);border-radius:12px;padding:14px;background:var(--white)}",
      ".market-row p{margin:6px 0}",
      ".market-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}",
      ".market-actions .btn{width:auto}",
      ".market-form{display:grid;gap:10px;margin-top:12px}",
      ".market-form input,.market-form select,.market-form textarea{width:100%}",
      ".market-modal-card{width:min(860px,calc(100vw - 28px));max-height:88vh;overflow:auto}",
      ".market-chat{display:grid;gap:8px;max-height:300px;overflow:auto;padding:4px}",
      ".market-message{border:1px solid var(--border);border-radius:10px;padding:10px;background:#fff}",
      ".market-message.system{background:#f2f8f0}",
      ".market-private{white-space:pre-wrap}",
      ".market-muted{color:var(--ink-muted);font-size:.92rem}",
      ".market-warning{border-left:4px solid #d18b00;padding:10px 12px;background:#fff8e6}",
      ".market-success{border-left:4px solid var(--green);padding:10px 12px;background:#f2f8f0}",
      ".market-checklist{display:grid;gap:6px;margin-top:12px}",
      ".market-checklist span{display:block}",
      ".market-filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end}",
      "@media(max-width:640px){.market-actions .btn{width:100%}.market-modal-card{width:calc(100vw - 16px)}}"
    ].join("");
    document.head.appendChild(style);
  }

  function insertAfter(target, html) {
    if (target) target.insertAdjacentHTML("afterend", html);
  }

  function installDom() {
    installStyles();
    if (!byId("siteSandboxBanner")) {
      var main = byId("mainContent");
      if (main) main.insertAdjacentHTML("afterbegin", '<div class="sandbox-banner" id="siteSandboxBanner">Stripe Sandbox / Test Mode: no real money is charged or paid. JCM keeps a 30% platform fee and contractors receive 70% only after completion is confirmed or an admin resolves the job.</div>');
    }
    var title = document.querySelector("#page-post-job h1");
    if (title) title.textContent = "Request outdoor service.";
    var jobForm = byId("jobRequestForm");
    if (jobForm && !byId("jobSafetyFields")) {
      var details = byId("jobDetails");
      insertAfter(details && details.closest(".form-field"), [
        '<div class="form-field full" id="jobSafetyFields"><label>Safety and Access</label>',
        '<div class="checkbox-grid"><label><input id="petsOnProperty" type="checkbox"> Pets on property</label><label><input id="dangerousDebris" type="checkbox"> Dangerous debris</label><label><input id="steepSlope" type="checkbox"> Steep slope</label><label><input id="powerLines" type="checkbox"> Power lines near work</label></div></div>',
        '<div class="form-field full"><label for="gateInstructions">Gate / Lock Instructions</label><textarea id="gateInstructions" maxlength="1200" placeholder="Optional. These stay private until a contractor is accepted."></textarea></div>',
        '<div class="form-field full"><label for="parkingInstructions">Parking / Access Instructions</label><textarea id="parkingInstructions" maxlength="1200" placeholder="Optional. These stay private until a contractor is accepted."></textarea></div>',
        '<div class="form-field full"><label for="safetyConcerns">Other Safety Concerns</label><textarea id="safetyConcerns" maxlength="1200" placeholder="Describe any safety issue contractors should know before quoting."></textarea></div>',
        '<div class="form-field full"><label for="privateNotes">Private Notes</label><textarea id="privateNotes" maxlength="1200" placeholder="Optional private instructions shared only with the accepted contractor after acceptance."></textarea></div>'
      ].join(""));
      var photoHint = byId("photoField");
      if (photoHint) {
        var hint = photoHint.querySelector(".hint");
        if (hint) hint.textContent = "Photos are strongly recommended because they help contractors quote accurately. Upload up to 8 images, 3 MB each.";
      }
    }
    var contractorForm = byId("contractorForm");
    if (contractorForm && !byId("contractorBusinessName")) {
      var nameField = byId("contractorName");
      insertAfter(nameField && nameField.closest(".form-field"), [
        '<div class="form-field"><label for="contractorBusinessName">Business Name</label><input id="contractorBusinessName" type="text" maxlength="240" placeholder="Optional"></div>',
        '<div class="form-field"><label for="contractorServiceLocation">Service Location</label><input id="contractorServiceLocation" type="text" maxlength="240" placeholder="City, ZIP, or service area"></div>'
      ].join(""));
      contractorForm.insertAdjacentHTML("beforeend", [
        '<div class="form-field full"><label for="contractorReferences">Optional References / Proof Notes</label><textarea id="contractorReferences" maxlength="1200" placeholder="Optional references or proof notes."></textarea></div>',
        '<div class="form-field full"><label for="contractorInsurance">Insurance Information</label><textarea id="contractorInsurance" maxlength="1200" placeholder="Optional. Providing information does not mean JCM verified it."></textarea></div>',
        '<div class="form-field full"><label for="contractorLicense">License Information</label><textarea id="contractorLicense" maxlength="1200" placeholder="Optional. Providing information does not mean JCM verified it."></textarea></div>',
        '<label class="checkbox-wrap full"><input id="contractorRulesAgreement" type="checkbox"> I agree to the contractor rules and understand approval is manual.<span class="error-message"></span></label>'
      ].join(""));
    }
    var boardContent = byId("boardContent");
    if (boardContent && !byId("marketplaceBoardFilters")) {
      var oldToolbar = boardContent.querySelector(".toolbar");
      if (oldToolbar) oldToolbar.remove();
      boardContent.insertAdjacentHTML("afterbegin", [
        '<div class="card" id="marketplaceBoardFilters"><div class="market-filter-grid">',
        '<label>City<input id="marketCityFilter" type="text" placeholder="City"></label>',
        '<label>ZIP<input id="marketZipFilter" type="text" placeholder="ZIP"></label>',
        '<label>Service<select id="marketServiceFilter"><option value="">All services</option></select></label>',
        '<label>Frequency<select id="marketFrequencyFilter"><option value="">All frequencies</option><option>One-time</option><option>Weekly</option><option>Bi-weekly</option><option>Monthly</option><option>Seasonal</option></select></label>',
        '<label>Property Size<input id="marketSizeFilter" type="text" placeholder="Any size"></label>',
        '<label>Sort<select id="marketSort"><option value="newest">Newest first</option><option value="budget">Highest budget</option><option value="distance">Nearest first</option></select></label>',
        '<button class="btn btn-secondary" type="button" onclick="clearMarketplaceFilters()">Clear Filters</button>',
        '</div></div>'
      ].join(""));
    }
    var claim = byId("claimModal");
    if (claim) {
      claim.innerHTML = [
        '<div class="modal-card"><h2>Submit Quote or Interest</h2>',
        '<p class="lead">The buyer sees your quote and profile preview. Private address and contact details stay hidden until the buyer accepts you.</p>',
        '<form class="market-form" onsubmit="submitMarketplaceQuote(event)">',
        '<label>Quoted Price in Dollars<input id="quotePrice" inputmode="decimal" placeholder="Optional when using a price note"></label>',
        '<label>Price Note<input id="quotePriceNote" maxlength="500" placeholder="Example: Need a walkthrough before final pricing"></label>',
        '<label>Availability / Date / Time Note<textarea id="quoteAvailability" maxlength="800" required></textarea></label>',
        '<label>Message to Buyer<textarea id="quoteMessage" maxlength="1600" required></textarea></label>',
        '<label>Estimated Duration<input id="quoteDuration" maxlength="200" placeholder="Optional"></label>',
        '<div class="market-actions"><button class="btn btn-primary" id="confirmClaimBtn" type="submit">Submit Quote</button><button class="btn btn-secondary" type="button" onclick="closeClaimModal()">Cancel</button></div>',
        '</form></div>'
      ].join("");
    }
    if (!byId("marketplaceJobModal")) {
      document.body.insertAdjacentHTML("beforeend", '<div class="modal-backdrop" id="marketplaceJobModal" role="dialog" aria-modal="true" aria-labelledby="marketplaceJobTitle"><div class="modal-card market-modal-card"><div class="market-actions" style="justify-content:flex-end;margin-top:0"><button class="btn btn-secondary" type="button" onclick="closeMarketplaceJob()">Close</button></div><div id="marketplaceJobContent"><p>Loading request...</p></div></div></div>');
    }
    var paymentPage = byId("page-payment");
    if (paymentPage && !byId("paymentSandboxNotice")) {
      var header = paymentPage.querySelector(".page-header");
      if (header) {
        header.querySelector("h1").textContent = "Payment Setup";
        header.querySelector(".lead").textContent = "Complete Stripe Connect onboarding in Sandbox / Test Mode. No real payouts are enabled.";
        header.insertAdjacentHTML("afterend", '<div class="sandbox-banner" id="paymentSandboxNotice">Stripe Sandbox / Test Mode only. Contractor payout setup is for testing. No real money moves.</div>');
      }
    }
    var accountTitle = document.querySelector("#page-account h1");
    if (accountTitle) accountTitle.textContent = "My Requests and Account";
    var postedHeading = document.querySelector("#myPostedJobs") && document.querySelector("#myPostedJobs").previousElementSibling;
    if (postedHeading) postedHeading.textContent = "My Requests";
    var claimedHeading = document.querySelector("#myClaimedJobs") && document.querySelector("#myClaimedJobs").previousElementSibling;
    if (claimedHeading) claimedHeading.textContent = "Accepted Jobs";
    var navBoard = byId("navJobBoard");
    if (navBoard) navBoard.textContent = "Available Jobs";
    document.querySelectorAll("#marketplaceBoardFilters input,#marketplaceBoardFilters select").forEach(function (item) {
      item.addEventListener("input", renderMarketplaceBoard);
      item.addEventListener("change", renderMarketplaceBoard);
    });
  }

  window.validatePhotos = function () {
    var photoField = byId("photoField");
    var valid = state.selectedPhotos.length <= 8;
    if (photoField) {
      photoField.classList.toggle("invalid", !valid);
      var error = photoField.querySelector(".error-message");
      if (error) error.textContent = valid ? "" : "Upload no more than 8 photos.";
    }
    return valid;
  };

  async function loadOverview(silent) {
    if (!state.authUser) return;
    try {
      var data = await api("overview");
      state.marketplace = data;
      state.currentUser = Object.assign({}, state.currentUser || {}, data.profile || {});
      state.openJobs = data.availableJobs || [];
      state.myPostedJobs = data.myRequests || [];
      state.myClaimedJobs = data.myWork || [];
      state.myQuotes = data.myQuotes || [];
      if (typeof syncCurrentUserAliases === "function") syncCurrentUserAliases();
      renderMarketplaceBoard();
      renderMarketplaceAccount();
      renderMarketplaceContractorStatus();
      if (typeof renderAuthUI === "function") renderAuthUI();
    } catch (error) {
      if (!silent) notify(error, "Could not load your JCM dashboard.");
    }
  }
  window.loadMarketplaceOverview = loadOverview;

  function startRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function () { loadOverview(true); }, 30000);
    loadOverview(true);
  }

  window.marketplaceCreateJobFromForm = async function () {
    if (!state.authUser) return openSignInModal();
    if (!validateForm(byId("jobRequestForm")) || !window.validatePhotos()) {
      return toast("Please fix the highlighted fields.", "error");
    }
    var button = byId("submitJobBtn");
    setBusy(button, true);
    try {
      var urls = state.selectedPhotos.length ? await uploadJobPhotos() : [];
      await api("createJob", {
        title: field("jobTitle"),
        serviceType: field("serviceType"),
        city: field("job-city"),
        zipCode: field("job-zip"),
        fullAddress: field("fullAddress"),
        posterPhone: field("jobPhone"),
        propertySize: field("propertySize"),
        preferredDate: field("preferredDate"),
        budget: field("budget"),
        frequency: field("frequency"),
        details: field("jobDetails"),
        photoURLs: urls,
        latitude: state.jobLocation && state.jobLocation.latitude,
        longitude: state.jobLocation && state.jobLocation.longitude,
        locationAccuracyMeters: state.jobLocation && state.jobLocation.accuracyMeters,
        petsOnProperty: checked("petsOnProperty"),
        dangerousDebris: checked("dangerousDebris"),
        steepSlope: checked("steepSlope"),
        powerLines: checked("powerLines"),
        gateInstructions: field("gateInstructions"),
        parkingInstructions: field("parkingInstructions"),
        safetyConcerns: field("safetyConcerns"),
        privateNotes: field("privateNotes")
      });
      byId("jobRequestForm").reset();
      state.selectedPhotos = [];
      state.jobLocation = null;
      renderPhotoPreviews();
      await loadOverview(true);
      var result = byId("jobRequestResult");
      result.hidden = false;
      result.classList.remove("error");
      result.textContent = "Your service request was saved. Check My Requests for its current status and contractor quotes.";
      toast("Service request submitted.", "success");
    } catch (error) {
      notify(error, "The service request could not be submitted.");
    } finally {
      setBusy(button, false);
    }
  };

  window.marketplaceSubmitApplicationFromForm = async function () {
    if (!state.authUser) return openSignInModal();
    if (!validateForm(byId("contractorForm")) || !validateCheckboxGroup("skillsGroup", "skills") || !validateCheckboxGroup("availabilityGroup", "availability")) {
      return toast("Please fix the highlighted fields.", "error");
    }
    if (!checked("contractorRulesAgreement")) return toast("Agree to the contractor rules before submitting.", "error");
    var button = byId("submitApplicationBtn");
    setBusy(button, true);
    try {
      var radius = field("serviceRadius");
      var match = radius.match(/(\d+(?:\.\d+)?)/);
      await api("submitApplication", {
        legalName: field("contractorName"),
        displayName: field("contractorName"),
        businessName: field("contractorBusinessName"),
        email: field("contractorEmail"),
        phone: field("contractorPhone"),
        city: field("contractorCity"),
        zipCode: field("contractorZip"),
        serviceLocation: field("contractorServiceLocation"),
        latitude: state.contractorLocation && state.contractorLocation.latitude,
        longitude: state.contractorLocation && state.contractorLocation.longitude,
        serviceRadiusMiles: match ? Number(match[1]) : 0,
        servicesOffered: values("skills"),
        skills: values("skills"),
        equipment: field("equipment"),
        experience: field("experience"),
        yearsExperience: field("experience"),
        availability: values("availability").join(", "),
        references: field("contractorReferences"),
        insuranceInfo: field("contractorInsurance"),
        licenseInfo: field("contractorLicense"),
        agreedToRules: true
      });
      byId("contractorForm").reset();
      await loadOverview(true);
      toast("Application submitted for manual review.", "success");
    } catch (error) {
      notify(error, "Your contractor application could not be submitted.");
    } finally {
      setBusy(button, false);
    }
  };

  async function submitSupport(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!state.authUser) return openSignInModal();
    if (!validateForm(byId("supportForm"))) return toast("Please fix the highlighted fields.", "error");
    var button = byId("submitSupportBtn");
    setBusy(button, true);
    try {
      await api("submitSupport", {
        topic: field("supportTopic"),
        message: field("supportMessage"),
        priority: "normal"
      });
      byId("supportForm").reset();
      await loadOverview(true);
      toast("Support request sent.", "success");
    } catch (error) {
      notify(error, "Support request could not be sent.");
    } finally {
      setBusy(button, false);
    }
  }

  window.openClaimModal = function (jobId) {
    if (!state.authUser) return openSignInModal();
    if (!isApprovedContractorAccount()) return toast("Only approved contractors can submit quotes.", "error");
    if (!contractorReady()) {
      toast("Complete Stripe Test Mode payment setup before quoting.", "error");
      return showPage("payment");
    }
    state.pendingClaimId = jobId;
    byId("claimModal").classList.add("active");
    document.body.classList.add("modal-open");
  };

  window.submitMarketplaceQuote = async function (event) {
    event.preventDefault();
    var button = byId("confirmClaimBtn");
    setBusy(button, true);
    try {
      await api("submitQuote", {
        jobId: state.pendingClaimId,
        priceCents: field("quotePrice") ? dollarsToCents(field("quotePrice")) : null,
        priceNote: field("quotePriceNote"),
        availabilityNote: field("quoteAvailability"),
        message: field("quoteMessage"),
        estimatedDuration: field("quoteDuration")
      });
      closeClaimModal();
      await loadOverview(true);
      toast("Quote sent to the buyer.", "success");
    } catch (error) {
      notify(error, "Quote could not be submitted.");
    } finally {
      setBusy(button, false);
    }
  };
  window.confirmClaimJob = function () { return window.submitMarketplaceQuote(new Event("submit")); };

  window.withdrawMarketplaceQuote = async function (quoteId) {
    try {
      await api("withdrawQuote", { quoteId: quoteId });
      await loadOverview(true);
      toast("Quote withdrawn.", "success");
    } catch (error) {
      notify(error, "Quote could not be withdrawn.");
    }
  };

  window.clearMarketplaceFilters = function () {
    ["marketCityFilter", "marketZipFilter", "marketServiceFilter", "marketFrequencyFilter", "marketSizeFilter"].forEach(function (id) {
      if (byId(id)) byId(id).value = "";
    });
    if (byId("marketSort")) byId("marketSort").value = "newest";
    renderMarketplaceBoard();
  };

  function quoteForJob(jobId) {
    return (state.myQuotes || []).find(function (quote) { return quote.jobId === jobId && quote.status === "submitted"; });
  }

  function budgetNumber(job) {
    var values = String(job.budget || "").match(/\d+(?:\.\d+)?/g) || [];
    return values.length ? Math.max.apply(Math, values.map(Number)) : 0;
  }

  function renderMarketplaceBoard() {
    var grid = byId("jobBoardGrid");
    if (!grid) return;
    if (!state.authUser || !isApprovedContractorAccount()) return;
    var locationReady = Boolean(state.currentUser && ((state.currentUser.latitude != null && state.currentUser.longitude != null) || state.currentUser.city || state.currentUser.zipCode));
    if (!locationReady) {
      grid.innerHTML = '<div class="card empty-state" style="grid-column:1/-1"><h2>Service location required</h2><p>Add your city, ZIP code, service radius, or device location before quoting nearby jobs.</p></div>';
      return;
    }
    var city = field("marketCityFilter").toLowerCase();
    var zip = field("marketZipFilter");
    var service = field("marketServiceFilter");
    var frequency = field("marketFrequencyFilter");
    var size = field("marketSizeFilter").toLowerCase();
    var jobs = ((state.marketplace && state.marketplace.availableJobs) || []).filter(function (job) {
      return (!city || String(job.city || "").toLowerCase().includes(city)) &&
        (!zip || String(job.zipCode || "").includes(zip)) &&
        (!service || job.serviceType === service) &&
        (!frequency || job.frequency === frequency) &&
        (!size || String(job.propertySize || "").toLowerCase().includes(size));
    });
    var sort = field("marketSort") || "newest";
    jobs.sort(function (a, b) {
      if (sort === "budget") return budgetNumber(b) - budgetNumber(a);
      if (sort === "distance") return Number(a.approximateDistanceMiles == null ? 999999 : a.approximateDistanceMiles) - Number(b.approximateDistanceMiles == null ? 999999 : b.approximateDistanceMiles);
      return Number(new Date((b.createdAt && b.createdAt.__jcmTimestamp) || b.createdAt || 0)) - Number(new Date((a.createdAt && a.createdAt.__jcmTimestamp) || a.createdAt || 0));
    });
    if (!jobs.length) {
      grid.innerHTML = '<div class="card empty-state" style="grid-column:1/-1"><h2>No available jobs nearby</h2><p>New requests that match your service area will appear here.</p></div>';
      return;
    }
    grid.innerHTML = jobs.map(function (job) {
      var quote = quoteForJob(job.id);
      var photos = (job.photoURLs || []).slice(0, 3).map(function (url) { return '<img class="photo-thumb" src="' + esc(url) + '" alt="Buyer request photo">'; }).join("");
      var action = quote
        ? '<div class="market-actions"><button class="btn btn-secondary" type="button" onclick="withdrawMarketplaceQuote(\'' + esc(quote.id) + '\')">Withdraw Quote</button></div>'
        : contractorReady()
          ? '<button class="btn btn-primary full" type="button" onclick="openClaimModal(\'' + esc(job.id) + '\')">Submit Quote / Interest</button>'
          : '<button class="btn btn-primary full" type="button" onclick="showPage(\'payment\')">Payment Setup Required</button>';
      return '<article class="card job-card">' + statusBadge(job.status) + '<h3>' + esc(job.title || job.serviceType) + '</h3><div class="job-meta"><span>' + esc(job.serviceType) + '</span><span>' + esc([job.city, job.zipCode].filter(Boolean).join(" ")) + '</span><span>' + esc(job.approximateDistanceMiles == null ? "Approximate area" : job.approximateDistanceMiles + " mi approx.") + '</span><span>' + esc(job.propertySize || "") + '</span><span>' + esc(job.budget || "") + '</span><span>Preferred date: ' + esc(job.preferredDate || "Flexible") + '</span></div><p>' + esc(job.details || "") + '</p><div class="photo-strip">' + photos + '</div>' + action + '</article>';
    }).join("");
  }
  window.renderJobBoard = renderMarketplaceBoard;

  function renderChecklist() {
    if (!state.currentUser) return "";
    var profile = state.currentUser;
    var items = [
      ["Account created", true],
      ["Application submitted", Boolean(profile.contractorStatus)],
      ["Application approved", profile.contractorStatus === "approved"],
      ["Service location set", Boolean(profile.city || profile.zipCode || (profile.latitude != null && profile.longitude != null))],
      ["Stripe Test Mode onboarding complete", Boolean(profile.stripeOnboardingComplete)],
      ["Payouts enabled in Stripe Test Mode", Boolean(profile.stripePayoutsEnabled)],
      ["Ready to quote and accept jobs", isApprovedContractorAccount() && contractorReady()]
    ];
    return '<div class="market-checklist">' + items.map(function (item) { return '<span>' + (item[1] ? "Complete: " : "Needed: ") + esc(item[0]) + '</span>'; }).join("") + '</div>';
  }

  function renderMarketplaceContractorStatus() {
    var card = byId("contractorStatusCard");
    if (!card || !state.currentUser || role() !== "contractor") return;
    card.hidden = false;
    card.innerHTML = '<h2>Contractor Onboarding Checklist</h2><p class="lead">Stripe is in Sandbox / Test Mode. No real payouts are enabled.</p>' + renderChecklist() + '<div class="market-actions"><button class="btn btn-primary" type="button" onclick="showPage(\'job-board\')">Available Jobs</button><button class="btn btn-secondary" type="button" onclick="showPage(\'payment\')">Payment Setup</button></div>';
  }

  function requestCard(job, contractorView) {
    var next = "";
    if (job.status === "pending_verification") next = "Your request is not live yet. Verification or admin review is required before contractors can see it.";
    else if (job.status === "open") next = "Waiting for contractor quotes.";
    else if (job.status === "quotes_received") next = "Review contractor quotes.";
    else if (job.status === "awaiting_final_offer") next = "Discuss scope, price, and timing in chat. The contractor submits the formal final offer.";
    else if (job.status === "awaiting_payment") next = "Secure Job Payment is required before scheduling.";
    else if (job.status === "payment_held") next = "Payment is held until completion. The contractor can propose a schedule.";
    else if (job.status === "contractor_completed") next = "Buyer confirmation or dispute is required.";
    return '<article class="compact-card"><div class="compact-card-header"><div><h3>' + esc(job.title || "Service request") + '</h3><p>' + esc(job.serviceType || "") + '</p></div>' + statusBadge(job.status) + '</div><p>' + esc(next) + '</p><div class="market-actions"><button class="btn btn-secondary" type="button" onclick="openMarketplaceJob(\'' + esc(job.id) + '\')">View Details</button></div></article>';
  }

  var previousRenderAccountPage = window.renderAccountPage;
  function renderMarketplaceAccount() {
    if (typeof previousRenderAccountPage === "function") previousRenderAccountPage();
    if (!state.authUser || !state.marketplace) return;
    var requests = byId("myPostedJobs");
    if (requests) requests.innerHTML = state.marketplace.myRequests.length ? state.marketplace.myRequests.map(function (job) { return requestCard(job, false); }).join("") : '<div class="card"><p>No service requests yet.</p></div>';
    var work = byId("myClaimedJobs");
    if (work) work.innerHTML = state.marketplace.myWork.length ? state.marketplace.myWork.map(function (job) { return requestCard(job, true); }).join("") : '<div class="card"><p>No accepted jobs yet.</p></div>';
    var section = byId("claimedJobsSection");
    if (section) section.hidden = !(role() === "contractor" || ["owner", "admin"].includes(role()));
    var status = byId("contractorStatusMessage");
    if (status && role() === "contractor") status.innerHTML = "Contractor account approved. " + (contractorReady() ? "You are ready to submit quotes." : "Complete Payment Setup in Stripe Test Mode before quoting.") + renderChecklist();
  }
  window.renderAccountPage = renderMarketplaceAccount;

  function quoteList(detail) {
    if (!detail.quotes.length) return '<p>No quotes yet. Approved nearby contractors can submit quote or interest details.</p>';
    return detail.quotes.map(function (quote) {
      var profile = quote.contractorProfile || {};
      var amount = quote.priceCents ? money(quote.priceCents) : "Price note only";
      var accept = detail.job.postedBy === state.authUser.uid && ["open", "quotes_received"].includes(detail.job.status) && quote.status === "submitted"
        ? '<button class="btn btn-primary" type="button" onclick="acceptMarketplaceQuote(\'' + esc(quote.id) + '\')">Accept Contractor</button>' : "";
      return '<div class="market-row"><strong>' + esc(quote.contractorBusinessName || quote.contractorDisplayName) + '</strong><p>' + esc(amount) + (quote.priceNote ? " - " + esc(quote.priceNote) : "") + '</p><p><strong>Availability:</strong> ' + esc(quote.availabilityNote) + '</p><p>' + esc(quote.message) + '</p><p class="market-muted">Profile: ' + esc(profile.city || "service area provided") + '. Rating: ' + esc(profile.reviewCount ? profile.averageRating + " / 5 from " + profile.reviewCount + " review(s)" : "No completed reviews yet") + '. Stripe Test Mode ready: ' + esc(profile.stripeTestReady ? "Yes" : "No") + '.</p><div class="market-actions">' + accept + '</div></div>';
    }).join("");
  }

  function chat(detail) {
    if (!detail.messages.length && !detail.job.acceptedContractorId) return "";
    return '<div class="market-section"><h3>Job Chat</h3><div class="market-chat">' + detail.messages.map(function (message) {
      return '<div class="market-message ' + (message.senderRole === "system" ? "system" : "") + '"><strong>' + esc(message.senderRole === "system" ? "JCM System" : message.senderRole) + '</strong><p>' + esc(message.text) + '</p></div>';
    }).join("") + '</div>' + (detail.job.status === "closed" ? '<p class="market-muted">This conversation is read-only.</p>' : '<form class="market-form" onsubmit="sendMarketplaceMessage(event)"><textarea id="marketMessage" maxlength="4000" placeholder="Message the accepted contractor or buyer" required></textarea><button class="btn btn-secondary" type="submit">Send Message</button></form>') + '</div>';
  }

  function payment(detail) {
    if (!detail.payment) return "";
    var item = detail.payment;
    return '<div class="market-section"><h3>Secure Job Payment <span class="status-badge status-pending">Test Mode</span></h3><div class="market-grid"><div><strong>Buyer pays</strong><p>' + money(item.finalAmountCents) + '</p></div><div><strong>JCM platform fee (30%)</strong><p>' + money(item.platformFeeCents) + '</p></div><div><strong>Contractor payout (70%)</strong><p>' + money(item.contractorAmountCents) + '</p></div><div><strong>Payment status</strong><p>' + esc(item.paymentStatus) + '</p></div></div><p class="market-muted">Stripe is running in Sandbox / Test Mode. No real money is charged or paid. Payment is held until completion is confirmed or an admin resolves the job.</p></div>';
  }

  function finalOffers(detail) {
    if (!detail.finalOffers.length) return "";
    return '<div class="market-section"><h3>Final Offer</h3>' + detail.finalOffers.slice(0, 1).map(function (offer) {
      var buyerButtons = detail.job.postedBy === state.authUser.uid && offer.status === "submitted"
        ? '<div class="market-actions"><button class="btn btn-primary" type="button" onclick="respondMarketplaceOffer(\'' + esc(offer.id) + '\',\'accept\')">Accept Final Offer</button><button class="btn btn-secondary" type="button" onclick="respondMarketplaceOffer(\'' + esc(offer.id) + '\',\'reject\')">Reject Offer</button></div>' : "";
      return '<div class="market-row"><strong>' + money(offer.finalAmountCents) + '</strong><p><strong>Scope:</strong> ' + esc(offer.scopeSummary) + '</p><p><strong>Proposed timing:</strong> ' + esc(offer.proposedSchedule) + '</p><p>' + esc(offer.notes || "") + '</p><p>Status: ' + esc(offer.status) + '</p>' + buyerButtons + '</div>';
    }).join("") + '</div>';
  }

  function actionPanel(detail) {
    var job = detail.job;
    var buyer = job.postedBy === state.authUser.uid;
    var contractor = job.acceptedContractorId === state.authUser.uid;
    var html = '<div class="market-section"><h3>Next Actions</h3>';
    if (buyer && ["pending_verification", "open", "quotes_received"].includes(job.status)) {
      html += '<form class="market-form" onsubmit="saveMarketplaceJobEdit(event)"><label>Title<input id="editMarketTitle" value="' + esc(job.title) + '" required></label><label>Service Type<input id="editMarketService" value="' + esc(job.serviceType) + '" required></label><label>City<input id="editMarketCity" value="' + esc(job.city) + '" required></label><label>ZIP<input id="editMarketZip" value="' + esc(job.zipCode) + '" required></label><label>Property Size<input id="editMarketSize" value="' + esc(job.propertySize) + '" required></label><label>Budget Range<input id="editMarketBudget" value="' + esc(job.budget) + '" required></label><label>Frequency<input id="editMarketFrequency" value="' + esc(job.frequency) + '" required></label><label>Preferred Date<input id="editMarketPreferred" value="' + esc(job.preferredDate || "") + '"></label><label>Details<textarea id="editMarketDetails" required>' + esc(job.details) + '</textarea></label><button class="btn btn-secondary" type="submit">Save Request Changes</button></form>';
      html += cancellationForm(job.id);
    }
    if (buyer && job.status === "awaiting_payment") html += '<button class="btn btn-primary" type="button" onclick="payMarketplaceJob()">Pay Secure Job Payment in Test Mode</button>';
    if (contractor && ["awaiting_final_offer", "awaiting_buyer_offer_acceptance"].includes(job.status)) {
      html += '<form class="market-form" onsubmit="submitMarketplaceFinalOffer(event)"><h4>Submit Formal Final Offer</h4><label>Final Price in Dollars<input id="offerAmount" inputmode="decimal" required></label><label>Scope Summary<textarea id="offerScope" maxlength="4000" required></textarea></label><label>Proposed Date / Time / Arrival Window<input id="offerSchedule" maxlength="800" required></label><label>Notes<textarea id="offerNotes" maxlength="1200"></textarea></label><button class="btn btn-primary" type="submit">Submit Final Offer</button></form>';
    }
    if (contractor && ["payment_held", "scheduling"].includes(job.status)) {
      html += '<form class="market-form" onsubmit="proposeMarketplaceSchedule(event)"><h4>Propose Schedule</h4><label>Date<input id="scheduleDate" type="date" required></label><label>Arrival Window<input id="scheduleWindow" maxlength="160" placeholder="Example: 9:00 AM - 11:00 AM" required></label><label>Notes<textarea id="scheduleNotes" maxlength="800"></textarea></label><button class="btn btn-primary" type="submit">Propose Schedule</button></form>';
    }
    if (buyer && job.status === "scheduling" && job.proposedSchedule) html += '<div class="market-row"><strong>Proposed schedule</strong><p>' + esc(job.proposedSchedule.date) + ', ' + esc(job.proposedSchedule.timeWindow) + '</p><button class="btn btn-primary" type="button" onclick="confirmMarketplaceSchedule()">Confirm Schedule</button></div>';
    if (contractor && job.status === "scheduled") html += '<button class="btn btn-primary" type="button" onclick="startMarketplaceWork()">Mark Work In Progress</button>';
    if (contractor && job.status === "in_progress") html += '<form class="market-form" onsubmit="completeMarketplaceWork(event)"><label>Completion Photos<input id="completionPhotos" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label><label>Completion Note<textarea id="completionNote" maxlength="1200"></textarea></label><button class="btn btn-primary" type="submit">Mark Job Complete</button></form>';
    if (buyer && job.status === "contractor_completed") html += '<div class="market-actions"><button class="btn btn-primary" type="button" onclick="confirmMarketplaceCompletion()">Confirm Completion and Release Payment</button></div>' + disputeForm(job.id);
    if (buyer && job.status === "completed" && !detail.reviews.length) html += reviewForm();
    if (buyer && job.status === "canceled") html += '<form class="market-form" onsubmit="reopenMarketplaceJob(event)"><label>Why reopen this request?<textarea id="reopenNote" required></textarea></label><button class="btn btn-secondary" type="submit">Reopen Request</button></form>';
    if ((buyer || contractor) && !["closed"].includes(job.status)) html += reportForm();
    html += '</div>';
    return html;
  }

  function cancellationForm() {
    return '<form class="market-form" onsubmit="cancelMarketplaceJob(event)"><h4>Cancel Request</h4><label>Reason<select id="cancelReason" required>' + reasons() + '</select></label><label>Note<textarea id="cancelNote" maxlength="1600"></textarea></label><button class="btn btn-secondary" type="submit">Cancel Request</button></form>';
  }
  function disputeForm() {
    return '<form class="market-form" onsubmit="disputeMarketplaceJob(event)"><h4>Open Dispute</h4><label>Reason<select id="disputeReason" required>' + reasons() + '</select></label><label>Explain the problem<textarea id="disputeNote" maxlength="1600" required></textarea></label><button class="btn btn-secondary" type="submit">Dispute Completion</button></form>';
  }
  function reasons() {
    return '<option value="">Choose reason</option>' + (((state.marketplace && state.marketplace.cancellationReasons) || []).map(function (item) { return '<option>' + esc(item) + '</option>'; }).join(""));
  }
  function reportForm() {
    return '<form class="market-form" onsubmit="reportMarketplaceIssue(event)"><h4>Report a Problem</h4><label>Topic<select id="issueTopic"><option>No response from buyer</option><option>No response from contractor</option><option>Contractor no-show</option><option>Buyer no-show</option><option>Unsafe property</option><option>Wrong job details</option><option>Other job problem</option></select></label><label>Details<textarea id="issueMessage" maxlength="4000" required></textarea></label><button class="btn btn-secondary" type="submit">Send Problem Report</button></form>';
  }
  function reviewForm() {
    return '<form class="market-form" onsubmit="submitMarketplaceReview(event)"><h4>Leave Contractor Review</h4>' + ["Communication", "Quality", "Reliability / Showed Up", "Fair Pricing", "Overall"].map(function (label, index) { return '<label>' + label + '<select id="review' + index + '" required><option value="">Choose</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></label>'; }).join("") + '<label>Written Review<textarea id="reviewText" maxlength="1600"></textarea></label><button class="btn btn-primary" type="submit">Submit Review</button></form>';
  }

  function renderJob(detail) {
    var job = detail.job;
    var schedule = job.confirmedSchedule ? '<p><strong>Confirmed scheduled time:</strong> ' + esc(job.confirmedSchedule.date) + ', ' + esc(job.confirmedSchedule.timeWindow) + '</p>' : job.proposedSchedule ? '<p><strong>Proposed schedule:</strong> ' + esc(job.proposedSchedule.date) + ', ' + esc(job.proposedSchedule.timeWindow) + '</p>' : "";
    byId("marketplaceJobContent").innerHTML = '<h2 id="marketplaceJobTitle">' + esc(job.title || "Service request") + '</h2><div class="market-actions">' + statusBadge(job.status) + '<span class="status-badge status-pending">Stripe Test Mode</span></div><p><strong>Service:</strong> ' + esc(job.serviceType) + '</p><p><strong>Approximate area:</strong> ' + esc([job.city, job.zipCode].filter(Boolean).join(" ")) + '</p><p><strong>Property size:</strong> ' + esc(job.propertySize || "") + '</p><p><strong>Budget range:</strong> ' + esc(job.budget || "") + '</p><p><strong>Preferred date:</strong> ' + esc(job.preferredDate || "Flexible") + ' <span class="market-muted">(not a confirmed appointment)</span></p>' + schedule + '<p>' + esc(job.details || "") + '</p><div class="market-section"><h3>Contractor Quotes / Interests</h3>' + quoteList(detail) + '</div>' + (detail.canRevealPrivate ? '<div class="market-section"><h3>Private Job Details</h3><p class="market-muted">Available only to the buyer, accepted contractor after acceptance, and authorized admins. Each reveal is logged.</p><button class="btn btn-secondary" type="button" onclick="revealMarketplacePrivate()">Reveal Private Details</button><div id="marketPrivateDetails"></div></div>' : "") + finalOffers(detail) + payment(detail) + chat(detail) + actionPanel(detail);
  }

  window.openMarketplaceJob = async function (jobId) {
    activeJobId = jobId;
    byId("marketplaceJobModal").classList.add("active");
    document.body.classList.add("modal-open");
    byId("marketplaceJobContent").innerHTML = "<p>Loading request...</p>";
    try {
      var detail = await api("jobDetails", { jobId: jobId });
      state.activeMarketplaceDetail = detail;
      renderJob(detail);
    } catch (error) {
      byId("marketplaceJobContent").innerHTML = '<p class="market-warning">' + esc(error.message || "Request details could not be loaded.") + '</p>';
    }
  };
  window.closeMarketplaceJob = function () {
    activeJobId = "";
    state.activeMarketplaceDetail = null;
    byId("marketplaceJobModal").classList.remove("active");
    document.body.classList.remove("modal-open");
  };
  async function refreshActiveJob() {
    await loadOverview(true);
    if (activeJobId) return openMarketplaceJob(activeJobId);
  }
  window.acceptMarketplaceQuote = async function (quoteId) { try { await api("acceptQuote", { quoteId: quoteId }); await refreshActiveJob(); toast("Contractor accepted. Chat is open.", "success"); } catch (error) { notify(error); } };
  window.sendMarketplaceMessage = async function (event) { event.preventDefault(); try { await api("sendMessage", { jobId: activeJobId, message: field("marketMessage") }); await refreshActiveJob(); } catch (error) { notify(error); } };
  window.submitMarketplaceFinalOffer = async function (event) { event.preventDefault(); try { await api("createFinalOffer", { jobId: activeJobId, finalAmountCents: dollarsToCents(field("offerAmount")), scopeSummary: field("offerScope"), proposedSchedule: field("offerSchedule"), notes: field("offerNotes") }); await refreshActiveJob(); toast("Final offer sent.", "success"); } catch (error) { notify(error); } };
  window.respondMarketplaceOffer = async function (offerId, decision) { try { await api("respondFinalOffer", { offerId: offerId, decision: decision }); await refreshActiveJob(); toast(decision === "accept" ? "Final offer accepted. Payment is required next." : "Offer rejected. Continue the conversation.", "success"); } catch (error) { notify(error); } };
  window.payMarketplaceJob = async function () { try { var data = await api("startCheckout", { jobId: activeJobId }); window.location.assign(data.url); } catch (error) { notify(error); } };
  window.proposeMarketplaceSchedule = async function (event) { event.preventDefault(); try { await api("proposeSchedule", { jobId: activeJobId, date: field("scheduleDate"), timeWindow: field("scheduleWindow"), notes: field("scheduleNotes") }); await refreshActiveJob(); toast("Schedule proposed.", "success"); } catch (error) { notify(error); } };
  window.confirmMarketplaceSchedule = async function () { try { await api("confirmSchedule", { jobId: activeJobId }); await refreshActiveJob(); toast("Schedule confirmed.", "success"); } catch (error) { notify(error); } };
  window.startMarketplaceWork = async function () { try { await api("startWork", { jobId: activeJobId }); await refreshActiveJob(); toast("Job marked in progress.", "success"); } catch (error) { notify(error); } };
  async function uploadCompletionPhotos(files) {
    return Promise.all(Array.from(files || []).slice(0, 8).map(function (file) {
      var safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      return storage.ref("completion-photos/" + state.authUser.uid + "/" + Date.now() + "_" + safeName).put(file).then(function (snapshot) { return snapshot.ref.getDownloadURL(); });
    }));
  }
  window.completeMarketplaceWork = async function (event) { event.preventDefault(); try { var photos = await uploadCompletionPhotos(byId("completionPhotos").files); await api("completeWork", { jobId: activeJobId, completionPhotoURLs: photos, note: field("completionNote") }); await refreshActiveJob(); toast("Job marked complete. Buyer confirmation is required.", "success"); } catch (error) { notify(error); } };
  window.confirmMarketplaceCompletion = async function () { try { await api("confirmCompletion", { jobId: activeJobId }); await refreshActiveJob(); toast("Completion confirmed and Stripe Test Mode release recorded.", "success"); } catch (error) { notify(error); } };
  window.disputeMarketplaceJob = async function (event) { event.preventDefault(); try { await api("disputeJob", { jobId: activeJobId, reason: field("disputeReason"), note: field("disputeNote") }); await refreshActiveJob(); toast("Dispute opened. Payout release is blocked.", "success"); } catch (error) { notify(error); } };
  window.cancelMarketplaceJob = async function (event) { event.preventDefault(); try { await api("cancelJob", { jobId: activeJobId, reason: field("cancelReason"), note: field("cancelNote") }); await refreshActiveJob(); toast("Request canceled.", "success"); } catch (error) { notify(error); } };
  window.reopenMarketplaceJob = async function (event) { event.preventDefault(); try { await api("reopenJob", { jobId: activeJobId, note: field("reopenNote") }); await refreshActiveJob(); toast("Request reopened.", "success"); } catch (error) { notify(error); } };
  window.revealMarketplacePrivate = async function () { try { var data = await api("revealPrivateDetails", { jobId: activeJobId }); var item = data.details; var lines = [item.posterName || "Buyer", item.fullAddress || "Address not provided", item.posterPhone || "Phone not provided", item.posterEmail || "", "", "Gate / lock: " + (item.gateInstructions || "None provided"), "Parking / access: " + (item.parkingInstructions || "None provided"), "Private notes: " + (item.privateNotes || "None provided")]; byId("marketPrivateDetails").innerHTML = '<div class="market-row market-private">' + lines.map(esc).join("<br>") + '</div>'; } catch (error) { notify(error); } };
  window.submitMarketplaceReview = async function (event) { event.preventDefault(); try { await api("submitReview", { jobId: activeJobId, communicationRating: Number(field("review0")), qualityRating: Number(field("review1")), reliabilityRating: Number(field("review2")), fairPricingRating: Number(field("review3")), overallRating: Number(field("review4")), writtenReview: field("reviewText") }); await refreshActiveJob(); toast("Review submitted.", "success"); } catch (error) { notify(error); } };
  window.reportMarketplaceIssue = async function (event) { event.preventDefault(); try { await api("reportIssue", { jobId: activeJobId, topic: field("issueTopic"), message: field("issueMessage"), priority: field("issueTopic").toLowerCase().includes("unsafe") ? "urgent" : "normal" }); await refreshActiveJob(); toast("Problem report sent to JCM support.", "success"); } catch (error) { notify(error); } };
  window.saveMarketplaceJobEdit = async function (event) { event.preventDefault(); try { var job = state.activeMarketplaceDetail.job; await api("updateJob", { jobId: activeJobId, title: field("editMarketTitle"), serviceType: field("editMarketService"), city: field("editMarketCity"), zipCode: field("editMarketZip"), propertySize: field("editMarketSize"), budget: field("editMarketBudget"), frequency: field("editMarketFrequency"), preferredDate: field("editMarketPreferred"), details: field("editMarketDetails"), photoURLs: job.photoURLs || [], petsOnProperty: Boolean(job.petsOnProperty), dangerousDebris: Boolean(job.dangerousDebris), steepSlope: Boolean(job.steepSlope), powerLines: Boolean(job.powerLines), safetyConcerns: job.safetyConcerns || "" }); await refreshActiveJob(); toast("Request updated. Existing quotes may need resubmission.", "success"); } catch (error) { notify(error); } };

  function wire() {
    installDom();
    var support = byId("supportForm");
    if (support && support.dataset.marketplaceReady !== "true") {
      support.dataset.marketplaceReady = "true";
      support.addEventListener("submit", submitSupport, true);
    }
    auth.onAuthStateChanged(function (user) {
      if (!user) {
        if (refreshTimer) clearInterval(refreshTimer);
        state.marketplace = null;
        return;
      }
      setTimeout(startRefresh, 50);
    });
    if (state.authUser) startRefresh();
    var select = byId("marketServiceFilter");
    if (select && typeof serviceTypes !== "undefined") select.innerHTML = '<option value="">All services</option>' + serviceTypes.map(function (item) { return '<option>' + esc(item) + '</option>'; }).join("");
  }

  wire();
})();
