(function () {
  "use strict";

  var WORKFLOW_PAGES = ["home", "post-job", "job-board", "payment", "contractor-apply", "account", "how-it-works", "support"];
  var recaptchaVerifier = null;
  var phoneConfirmation = null;
  var overrideEventsWired = false;

  function safe(id) { return document.getElementById(id); }
  function roleOf(user) {
    var role = String((user && user.role) || "buyer").toLowerCase();
    return role === "user" ? "buyer" : role;
  }
  function userEmailOrPhone(user) {
    return (user && (user.email || user.phoneNumber)) || "";
  }
  function numberOrNull(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function parseRadiusMiles(value) {
    if (value == null) return null;
    var match = String(value).match(/(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : null;
  }
  function formatMoney(cents, currency) {
    var amount = Number(cents || 0) / 100;
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "usd").toUpperCase()
    }).format(amount);
  }
  function formatPaymentDate(seconds) {
    if (!seconds) return "Not set";
    return new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function distanceMiles(aLat, aLng, bLat, bLng) {
    var lat1 = numberOrNull(aLat);
    var lng1 = numberOrNull(aLng);
    var lat2 = numberOrNull(bLat);
    var lng2 = numberOrNull(bLng);
    if ([lat1, lng1, lat2, lng2].some(function (value) { return value == null; })) return null;
    var toRad = function (value) { return value * Math.PI / 180; };
    var earthMiles = 3958.8;
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return earthMiles * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function installWorkflowDom() {
    var modalCard = document.querySelector("#signInModal .modal-card");
    if (modalCard && !safe("emailAuthPanel")) {
      modalCard.innerHTML = [
        '<img class="modal-logo" src="JCM_Landscaping.png" alt="JCM Landscaping">',
        '<h2 id="signInTitle">Sign in or create an account</h2>',
        '<p>Create an account with email and password to submit service requests, apply as a contractor, or manage your JCM profile.</p>',
        '<div class="auth-tabs" role="tablist" aria-label="Sign in method">',
        '  <button class="auth-tab active" id="authModeEmail" type="button" onclick="showAuthMode(\'email\')">Email</button>',
        '  <button class="auth-tab" id="authModePhone" type="button" title="Phone sign-in requires an SMS provider" disabled>Phone unavailable</button>',
        '</div>',
        '<div class="auth-panel" id="emailAuthPanel">',
        '  <label for="authName">Name</label>',
        '  <input id="authName" type="text" autocomplete="name" placeholder="Your name">',
        '  <label for="authEmail">Email</label>',
        '  <input id="authEmail" type="email" autocomplete="email" placeholder="Email address">',
        '  <label for="authPassword">Password</label>',
        '  <input id="authPassword" type="password" autocomplete="current-password" minlength="8" placeholder="At least 8 characters">',
        '  <div class="inline-actions">',
        '    <button class="btn btn-primary" id="emailRegisterBtn" type="button" onclick="registerWithEmail()">Create Account</button>',
        '    <button class="btn btn-secondary" id="emailSignInBtn" type="button" onclick="signInWithEmail()">Sign In</button>',
        '  </div>',
        '</div>',
        '<div class="auth-panel" id="phoneAuthPanel" hidden>',
        '  <label for="phoneName">Name</label>',
        '  <input id="phoneName" type="text" autocomplete="name" placeholder="Your name">',
        '  <label for="authPhone">Phone Number</label>',
        '  <input id="authPhone" type="tel" autocomplete="tel" placeholder="Phone number with country code">',
        '  <button class="btn btn-primary full" id="phoneSendBtn" type="button" onclick="sendPhoneCode()">Send Code</button>',
        '  <label for="authCode">Verification Code</label>',
        '  <input id="authCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6 digit code">',
        '  <button class="btn btn-secondary full" id="phoneVerifyBtn" type="button" onclick="verifyPhoneCode()">Verify and Continue</button>',
        '</div>',
        '<div id="recaptcha-container" class="recaptcha-container"></div>',
        '<button class="nav-link" type="button" style="margin:14px auto 0;" onclick="closeSignInModal()">Cancel</button>'
      ].join("");
    }

    var accountSignedOut = safe("accountSignedOut");
    if (accountSignedOut) {
      accountSignedOut.innerHTML = '<h2>Sign in to view your profile.</h2><p class="lead">Your profile shows your submitted service requests, contractor status, quotes, and accepted work.</p><div class="hero-actions"><button class="btn btn-primary" type="button" onclick="openSignInModal()">Sign In or Create Account</button></div>';
    }

    var jobAddressField = safe("fullAddress");
    if (jobAddressField && !safe("jobLocationControls")) {
      jobAddressField.closest(".form-field").insertAdjacentHTML("afterend", [
        '<div class="form-field full" id="jobLocationControls">',
        '  <label>Request Location</label>',
        '  <button class="btn btn-secondary" type="button" onclick="useJobCurrentLocation(this)">Use My Current Location</button>',
        '  <span class="hint" id="jobLocationStatus">Optional. If you allow location access, nearby contractors can match by distance. If not, JCM uses your real city and ZIP code.</span>',
        '</div>'
      ].join(""));
    }

    var contractorEmail = safe("contractorEmail");
    if (contractorEmail) {
      contractorEmail.required = false;
      var label = document.querySelector('label[for="contractorEmail"]');
      if (label) label.textContent = "Email";
    }
    var contractorRadius = safe("serviceRadius");
    if (contractorRadius && !safe("contractorLocationControls")) {
      contractorRadius.closest(".form-field").insertAdjacentHTML("afterend", [
        '<div class="form-field full" id="contractorLocationControls">',
        '  <label>Service Location</label>',
        '  <button class="btn btn-secondary" type="button" onclick="useContractorCurrentLocation(this)">Use My Current Location</button>',
        '  <span class="hint" id="contractorLocationStatus">Your city, ZIP code, service radius, and optional latitude and longitude help match nearby available jobs.</span>',
        '</div>'
      ].join(""));
    }

    var boardContent = safe("boardContent");
    if (boardContent && !safe("jobBoardNotice")) {
      boardContent.insertAdjacentHTML("afterbegin", '<div class="notice" id="jobBoardNotice" hidden></div>');
    }

    var contractorApplyPage = safe("page-contractor-apply");
    if (contractorApplyPage && !safe("page-payment")) {
      contractorApplyPage.insertAdjacentHTML("beforebegin", [
        '<section class="page" id="page-payment">',
        '  <div class="page-header">',
        '    <span class="eyebrow">Contractor Payment</span>',
        '    <h1>Payment</h1>',
        '    <p class="lead">Set up Stripe Connect in Sandbox / Test Mode before quoting paid jobs and review test payout readiness.</p>',
        '  </div>',
        '  <div id="paymentSignedOut" class="card locked-state" hidden>',
        '    <h2>Sign in to manage payments.</h2>',
        '    <p class="lead">Contractor payment details are available only to the signed-in contractor.</p>',
        '    <div class="hero-actions"><button class="btn btn-primary" type="button" onclick="openSignInModal()">Sign In</button></div>',
        '  </div>',
        '  <div id="paymentLocked" class="card locked-state" hidden>',
        '    <h2>Payment is for approved contractors.</h2>',
        '    <p class="lead" id="paymentLockedMessage">Your contractor application must be approved before Stripe setup is available.</p>',
        '    <div class="hero-actions"><button class="btn btn-secondary" type="button" onclick="goContractorApply()">Apply as a Contractor</button></div>',
        '  </div>',
        '  <div id="paymentContent" hidden>',
        '    <div class="payment-grid">',
        '      <section class="card">',
        '        <div class="item-header"><div><h2>Stripe Setup</h2><p id="stripeStatusSummary">Checking Stripe status...</p></div><span class="status-badge" id="stripeStatusBadge">unknown</span></div>',
        '        <div class="item-meta payment-meta">',
        '          <span><strong>Can receive payouts:</strong> <span id="payoutsStatus">Unknown</span></span>',
        '          <span><strong>Onboarding complete:</strong> <span id="onboardingStatus">Unknown</span></span>',
        '          <span><strong>Last synced:</strong> <span id="stripeLastSync">Not synced</span></span>',
        '        </div>',
        '        <div class="notice" id="paymentIssue" hidden></div>',
        '        <div id="requirementsList" class="compact-list"></div>',
        '        <div class="hero-actions">',
        '          <button class="btn btn-primary" id="stripeSetupBtn" type="button" onclick="startStripeOnboarding(this)">Set Up Payments with Stripe</button>',
        '          <button class="btn btn-secondary" id="stripeDashboardBtn" type="button" onclick="openStripeDashboard(this)">Open Stripe Dashboard</button>',
        '          <button class="btn btn-secondary" id="stripeRefreshBtn" type="button" onclick="refreshStripeStatus(this)">Refresh Status</button>',
        '        </div>',
        '      </section>',
        '      <section class="card">',
        '        <h2>Payout Summary</h2>',
        '        <div class="payment-totals">',
        '          <div><span>Paid today</span><strong id="paidToday">$0.00</strong></div>',
        '          <div><span>Paid this week</span><strong id="paidWeek">$0.00</strong></div>',
        '          <div><span>Paid this month</span><strong id="paidMonth">$0.00</strong></div>',
        '          <div><span>Pending payout</span><strong id="pendingPayout">$0.00</strong></div>',
        '        </div>',
        '      </section>',
        '    </div>',
        '    <section class="home-section">',
        '      <h2>Payment History</h2>',
        '      <div class="compact-list" id="paymentHistory"><div class="card"><p>No payment history yet.</p></div></div>',
        '    </section>',
        '  </div>',
        '</section>'
      ].join(""));
    }

    var cookieText = document.querySelector("#cookieBanner p");
    if (cookieText) {
      cookieText.innerHTML = 'We use cookies to keep you signed in and remember preferences. By accepting cookies, you agree to our <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.';
    }
    var mobilePost = safe("mbnPost");
    if (mobilePost) {
      var label = mobilePost.querySelector("span:last-child");
      if (label) label.textContent = "Request";
    }
  }

  window.showAuthMode = function (mode) {
    var emailMode = mode !== "phone";
    if (safe("emailAuthPanel")) safe("emailAuthPanel").hidden = !emailMode;
    if (safe("phoneAuthPanel")) safe("phoneAuthPanel").hidden = emailMode;
    if (safe("authModeEmail")) safe("authModeEmail").classList.toggle("active", emailMode);
    if (safe("authModePhone")) safe("authModePhone").classList.toggle("active", !emailMode);
  };

  window.openSignInModal = function () {
    installWorkflowDom();
    safe("signInModal").classList.add("active");
    document.body.classList.add("modal-open");
  };

  window.closeSignInModal = function (clearPending) {
    safe("signInModal").classList.remove("active");
    document.body.classList.remove("modal-open");
    if (clearPending !== false) state.pendingAction = null;
  };

  async function completeAuthProfile(user, displayName) {
    var name = String(displayName || "").trim();
    if (name && !user.displayName) {
      await user.updateProfile({ displayName: name });
      await user.reload();
    }
    handleSignedInUser(auth.currentUser || user);
    syncSignedInProfile(auth.currentUser || user, 0);
  }

  window.registerWithEmail = async function () {
    var button = safe("emailRegisterBtn");
    setButtonLoading(button, true);
    try {
      var name = safe("authName").value.trim();
      var email = safe("authEmail").value.trim();
      var password = safe("authPassword").value;
      if (!email || !password) throw new Error("Enter an email address and password.");
      var result = await auth.createUserWithEmailAndPassword(email, password);
      await completeAuthProfile(result.user, name);
      try { await result.user.sendEmailVerification(); } catch (error) { /* Email verification can be resent later. */ }
      toast("Account created. You're signed in.", "success");
    } catch (error) {
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.signInWithEmail = async function () {
    var button = safe("emailSignInBtn");
    setButtonLoading(button, true);
    try {
      var email = safe("authEmail").value.trim();
      var password = safe("authPassword").value;
      if (!email || !password) throw new Error("Enter your email address and password.");
      var result = await auth.signInWithEmailAndPassword(email, password);
      await completeAuthProfile(result.user, safe("authName").value);
      toast("Signed in.", "success");
    } catch (error) {
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.legacyProviderSignIn = async function () {
    openSignInModal();
    toast("Use email or phone sign-in for JCM accounts.", "info");
  };

  function ensureRecaptcha() {
    if (recaptchaVerifier) return recaptchaVerifier;
    recaptchaVerifier = new githubData.auth.RecaptchaVerifier("recaptcha-container", {
      size: "invisible",
      callback: function () {}
    });
    return recaptchaVerifier;
  }

  window.sendPhoneCode = async function () {
    var button = safe("phoneSendBtn");
    setButtonLoading(button, true);
    try {
      var phone = safe("authPhone").value.trim();
      if (!phone) throw new Error("Enter a phone number with country code, such as +1.");
      phoneConfirmation = await auth.signInWithPhoneNumber(phone, ensureRecaptcha());
      toast("Verification code sent.", "success");
    } catch (error) {
      if (recaptchaVerifier && recaptchaVerifier.clear) {
        recaptchaVerifier.clear();
        recaptchaVerifier = null;
      }
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.verifyPhoneCode = async function () {
    var button = safe("phoneVerifyBtn");
    setButtonLoading(button, true);
    try {
      if (!phoneConfirmation) throw new Error("Send a verification code first.");
      var code = safe("authCode").value.trim();
      if (!code) throw new Error("Enter the verification code.");
      var result = await phoneConfirmation.confirm(code);
      await completeAuthProfile(result.user, safe("phoneName").value);
      toast("Phone verified. You're signed in.", "success");
    } catch (error) {
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.dataMessage = function (error) {
    var text = String((error && (error.message || error.code)) || "");
    if (text.toLowerCase().includes("unauthorized-domain")) {
      return "This domain is not authorized in JCM authentication yet. Add this domain in JCM authentication authorized domains.";
    }
    if (text.toLowerCase().includes("auth/operation-not-allowed")) {
      return "This sign-in provider is not enabled yet.";
    }
    if (text.toLowerCase().includes("offline") || text.toLowerCase().includes("unavailable")) {
      return "JCM could not reach JCM data services from this browser. Check your connection, refresh, or try again in a moment.";
    }
    return text || "Something went wrong. Please try again.";
  };

  window.isSuspended = function () {
    return Boolean(state.currentUser && (state.currentUser.suspended || roleOf(state.currentUser) === "suspended"));
  };
  window.isAdminLike = function () {
    var role = roleOf(state.currentUser);
    return Boolean(state.currentUser && ["owner", "admin"].includes(role) && !isSuspended());
  };
  window.isModeratorLike = function () {
    var role = roleOf(state.currentUser);
    return Boolean(state.currentUser && ["owner", "admin", "moderator"].includes(role) && !isSuspended());
  };
  window.isOwnerLike = function () {
    return Boolean(state.currentUser && roleOf(state.currentUser) === "owner" && !isSuspended());
  };
  window.isApprovedContractor = function () {
    return Boolean(state.currentUser && roleOf(state.currentUser) === "contractor" && state.currentUser.contractorStatus === "approved" && !isSuspended());
  };
  window.isContractorLike = function () {
    return Boolean(isAdminLike() || isApprovedContractor());
  };
  function contractorNeedsPaymentSetup() {
    if (!state.currentUser || roleOf(state.currentUser) !== "contractor") return false;
    return !(state.currentUser.stripeOnboardingComplete && state.currentUser.stripePayoutsEnabled);
  }

  window.ensureUserDoc = async function (signedInUser) {
    var ref = db.collection("users").doc(signedInUser.uid);
    var snap = await ref.get();
    var payload = {
      uid: signedInUser.uid,
      email: signedInUser.email || "",
      phoneNumber: signedInUser.phoneNumber || "",
      displayName: signedInUser.displayName || "",
      photoURL: signedInUser.photoURL || "",
      lastSeen: serverTimestamp()
    };
    if (!snap.exists) {
      payload.role = "buyer";
      payload.contractorStatus = null;
      payload.createdAt = serverTimestamp();
      await ref.set(payload);
      return payload;
    }
    await ref.set(payload, { merge: true });
    return { uid: signedInUser.uid, ...snap.data(), ...payload };
  };

  window.authProfileUser = function (signedInUser) {
    return {
      uid: signedInUser.uid,
      email: signedInUser.email || "",
      phoneNumber: signedInUser.phoneNumber || "",
      displayName: signedInUser.displayName || (signedInUser.email || signedInUser.phoneNumber || "JCM User"),
      photoURL: signedInUser.photoURL || "",
      role: "buyer",
      contractorStatus: null,
      profileSyncPending: true
    };
  };

  window.prefillUserForms = function () {
    if (!state.authUser || !state.currentUser) return;
    if (safe("contractorName")) safe("contractorName").value = state.currentUser.displayName || state.authUser.displayName || "";
    if (safe("contractorEmail")) safe("contractorEmail").value = state.currentUser.email || state.authUser.email || "";
    if (safe("contractorPhone") && !safe("contractorPhone").value) safe("contractorPhone").value = state.currentUser.phoneNumber || state.authUser.phoneNumber || "";
    if (safe("supportName")) safe("supportName").value = state.currentUser.displayName || state.authUser.displayName || "";
    if (safe("supportEmail")) safe("supportEmail").value = state.currentUser.email || state.authUser.email || "";
  };

  window.showPage = function (pageId, focusFaq, skipHistory) {
    installWorkflowDom();
    if (!WORKFLOW_PAGES.includes(pageId)) pageId = "home";
    var main = safe("mainContent");
    main.classList.add("transitioning");
    setTimeout(function () {
      document.querySelectorAll(".page").forEach(function (page) {
        page.classList.toggle("active", page.id === "page-" + pageId);
      });
      safe("homeHero").classList.toggle("active", pageId === "home");
      state.activePage = pageId;
      if (typeof updateMobileBottomNav === "function") updateMobileBottomNav(pageId);
      document.querySelectorAll(".nav-link").forEach(function (link) {
        link.classList.toggle("active", link.textContent.trim().toLowerCase().includes(pageId.replace("-", " ")));
      });
      closeAccountDropdown();
      main.classList.remove("transitioning");
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (focusFaq) setTimeout(function () { safe("faqList").scrollIntoView({ behavior: "smooth", block: "start" }); }, 120);
      renderPageGuards();
      if (pageId === "payment") loadPaymentSummary();
      if (!skipHistory && !state.routingFromPop && window.location.hash !== "#" + pageId) {
        window.history.pushState(null, "", "#" + pageId);
      }
    }, 90);
  };

  window.navigatePage = function (pageId, focusFaq) {
    if (pageId === "post-job") return goPostJob();
    if (pageId === "contractor-apply") return goContractorApply();
    if (pageId === "job-board" && !isContractorLike()) {
      showPage("job-board");
      return;
    }
    if (pageId === "payment" && !state.authUser) {
      state.pendingAction = function () { showPage("payment"); };
      openSignInModal();
      return;
    }
    showPage(pageId, focusFaq);
  };

  window.routeFromHash = function () {
    var page = window.location.hash.replace("#", "").split("?")[0];
    state.routingFromPop = true;
    if (WORKFLOW_PAGES.includes(page)) navigatePage(page);
    else showPage("home", false, true);
    setTimeout(function () { state.routingFromPop = false; }, 160);
  };

  window.goPostJob = function () {
    requireAuth(function () {
      if (isSuspended()) {
        toast("Your account is suspended and cannot submit service requests.", "error");
        return;
      }
      showPage("post-job");
    });
  };

  window.goContractorApply = function () {
    requireAuth(function () {
      if (isContractorLike()) {
        showPage("job-board");
        return;
      }
      showPage("contractor-apply");
    });
  };

  window.closeAccountDropdown = function () {
    var menu = safe("accountMenu");
    if (menu) menu.classList.remove("open", "keyboard-open");
    document.querySelectorAll(".dropdown.keyboard-open").forEach(function (item) { item.classList.remove("keyboard-open"); });
  };

  window.showPageAndClose = function (pageId) {
    closeAccountDropdown();
    showPage(pageId);
  };

  window.accountTriggerClick = function (event) {
    if (!state.authUser) {
      event.preventDefault();
      openSignInModal();
      return;
    }
    event.currentTarget.focus();
  };

  window.renderAuthUI = function () {
    installWorkflowDom();
    var signedIn = Boolean(state.authUser && state.currentUser);
    safe("navJobBoard").classList.toggle("hidden", !isContractorLike());
    document.querySelectorAll(".mobile-contractor-only").forEach(function (el) { el.classList.toggle("hidden", !isContractorLike()); });
    document.querySelectorAll(".mobile-applicant-only").forEach(function (el) { el.classList.toggle("hidden", !signedIn || isContractorLike()); });
    if (!signedIn) {
      safe("accountMenu").classList.add("signed-out");
      safe("accountAvatar").innerHTML = "";
      safe("accountLabel").textContent = "Sign In";
      safe("accountDropdownSurface").innerHTML = "";
      safe("accountChevron").classList.add("hidden");
      safe("mobileAccountButton").textContent = "Sign In";
      return;
    }
    safe("accountMenu").classList.remove("signed-out");
    safe("accountChevron").classList.remove("hidden");
    var accountFirstName = firstName(state.currentUser.displayName || (userEmailOrPhone(state.currentUser)).split("@")[0]);
    safe("accountLabel").textContent = accountFirstName;
    safe("mobileAccountButton").textContent = "Account (" + accountFirstName + ")";
    if (state.currentUser.photoURL) safe("accountAvatar").innerHTML = '<img src="' + escapeHtml(state.currentUser.photoURL) + '" alt="">';
    else safe("accountAvatar").textContent = accountFirstName.slice(0, 1).toUpperCase();
    var links = ['<button type="button" onclick="showPageAndClose(\'account\')">My Profile</button>'];
    links.push('<button type="button" onclick="showPageAndClose(\'account\')">My Service Requests</button>');
    if (isContractorLike()) {
      links.push('<button type="button" onclick="showPageAndClose(\'job-board\')">Jobs</button>');
      links.push('<button type="button" onclick="showPageAndClose(\'payment\')">Payment</button>');
    }
    if (isModeratorLike()) links.push('<a href="/admin">Admin Dashboard</a>');
    links.push('<div class="dropdown-divider"></div>');
    links.push('<button type="button" onclick="signOut()">Sign Out</button>');
    safe("accountDropdownSurface").innerHTML = links.join("");
  };

  window.renderPageGuards = function () {
    installWorkflowDom();
    if (safe("emailVerifyNotice")) safe("emailVerifyNotice").hidden = !(state.authUser && state.authUser.email && !state.authUser.emailVerified);
    var canBoard = isContractorLike();
    safe("boardLocked").hidden = canBoard;
    safe("boardContent").hidden = !canBoard;
    renderContractorApplicationState();
    renderJobBoard();
    renderPaymentPage();
    renderAccountPage();
  };

  function locationFromCurrentUser() {
    var user = state.currentUser || {};
    return {
      city: String(user.city || user.serviceCity || "").trim(),
      zipCode: String(user.zipCode || user.serviceZipCode || "").trim(),
      serviceRadius: user.serviceRadius || "",
      serviceRadiusMiles: numberOrNull(user.serviceRadiusMiles) || parseRadiusMiles(user.serviceRadius),
      latitude: numberOrNull(user.latitude),
      longitude: numberOrNull(user.longitude)
    };
  }

  function hasServiceLocation(location) {
    return Boolean((location.latitude != null && location.longitude != null) || location.city || location.zipCode);
  }

  function jobMatchesContractorLocation(job) {
    var location = locationFromCurrentUser();
    if (!hasServiceLocation(location)) return false;
    var jobLat = numberOrNull(job.latitude);
    var jobLng = numberOrNull(job.longitude);
    if (location.latitude != null && location.longitude != null && jobLat != null && jobLng != null) {
      var radius = location.serviceRadiusMiles;
      if (radius == null) return true;
      var miles = distanceMiles(location.latitude, location.longitude, jobLat, jobLng);
      return miles != null && miles <= radius;
    }
    var contractorZip = String(location.zipCode || "").trim();
    var contractorCity = String(location.city || "").trim().toLowerCase();
    var jobZip = String(job.zipCode || "").trim();
    var jobCity = String(job.city || "").trim().toLowerCase();
    if (contractorZip && jobZip && contractorZip === jobZip) return true;
    if (contractorCity && jobCity && contractorCity === jobCity) return true;
    return false;
  }

  window.renderJobBoard = function () {
    if (!isContractorLike()) return;
    var city = safe("cityFilter").value.trim().toLowerCase();
    var zip = safe("zipFilter").value.trim();
    var grid = safe("jobBoardGrid");
    var notice = safe("jobBoardNotice");
    var contractorLocation = locationFromCurrentUser();
    if (!hasServiceLocation(contractorLocation)) {
      if (notice) {
        notice.hidden = false;
        notice.innerHTML = 'Add your service location to see nearby jobs. <button type="button" onclick="showPage(\'contractor-apply\')">Update service location</button> <button type="button" onclick="useContractorCurrentLocation(this)">Use my location</button>';
      }
      grid.innerHTML = '<div class="card empty-state" style="grid-column:1/-1"><span class="material-symbols-rounded empty-illustration" aria-hidden="true">location_on</span><h2>Add your service location to see nearby jobs.</h2><p class="lead">JCM needs your real city, ZIP code, service radius, or allowed location to match nearby available work.</p></div>';
      return;
    }
    if (notice) notice.hidden = true;
    var justClaimed = Object.values(state.justClaimedJobs || {});
    var jobs = state.openJobs.concat(justClaimed.filter(function (job) {
      return !state.openJobs.some(function (openJob) { return openJob.id === job.id; });
    }));
    jobs = jobs.filter(function (job) {
      var cityOk = !city || String(job.city || "").toLowerCase().includes(city);
      var zipOk = !zip || String(job.zipCode || "").includes(zip);
      var locationOk = job.claimedBy === (state.authUser && state.authUser.uid) || jobMatchesContractorLocation(job);
      return cityOk && zipOk && locationOk;
    });
    if (!jobs.length) {
      grid.innerHTML = '<div class="card empty-state" style="grid-column:1/-1"><span class="material-symbols-rounded empty-illustration" aria-hidden="true">work</span><h2>No available jobs near you yet.</h2><p class="lead">JCM will show real available jobs here when they match your service location.</p></div>';
      return;
    }
    grid.innerHTML = jobs.map(renderJobCard).join("");
  };

  window.renderJobCard = function (job) {
    var claimedByYou = job.claimedBy && state.authUser && job.claimedBy === state.authUser.uid;
    var status = claimedByYou ? "claimed" : job.status;
    var details = String(job.details || "");
    var preview = details.length > 140 ? escapeHtml(details.slice(0, 140)) + '<span id="details-more-' + job.id + '" hidden>' + escapeHtml(details.slice(140)) + '</span><button class="read-more" type="button" onclick="expandDetails(\'' + job.id + '\')">...read more</button>' : escapeHtml(details);
    var photos = (job.photoURLs || []).slice(0, 3).map(function (url, index) {
      return '<button class="lightbox-trigger" type="button" onclick=\'openLightbox(' + JSON.stringify(job.photoURLs || []) + ', ' + index + ')\'><img class="photo-thumb" src="' + escapeHtml(url) + '" alt="Job photo ' + (index + 1) + '"></button>';
    }).join("");
    var privateInfo = claimedByYou ? '<div class="notice"><strong>Accepted Job</strong><br>Open the accepted request details to reveal private information when the workflow allows it. Each reveal is logged.</div>' : "";
    var action = claimedByYou
      ? '<span class="status-badge status-claimed" style="position:static">Accepted Job</span>'
      : contractorNeedsPaymentSetup()
        ? '<button class="btn btn-primary full" type="button" onclick="showPage(\'payment\'); toast(\'Set up payments before submitting quotes.\', \'error\')">Set Up Payments</button>'
        : '<button class="btn btn-primary full" type="button" onclick="openClaimModal(\'' + job.id + '\')">Submit Quote / Interest</button>';
    var place = [job.city || "", job.zipCode || ""].filter(Boolean).join(" ");
    return '<article class="card job-card">' +
      statusBadge(status) +
      '<h3>' + escapeHtml(job.serviceType || job.title || "Outdoor Work") + '</h3>' +
      '<p><strong>' + escapeHtml(job.title || "") + '</strong></p>' +
      '<div class="job-meta">' +
      '<span>' + escapeHtml(place || "Location not provided") + '</span>' +
      '<span>' + escapeHtml(job.propertySize || "") + '</span>' +
      '<span>' + escapeHtml(job.budget || "") + '</span>' +
      '<span>' + escapeHtml(job.frequency || "") + '</span>' +
      '<span>Preferred: ' + escapeHtml(formatDate(job.preferredDate)) + '</span>' +
      '</div><p>' + preview + '</p><div class="photo-strip">' + photos + '</div>' + privateInfo + action + '</article>';
  };

  window.renderContractorApplicationState = function () {
    var statusCard = safe("contractorStatusCard");
    var panel = safe("contractorFormPanel");
    if (!state.currentUser) {
      statusCard.hidden = true;
      panel.hidden = false;
      return;
    }
    var status = state.currentUser.contractorStatus;
    if (isContractorLike()) {
      statusCard.hidden = false;
      panel.hidden = true;
      statusCard.innerHTML = '<h2>You are approved.</h2><p class="lead">You can view Available Jobs and Payment Setup. Stripe Test Mode setup must be complete before quoting paid jobs.</p><div class="hero-actions"><button class="btn btn-primary" type="button" onclick="showPage(\'job-board\')">Available Jobs</button><button class="btn btn-secondary" type="button" onclick="showPage(\'payment\')">Payment Setup</button></div>';
    } else if (status === "pending") {
      statusCard.hidden = false;
      panel.hidden = true;
      statusCard.innerHTML = '<h2>Your contractor application is still pending.</h2><p class="lead">JCM will contact you at ' + escapeHtml(userEmailOrPhone(state.currentUser)) + ' once a decision has been made.</p>';
    } else if (status === "rejected") {
      statusCard.hidden = false;
      panel.hidden = true;
      statusCard.innerHTML = '<h2>Your contractor application was not approved.</h2><p class="lead">Contact support if you believe more information would help JCM review your account again.</p><div class="hero-actions"><button class="btn btn-secondary" type="button" onclick="showPage(\'support\')">Contact Support</button></div>';
    } else {
      statusCard.hidden = true;
      panel.hidden = false;
    }
  };

  async function getCurrentPosition() {
    if (!navigator.geolocation) throw new Error("Location permission is not available in this browser.");
    return new Promise(function (resolve, reject) {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 });
    });
  }

  window.useJobCurrentLocation = async function (button) {
    setButtonLoading(button, true);
    try {
      var position = await getCurrentPosition();
      state.jobLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy || null
      };
      safe("jobLocationStatus").textContent = "Location added from this device. Your exact address stays private until you accept a contractor and post-acceptance access is allowed.";
      toast("Location added to this service request.", "success");
    } catch (error) {
      toast(error.message || "Location permission was not allowed.", "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.useContractorCurrentLocation = async function (button) {
    setButtonLoading(button, true);
    try {
      var position = await getCurrentPosition();
      state.contractorLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy || null
      };
      if (safe("contractorLocationStatus")) safe("contractorLocationStatus").textContent = "Location added from this device.";
      if (state.authUser) {
        await db.collection("users").doc(state.authUser.uid).set({
          latitude: state.contractorLocation.latitude,
          longitude: state.contractorLocation.longitude,
          locationAccuracyMeters: state.contractorLocation.accuracyMeters,
          locationUpdatedAt: serverTimestamp()
        }, { merge: true });
      }
      toast("Service location updated.", "success");
      renderJobBoard();
    } catch (error) {
      toast(error.message || "Location permission was not allowed.", "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.submitJob = async function (event) {
    event.preventDefault();
    if (window.marketplaceCreateJobFromForm) return window.marketplaceCreateJobFromForm(event);
    var result = safe("jobRequestResult");
    result.hidden = true;
    result.classList.remove("error");
    if (!state.authUser) return openSignInModal();
    if (isSuspended()) {
      toast("Your account is suspended and cannot submit service requests.", "error");
      return;
    }
    var formValid = validateForm(safe("jobRequestForm"));
    var photosValid = validatePhotos();
    if (!formValid || !photosValid) {
      toast("Please fix the highlighted fields.", "error");
      return;
    }
    var button = safe("submitJobBtn");
    button.disabled = true;
    button.classList.add("posting-loading");
    button.textContent = "Submitting...";
    try {
      await state.authUser.reload();
      state.authUser = auth.currentUser;
      var urls = await uploadJobPhotos();
      var docRef = db.collection("jobs").doc();
      var verified = !state.authUser.email || Boolean(state.authUser.emailVerified);
      var latitude = state.jobLocation ? state.jobLocation.latitude : null;
      var longitude = state.jobLocation ? state.jobLocation.longitude : null;
      var batch = db.batch();
      batch.set(docRef, {
        id: docRef.id,
        postedBy: state.authUser.uid,
        title: formValue("jobTitle"),
        serviceType: formValue("serviceType"),
        city: formValue("job-city"),
        zipCode: formValue("job-zip"),
        latitude: latitude,
        longitude: longitude,
        locationAccuracyMeters: state.jobLocation ? state.jobLocation.accuracyMeters : null,
        propertySize: formValue("propertySize"),
        details: formValue("jobDetails"),
        budget: formValue("budget"),
        frequency: formValue("frequency"),
        preferredDate: formValue("preferredDate") || null,
        photoURLs: urls,
        status: verified ? "open" : "pending_verification",
        claimedBy: null,
        claimedByName: null,
        claimedAt: null,
        privateDetailsReleased: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      batch.set(docRef.collection("private").doc("customer"), {
        posterName: state.currentUser.displayName || state.authUser.displayName || "",
        posterEmail: state.currentUser.email || state.authUser.email || "",
        posterPhone: formValue("jobPhone"),
        fullAddress: formValue("fullAddress"),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      await batch.commit();
      safe("jobRequestForm").reset();
      state.selectedPhotos = [];
      state.jobLocation = null;
      if (safe("jobLocationStatus")) safe("jobLocationStatus").textContent = "Optional. If you allow location access, nearby contractors can match by distance. If not, JCM uses your real city and ZIP code.";
      renderPhotoPreviews();
      result.hidden = false;
      result.classList.remove("error");
      result.innerHTML = verified
        ? "Your service request is live. Approved contractors in your area can now see it as an available job."
        : 'Service request saved. Check your inbox at ' + escapeHtml(state.authUser.email) + ' and click the verification link to make it visible to contractors. <button class="btn btn-secondary" type="button" onclick="resendVerificationFromResult(this)">Resend verification email</button>';
      toast(verified ? "Your service request is live." : "Your service request has been saved. Verify your email to make it visible.", "success");
    } catch (error) {
      result.hidden = false;
      result.classList.add("error");
      result.textContent = "Something went wrong. Please try again. If the problem continues, contact support.";
      toast(dataMessage(error), "error");
    } finally {
      button.disabled = false;
      button.classList.remove("posting-loading");
      button.textContent = "Submit Request";
    }
  };

  window.submitContractorApplication = async function (event) {
    event.preventDefault();
    if (window.marketplaceSubmitApplicationFromForm) return window.marketplaceSubmitApplicationFromForm(event);
    if (!state.authUser) return openSignInModal();
    if (isSuspended()) {
      toast("Your account is suspended and cannot submit a contractor application.", "error");
      return;
    }
    var formValid = validateForm(safe("contractorForm"));
    var skillsValid = validateCheckboxGroup("skillsGroup", "skills");
    var availabilityValid = validateCheckboxGroup("availabilityGroup", "availability");
    if (!formValid || !skillsValid || !availabilityValid) {
      toast("Please fix the highlighted fields.", "error");
      return;
    }
    var button = safe("submitApplicationBtn");
    setButtonLoading(button, true);
    try {
      var location = state.contractorLocation || {};
      var serviceRadius = formValue("serviceRadius");
      var serviceRadiusMiles = parseRadiusMiles(serviceRadius);
      var docRef = db.collection("contractorApplications").doc();
      var application = {
        id: docRef.id,
        uid: state.authUser.uid,
        name: formValue("contractorName"),
        email: formValue("contractorEmail"),
        phone: formValue("contractorPhone"),
        city: formValue("contractorCity"),
        zipCode: formValue("contractorZip"),
        serviceRadius: serviceRadius,
        serviceRadiusMiles: serviceRadiusMiles,
        latitude: numberOrNull(location.latitude),
        longitude: numberOrNull(location.longitude),
        skills: selectedValues("skills"),
        equipment: formValue("equipment"),
        experience: formValue("experience"),
        availability: selectedValues("availability").join(", "),
        whyJCM: formValue("whyJCM"),
        status: "pending",
        submittedAt: serverTimestamp(),
        reviewedAt: null,
        reviewedBy: null
      };
      await docRef.set(application);
      await db.collection("users").doc(state.authUser.uid).set({
        contractorStatus: "pending",
        city: application.city,
        zipCode: application.zipCode,
        serviceRadius: application.serviceRadius,
        serviceRadiusMiles: application.serviceRadiusMiles,
        latitude: application.latitude,
        longitude: application.longitude,
        updatedAt: serverTimestamp()
      }, { merge: true });
      state.currentUser.contractorStatus = "pending";
      safe("contractorForm").reset();
      prefillUserForms();
      renderContractorApplicationState();
      toast("Application submitted. JCM will review it.", "success");
    } catch (error) {
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  async function authFetch(url, options) {
    if (!state.authUser) throw new Error("Sign in first.");
    var token = await state.authUser.getIdToken();
    var request = options || {};
    request.headers = Object.assign({
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    }, request.headers || {});
    var response = await fetch(url, request);
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var error = new Error(data.error || data.message || "Request failed.");
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }
  window.jcmAuthFetch = authFetch;

  window.loadPaymentSummary = async function () {
    if (!state.authUser || !isContractorLike()) {
      renderPaymentPage();
      return;
    }
    if (state.paymentLoading) return;
    state.paymentLoading = true;
    renderPaymentPage();
    try {
      var data = await authFetch("/api/stripe/connect?action=payment-summary", { method: "GET" });
      state.paymentSummary = data;
      if (data.profile) state.currentUser = { ...state.currentUser, ...data.profile };
      renderPaymentPage();
      renderJobBoard();
    } catch (error) {
      state.paymentSummary = { error: error.message || "Payment status is not available yet." };
      renderPaymentPage();
    } finally {
      state.paymentLoading = false;
    }
  };

  window.startStripeOnboarding = async function (button) {
    setButtonLoading(button, true);
    try {
      var data = await authFetch("/api/stripe/connect?action=onboarding-link", { method: "POST", body: JSON.stringify({}) });
      if (!data.url) throw new Error("Stripe did not return an onboarding link.");
      window.location.href = data.url;
    } catch (error) {
      toast(error.message || "Stripe setup could not start.", "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.refreshStripeStatus = async function (button) {
    setButtonLoading(button, true);
    try {
      var data = await authFetch("/api/stripe/connect?action=refresh-account", { method: "POST", body: JSON.stringify({}) });
      state.currentUser = { ...state.currentUser, ...(data.profile || {}) };
      await loadPaymentSummary();
      toast("Stripe status refreshed.", "success");
    } catch (error) {
      toast(error.message || "Stripe status could not be refreshed.", "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.openStripeDashboard = async function (button) {
    setLoading(button, true);
    try {
      var data = await authFetch("/api/stripe/connect?action=dashboard-link", { method: "POST", body: JSON.stringify({}) });
      if (!data.url) throw new Error("Stripe did not return a dashboard link.");
      window.location.assign(data.url);
    } catch (error) {
      toast(error.message || "Stripe Dashboard could not open.", "error");
      setLoading(button, false);
    }
  };

  window.renderPaymentPage = function () {
    if (!safe("page-payment")) return;
    var signedIn = Boolean(state.authUser && state.currentUser);
    safe("paymentSignedOut").hidden = signedIn;
    var contractor = signedIn && isContractorLike();
    safe("paymentLocked").hidden = !signedIn || contractor;
    safe("paymentContent").hidden = !signedIn || !contractor;
    if (!signedIn || !contractor) {
      if (signedIn && safe("paymentLockedMessage")) {
        var status = state.currentUser.contractorStatus;
        safe("paymentLockedMessage").textContent = status === "pending"
          ? "Your contractor application is still pending."
          : status === "rejected"
            ? "Your contractor application was not approved."
            : "Your contractor application must be approved before Stripe setup is available.";
      }
      return;
    }
    var summary = state.paymentSummary || {};
    var canPayout = Boolean(state.currentUser.stripePayoutsEnabled || summary.stripePayoutsEnabled);
    var onboardingComplete = Boolean(state.currentUser.stripeOnboardingComplete || summary.stripeOnboardingComplete);
    var hasStripeAccount = Boolean(state.currentUser.stripeAccountId || summary.stripeAccountId);
    var badge = safe("stripeStatusBadge");
    badge.textContent = onboardingComplete && canPayout ? "ready" : "incomplete";
    badge.className = "status-badge " + (onboardingComplete && canPayout ? "status-open" : "status-pending");
    safe("stripeStatusSummary").textContent = onboardingComplete && canPayout
      ? "Stripe setup is complete. You can receive payouts."
      : "Complete Stripe Test Mode payment setup before quoting paid jobs.";
    safe("payoutsStatus").textContent = canPayout ? "Yes" : "No";
    safe("onboardingStatus").textContent = onboardingComplete ? "Complete" : "Incomplete";
    safe("stripeLastSync").textContent = state.currentUser.lastStripeStatusSync && state.currentUser.lastStripeStatusSync.toDate
      ? formatDate(state.currentUser.lastStripeStatusSync)
      : (summary.lastStripeStatusSync ? formatDate(summary.lastStripeStatusSync) : "Not synced");
    safe("stripeDashboardBtn").hidden = !hasStripeAccount;
    var issue = summary.error || state.currentUser.stripeDisabledReason || "";
    safe("paymentIssue").hidden = !issue;
    safe("paymentIssue").textContent = issue;
    var due = summary.stripeRequirementsCurrentlyDue || state.currentUser.stripeRequirementsCurrentlyDue || [];
    safe("requirementsList").innerHTML = due.length
      ? due.map(function (item) { return '<div class="compact-card"><strong>Stripe requirement</strong><p>' + escapeHtml(item) + '</p></div>'; }).join("")
      : '<div class="compact-card"><p>No open Stripe requirements reported.</p></div>';
    var totals = summary.totals || {};
    safe("paidToday").textContent = formatMoney(totals.paidToday || 0, totals.currency || "usd");
    safe("paidWeek").textContent = formatMoney(totals.paidWeek || 0, totals.currency || "usd");
    safe("paidMonth").textContent = formatMoney(totals.paidMonth || 0, totals.currency || "usd");
    safe("pendingPayout").textContent = formatMoney(totals.pendingPayout || 0, totals.currency || "usd");
    var history = summary.history || [];
    safe("paymentHistory").innerHTML = history.length
      ? history.map(function (item) {
        return '<article class="compact-card"><div class="compact-card-header"><div><h3>' + escapeHtml(item.description || item.type || "Payment") + '</h3><p>' + escapeHtml(formatPaymentDate(item.created)) + '</p></div><strong>' + escapeHtml(formatMoney(item.amount || 0, item.currency || "usd")) + '</strong></div><p>Status: ' + escapeHtml(item.status || "completed") + '</p></article>';
      }).join("")
      : '<div class="card"><p>No payment history yet.</p></div>';
  };

  window.openClaimModal = function (jobId) {
    if (!state.authUser) return openSignInModal();
    if (!isContractorLike()) {
      toast("Only approved contractors can submit quotes.", "error");
      return;
    }
    if (isSuspended()) {
      toast("Your account is suspended and cannot submit quotes.", "error");
      return;
    }
    if (contractorNeedsPaymentSetup()) {
      toast("Set up payments before submitting quotes.", "error");
      showPage("payment");
      return;
    }
    state.pendingClaimId = jobId;
    safe("claimModal").classList.add("active");
    document.body.classList.add("modal-open");
  };

  window.confirmClaimJob = function (event) {
    if (typeof window.submitMarketplaceQuote === "function") return window.submitMarketplaceQuote(event || new Event("submit"));
    toast("The quote form is still loading. Refresh and try again.", "error");
  };

  window.attachJobBoardListener = function () {
    if (state.boardUnsubscribe) {
      try { state.boardUnsubscribe(); } catch (error) { return; }
      state.unsubscribes = state.unsubscribes.filter(function (unsub) { return unsub !== state.boardUnsubscribe; });
      state.boardUnsubscribe = null;
    }
    if (!isContractorLike()) {
      state.openJobs = [];
      renderJobBoard();
      return;
    }
    var unsub = db.collection("jobs")
      .where("status", "==", "open")
      .orderBy("createdAt", "desc")
      .onSnapshot(function (snapshot) {
        state.openJobs = snapshot.docs.map(function (doc) { return { id: doc.id, ...doc.data() }; });
        renderJobBoard();
      }, function (error) {
        toast(dataMessage(error), "error");
      });
    state.boardUnsubscribe = unsub;
    state.unsubscribes.push(unsub);
  };

  window.attachUserListeners = function () {
    if (!state.authUser) return;
    var profileUnsub = db.collection("users").doc(state.authUser.uid)
      .onSnapshot(function (snapshot) {
        if (!snapshot.exists) return;
        var previousRole = state.currentUser ? state.currentUser.role : null;
        state.currentUser = { ...state.currentUser, ...snapshot.data(), uid: state.authUser.uid };
        syncCurrentUserAliases();
        renderAuthUI();
        renderPageGuards();
        prefillUserForms();
        if (previousRole !== state.currentUser.role) attachJobBoardListener();
        if (isContractorLike() && state.activePage === "payment") loadPaymentSummary();
      }, function (error) {
        toast(dataMessage(error), "error");
      });
    state.unsubscribes.push(profileUnsub);
    var postedUnsub = db.collection("jobs")
      .where("postedBy", "==", state.authUser.uid)
      .onSnapshot(function (snapshot) {
        state.myPostedJobs = snapshot.docs.map(function (doc) { return { id: doc.id, ...doc.data() }; })
          .sort(function (a, b) { return timestampMs(b.createdAt) - timestampMs(a.createdAt); });
        renderAccountPage();
      }, function (error) {
        toast(dataMessage(error), "error");
      });
    state.unsubscribes.push(postedUnsub);
    var claimedUnsub = db.collection("jobs")
      .where("claimedBy", "==", state.authUser.uid)
      .onSnapshot(async function (snapshot) {
        const jobs = await Promise.all(snapshot.docs.map(async function (doc) {
          const job = { id: doc.id, ...doc.data() };
          try {
            const customer = await doc.ref.collection("private").doc("customer").get();
            if (customer.exists) job.customerDetails = customer.data();
          } catch (error) {
            job.customerDetails = {};
          }
          return job;
        }));
        state.myClaimedJobs = jobs
          .sort(function (a, b) { return timestampMs(b.claimedAt || b.updatedAt) - timestampMs(a.claimedAt || a.updatedAt); });
        renderAccountPage();
      }, function (error) {
        toast(dataMessage(error), "error");
      });
    state.unsubscribes.push(claimedUnsub);
  };

  window.renderAccountPage = function () {
    var signedIn = Boolean(state.authUser && state.currentUser);
    safe("accountSignedOut").hidden = signedIn;
    safe("accountContent").hidden = !signedIn;
    if (!signedIn) return;
    safe("profilePhoto").src = state.currentUser.photoURL || "JCM_Leaf.png";
    safe("profilePhoto").alt = (state.currentUser.displayName || "User") + " profile photo";
    safe("profileName").textContent = state.currentUser.displayName || "JCM User";
    safe("profileEmail").textContent = userEmailOrPhone(state.currentUser);
    safe("profileRoleBadge").textContent = roleOf(state.currentUser);
    safe("profileRoleBadge").className = "status-badge " + (isContractorLike() ? "status-open" : "status-completed");
    var status = state.currentUser.contractorStatus;
    var action = safe("profileActions");
    action.innerHTML = "";
    if (isSuspended()) {
      safe("contractorStatusMessage").textContent = "Your account access is limited.";
    } else if (isContractorLike()) {
      safe("contractorStatusMessage").textContent = contractorNeedsPaymentSetup()
        ? "You are approved. Complete Stripe Test Mode payment setup before quoting paid jobs."
        : "You are approved. You can view nearby requests and submit quotes.";
      action.innerHTML = '<button class="btn btn-primary" type="button" onclick="showPage(\'job-board\')">Available Jobs</button><button class="btn btn-secondary" type="button" onclick="showPage(\'payment\')">Payment Setup</button>';
    } else if (status === "pending") {
      safe("contractorStatusMessage").textContent = "Your contractor application is still pending.";
    } else if (status === "rejected") {
      safe("contractorStatusMessage").textContent = "Your contractor application was not approved.";
      action.innerHTML = '<button class="btn btn-secondary" type="button" onclick="showPage(\'support\')">Contact Support</button>';
    } else {
      safe("contractorStatusMessage").textContent = "You are signed in as a buyer. Apply if you want contractor access.";
      action.innerHTML = '<button class="btn btn-secondary" type="button" onclick="showPage(\'contractor-apply\')">Apply to Become a Contractor</button>';
    }
    renderCompactJobs("myPostedJobs", state.myPostedJobs, false);
    safe("claimedJobsSection").hidden = !isContractorLike();
    renderCompactJobs("myClaimedJobs", state.myClaimedJobs, true);
  };

  window.renderCompactJobs = function (containerId, jobs, showPrivate) {
    var container = safe(containerId);
    if (!container) return;
    if (!jobs.length) {
      container.innerHTML = containerId === "myPostedJobs"
        ? '<div class="card"><p>No submitted service requests yet.</p></div>'
        : '<div class="card"><p>No accepted jobs yet.</p></div>';
      return;
    }
    container.innerHTML = jobs.map(function (job) {
      var extra = showPrivate
        ? '<p>Open this accepted request to reveal private details when the workflow allows it. Each reveal is logged.</p>'
        : '<p>' + escapeHtml(job.details || "") + '</p>';
      return '<article class="compact-card" id="compact-' + job.id + '"><div class="compact-card-header"><div><h3>' + escapeHtml(job.title || "Untitled job") + '</h3><p>' + escapeHtml(formatDate(job.createdAt)) + '</p></div>' + statusBadge(job.status) + '</div><button class="read-more" type="button" onclick="toggleCompact(\'' + job.id + '\')">View Details</button><div class="details-block">' + extra + '</div></article>';
    }).join("");
  };

  window.initStaticContent = function () {
    installWorkflowDom();
    var select = safe("serviceType");
    select.innerHTML = '<option value="">Choose service type</option>' + serviceTypes.map(function (type) {
      return '<option>' + escapeHtml(type) + '</option>';
    }).join("");
    safe("skillsOptions").innerHTML = contractorSkills.map(function (skill) {
      return '<label><input type="checkbox" name="skills" value="' + escapeHtml(skill) + '"> ' + escapeHtml(skill) + '</label>';
    }).join("");
    safe("availabilityOptions").innerHTML = days.map(function (day) {
      return '<label><input type="checkbox" name="availability" value="' + escapeHtml(day) + '"> ' + escapeHtml(day) + '</label>';
    }).join("");
    var workflowFaqs = [
      ["How does a service request go live?", "A signed-in buyer submits a service request with photos. If the account uses a verified email or phone sign-in, the request can become open for approved contractors."],
      ["What can contractors see before acceptance?", "Contractors see public request details such as service type, city, ZIP code, property size, budget, frequency, preferred date, notes, and photos. Exact address and contact details stay private."],
      ["How do I become a contractor?", "Create an account with email or phone and submit the contractor application. JCM reviews your location, skills, equipment, experience, and availability before approving access."],
      ["Why is my address hidden?", "The Available Jobs page protects buyers. Full address and contact details unlock only for the contractor the buyer accepts, after acceptance and only when the workflow allows access."],
      ["Can I cancel a service request?", "Contact JCM through the support form with your request title and account contact information. An admin can reject or close the request from the dashboard."],
      ["What happens after I accept a contractor?", "A private job chat opens. The buyer and accepted contractor agree on final scope, price, and timing, then the buyer pays in Stripe Test Mode before scheduling."],
      ["Can contractors choose any job?", "Approved contractors with Stripe Test Mode setup and a service location can submit quotes for nearby open requests."],
      ["How do I contact JCM?", "Use the support form on this site or email help@jcm-landscaping.com for account, contractor, job, or payment questions."],
      ["Can JCM edit a service request?", "Admins can clean up unclear titles or details before or after a request becomes visible so the Jobs page stays useful."]
    ];
    safe("faqList").innerHTML = workflowFaqs.map(function (item, index) {
      return '<article class="faq-item"><button class="faq-question" type="button" onclick="toggleFaq(' + index + ')"><span>' + escapeHtml(item[0]) + '</span><span class="chevron" aria-hidden="true"></span></button><div class="faq-answer"><p>' + escapeHtml(item[1]) + '</p></div></article>';
    }).join("");
  };

  function setupDropdownBehavior() {
    document.querySelectorAll(".dropdown, .account-menu").forEach(function (menu) {
      if (menu.dataset.workflowDropdownReady === "true") return;
      menu.dataset.workflowDropdownReady = "true";
      var trigger = menu.querySelector("button");
      if (!trigger) return;
      menu.addEventListener("mouseleave", function () {
        if (!menu.classList.contains("keyboard-open")) {
          menu.classList.remove("open");
          if (menu.contains(document.activeElement)) document.activeElement.blur();
        }
      });
      trigger.addEventListener("keydown", function (event) {
        if (["Enter", " ", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          menu.classList.add("keyboard-open");
          var first = menu.querySelector(".dropdown-surface button, .dropdown-surface a");
          if (first) first.focus();
        }
        if (event.key === "Escape") {
          menu.classList.remove("keyboard-open", "open");
          trigger.focus();
        }
      });
      menu.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          menu.classList.remove("keyboard-open", "open");
          trigger.focus();
        }
      });
    });
    document.addEventListener("click", function (event) {
      if (!event.target.closest(".dropdown, .account-menu")) closeAccountDropdown();
    });
  }

  function wireWorkflowOverrides() {
    if (overrideEventsWired) return;
    overrideEventsWired = true;
    [["jobRequestForm", submitJob], ["contractorForm", submitContractorApplication]].forEach(function (item) {
      var form = safe(item[0]);
      if (!form) return;
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        item[1](event);
      }, true);
    });
    if (safe("cityFilter")) safe("cityFilter").addEventListener("input", renderJobBoard);
    if (safe("zipFilter")) safe("zipFilter").addEventListener("input", renderJobBoard);
    window.addEventListener("popstate", routeFromHash);
  }

  installWorkflowDom();
  setupDropdownBehavior();
  wireWorkflowOverrides();
  initStaticContent();
  renderAuthUI();
  renderPageGuards();
  if (state.authUser) {
    detachListeners();
    attachUserListeners();
    attachJobBoardListener();
    if (isContractorLike()) loadPaymentSummary();
  }
  setTimeout(routeFromHash, 150);
})();
