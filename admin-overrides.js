(function () {
  "use strict";

  var adminRecaptchaVerifier = null;
  var adminPhoneConfirmation = null;

  function safe(id) { return document.getElementById(id); }
  function roleOf(user) {
    var role = String((user && user.role) || "buyer").toLowerCase();
    return role === "user" ? "buyer" : role;
  }
  function isOwnerRole(user) { return roleOf(user) === "owner"; }
  function yesNo(value) { return value ? "Yes" : "No"; }
  function contactFor(user) { return user.email || user.phoneNumber || ""; }
  function stripeText(user) {
    if (!user || !user.stripeAccountId) return "Not started";
    if (user.stripeOnboardingComplete && user.stripePayoutsEnabled) return "Complete";
    if (user.stripeDetailsSubmitted) return "Needs Stripe action";
    return "Incomplete";
  }

  window.isAdmin = function () {
    return state.adminUser && ["owner", "admin"].includes(roleOf(state.adminUser));
  };

  window.isModeratorOrAdmin = function () {
    return state.adminUser && ["owner", "admin", "moderator"].includes(roleOf(state.adminUser));
  };

  window.dataMessage = function (error) {
    var text = String((error && (error.message || error.code)) || "");
    if (text.toLowerCase().includes("unauthorized-domain")) {
      return "This domain is not authorized in JCM authentication yet. Add it in JCM authentication authorized domains.";
    }
    if (text.toLowerCase().includes("auth/operation-not-allowed")) {
      return "Enable Email/Password and Phone providers in JCM authentication.";
    }
    if (text.toLowerCase().includes("offline") || text.toLowerCase().includes("unavailable")) {
      return "JCM could not reach JCM data services from this browser. Check your connection, refresh, or try again in a moment.";
    }
    return text || "Something went wrong. Please try again.";
  };

  function installAdminAuthDom() {
    var card = document.querySelector("#authScreen .auth-card");
    if (card) {
      card.innerHTML = [
        '<img src="JCM_Landscaping.png" alt="JCM Landscaping">',
        '<h1>Admin Dashboard</h1>',
        '<p>Sign in with an email account that has the admin, owner, or moderator role.</p>',
        '<div class="auth-tabs" role="tablist" aria-label="Admin sign in method">',
        '  <button class="auth-tab active" id="adminAuthEmailTab" type="button" onclick="showAdminAuthMode(\'email\')">Email</button>',
        '  <button class="auth-tab" id="adminAuthPhoneTab" type="button" title="Phone sign-in requires an SMS provider" disabled>Phone unavailable</button>',
        '</div>',
        '<div class="auth-panel" id="adminEmailAuthPanel">',
        '  <label for="adminAuthEmail">Email</label>',
        '  <input id="adminAuthEmail" type="email" autocomplete="email" placeholder="Admin email address">',
        '  <label for="adminAuthPassword">Password</label>',
        '  <input id="adminAuthPassword" type="password" autocomplete="current-password">',
        '  <button class="btn btn-primary full" id="adminEmailSignInBtn" type="button" onclick="adminSignInWithEmail()">Sign In</button>',
        '</div>',
        '<div class="auth-panel" id="adminPhoneAuthPanel" hidden>',
        '  <label for="adminAuthPhone">Phone Number</label>',
        '  <input id="adminAuthPhone" type="tel" autocomplete="tel" placeholder="Phone number with country code">',
        '  <button class="btn btn-primary full" id="adminPhoneSendBtn" type="button" onclick="adminSendPhoneCode()">Send Code</button>',
        '  <label for="adminAuthCode">Verification Code</label>',
        '  <input id="adminAuthCode" type="text" inputmode="numeric" autocomplete="one-time-code">',
        '  <button class="btn btn-secondary full" id="adminPhoneVerifyBtn" type="button" onclick="adminVerifyPhoneCode()">Verify and Continue</button>',
        '</div>',
        '<div id="admin-recaptcha-container"></div>'
      ].join("");
    }
    var roleSelect = safe("manageRole");
    if (roleSelect) {
      roleSelect.innerHTML = [
        '<option>buyer</option>',
        '<option>contractor</option>',
        '<option>suspended</option>'
      ].join("");
    }
  }

  window.showAdminAuthMode = function (mode) {
    var emailMode = mode !== "phone";
    if (safe("adminEmailAuthPanel")) safe("adminEmailAuthPanel").hidden = !emailMode;
    if (safe("adminPhoneAuthPanel")) safe("adminPhoneAuthPanel").hidden = emailMode;
    if (safe("adminAuthEmailTab")) safe("adminAuthEmailTab").classList.toggle("active", emailMode);
    if (safe("adminAuthPhoneTab")) safe("adminAuthPhoneTab").classList.toggle("active", !emailMode);
  };

  window.legacyProviderSignIn = function () {
    installAdminAuthDom();
    toast("Use email sign-in for JCM staff accounts.", "info");
  };

  window.adminSignIn = function () {
    installAdminAuthDom();
  };

  window.adminSignInWithEmail = async function () {
    var button = safe("adminEmailSignInBtn");
    setButtonLoading(button, true);
    try {
      var email = safe("adminAuthEmail").value.trim();
      var password = safe("adminAuthPassword").value;
      if (!email || !password) throw new Error("Enter your email address and password.");
      await auth.signInWithEmailAndPassword(email, password);
    } catch (error) {
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  function ensureAdminRecaptcha() {
    if (adminRecaptchaVerifier) return adminRecaptchaVerifier;
    adminRecaptchaVerifier = new githubData.auth.RecaptchaVerifier("admin-recaptcha-container", {
      size: "invisible",
      callback: function () {}
    });
    return adminRecaptchaVerifier;
  }

  window.adminSendPhoneCode = async function () {
    var button = safe("adminPhoneSendBtn");
    setButtonLoading(button, true);
    try {
      var phone = safe("adminAuthPhone").value.trim();
      if (!phone) throw new Error("Enter a phone number with country code, such as +1.");
      adminPhoneConfirmation = await auth.signInWithPhoneNumber(phone, ensureAdminRecaptcha());
      toast("Verification code sent.", "success");
    } catch (error) {
      if (adminRecaptchaVerifier && adminRecaptchaVerifier.clear) {
        adminRecaptchaVerifier.clear();
        adminRecaptchaVerifier = null;
      }
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.adminVerifyPhoneCode = async function () {
    var button = safe("adminPhoneVerifyBtn");
    setButtonLoading(button, true);
    try {
      if (!adminPhoneConfirmation) throw new Error("Send a verification code first.");
      var code = safe("adminAuthCode").value.trim();
      if (!code) throw new Error("Enter the verification code.");
      await adminPhoneConfirmation.confirm(code);
    } catch (error) {
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

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

  window.renderOverview = function () {
    safe("overviewStats").innerHTML = [
      ["Pending Service Requests", countJobs("pending_verification")],
      ["Open Jobs", countJobs("open")],
      ["Pending Contractor Applications", state.applications.filter(function (app) { return app.status === "pending"; }).length],
      ["Open Support Tickets", state.tickets.filter(function (ticket) { return ticket.status === "open"; }).length]
    ].map(function (stat) {
      return '<article class="card"><div class="stat-value">' + stat[1] + '</div><p>' + escapeHtml(stat[0]) + '</p></article>';
    }).join("");
    var activity = [];
    state.jobs.forEach(function (job) {
      if (job.createdAt) activity.push([timestampMs(job.createdAt), "Service request submitted: " + (job.title || "Untitled request")]);
      if (job.claimedAt) activity.push([timestampMs(job.claimedAt), "Job claimed: " + (job.title || "Untitled job") + " by " + (job.claimedByName || "contractor")]);
    });
    state.applications.forEach(function (app) {
      if (app.submittedAt) activity.push([timestampMs(app.submittedAt), "Application submitted: " + (app.name || app.email || "contractor")]);
    });
    state.tickets.forEach(function (ticket) {
      if (ticket.createdAt) activity.push([timestampMs(ticket.createdAt), "Support ticket opened: " + (ticket.topic || "Support")]);
    });
    activity.sort(function (a, b) { return b[0] - a[0]; });
    safe("recentActivity").innerHTML = activity.slice(0, 10).map(function (item) {
      return '<div class="activity-item"><strong>' + escapeHtml(item[1]) + '</strong><p>' + escapeHtml(formatDate(item[0])) + '</p></div>';
    }).join("") || "<p>No activity yet.</p>";
  };

  window.attachListeners = function () {
    var jobsUnsub = db.collection("jobs").onSnapshot(async function (snapshot) {
      var jobs = await Promise.all(snapshot.docs.map(async function (doc) {
        var job = { id: doc.id, ...doc.data() };
        if (isAdmin()) {
          try {
            var customer = await doc.ref.collection("private").doc("customer").get();
            if (customer.exists) {
              var data = customer.data();
              job.posterName = job.posterName || data.posterName || "";
              job.posterEmail = job.posterEmail || data.posterEmail || "";
              job.posterPhone = job.posterPhone || data.posterPhone || "";
              job.fullAddress = job.fullAddress || data.fullAddress || "";
            }
          } catch (error) {
            return job;
          }
        }
        return job;
      }));
      state.jobs = jobs.sort(function (a, b) { return timestampMs(b.createdAt) - timestampMs(a.createdAt); });
      renderAll();
    }, function (error) { toast(dataMessage(error), "error"); });

    var appsUnsub = db.collection("contractorApplications").onSnapshot(function (snapshot) {
      state.applications = snapshot.docs.map(function (doc) { return { id: doc.id, ...doc.data() }; })
        .sort(function (a, b) { return timestampMs(b.submittedAt) - timestampMs(a.submittedAt); });
      renderAll();
    }, function (error) { toast(dataMessage(error), "error"); });

    var supportUnsub = db.collection("supportTickets").onSnapshot(function (snapshot) {
      state.tickets = snapshot.docs.map(function (doc) { return { id: doc.id, ...doc.data() }; })
        .sort(function (a, b) { return timestampMs(b.createdAt) - timestampMs(a.createdAt); });
      renderAll();
    }, function (error) { toast(dataMessage(error), "error"); });

    state.unsubscribes.push(jobsUnsub, appsUnsub, supportUnsub);

    if (isAdmin()) {
      var usersUnsub = db.collection("users").onSnapshot(function (snapshot) {
        state.users = snapshot.docs.map(function (doc) { return { uid: doc.id, ...doc.data() }; })
          .sort(function (a, b) { return String(a.displayName || a.email || a.phoneNumber || "").localeCompare(String(b.displayName || b.email || b.phoneNumber || "")); });
        renderAll();
      }, function (error) { toast(dataMessage(error), "error"); });
      state.unsubscribes.push(usersUnsub);
    }
  };

  window.renderJobItem = function (job) {
    var contact = isAdmin()
      ? '<span><strong>Email:</strong> ' + escapeHtml(job.posterEmail || "") + '</span><span><strong>Phone:</strong> ' + escapeHtml(job.posterPhone || "") + '</span><span><strong>Address:</strong> ' + escapeHtml(job.fullAddress || "Private details stored separately") + '</span>'
      : '<span><strong>Contact:</strong> Hidden from moderators</span><span><strong>Address:</strong> Hidden from moderators</span>';
    var photos = (job.photoURLs || []).map(function (url, index) {
      return '<button class="photo-button" type="button" onclick=\'openLightbox(' + JSON.stringify(job.photoURLs || []) + ', ' + index + ')\'><img class="photo-thumb" src="' + escapeHtml(url) + '" alt="Job photo ' + (index + 1) + '"></button>';
    }).join("");
    var edit = isAdmin() ? renderJobEdit(job) : "";
    return '<article class="card" id="job-' + job.id + '"><div class="item-header"><div><h3>' + escapeHtml(job.title || "Untitled service request") + '</h3><p>' + escapeHtml(job.posterName || "Buyer details private") + '</p></div>' + statusBadge(job.status) + '</div><div class="item-meta">' + contact + '<span><strong>City / ZIP:</strong> ' + escapeHtml(job.city || "") + ' ' + escapeHtml(job.zipCode || "") + '</span><span><strong>Coordinates:</strong> ' + escapeHtml(job.latitude != null && job.longitude != null ? job.latitude + ", " + job.longitude : "Not provided") + '</span><span><strong>Service:</strong> ' + escapeHtml(job.serviceType || "") + '</span><span><strong>Claimed:</strong> ' + escapeHtml(job.claimedBy ? "Yes" : "No") + '</span><span><strong>Claimed By:</strong> ' + escapeHtml(job.claimedByName || job.claimedBy || "") + '</span><span><strong>Posted:</strong> ' + escapeHtml(formatDate(job.createdAt)) + '</span></div><p style="margin-top:12px">' + escapeHtml(job.details || "") + '</p><div class="photo-strip">' + photos + '</div><div class="actions"><button class="btn btn-danger" type="button" onclick="rejectJob(\'' + job.id + '\', this)">Remove / Reject</button><button class="btn btn-secondary" type="button" onclick="completeJob(\'' + job.id + '\', this)">Mark Complete</button>' + (isAdmin() ? '<button class="btn btn-secondary" type="button" onclick="toggleJobEdit(\'' + job.id + '\')">Edit</button>' : "") + '</div>' + edit + '</article>';
  };

  window.renderApplications = function () {
    var apps = state.applications.filter(function (app) { return state.applicationFilter === "all" || app.status === state.applicationFilter; });
    if (!apps.length) {
      safe("applicationsList").innerHTML = '<div class="card"><p>No applications match this filter.</p></div>';
      return;
    }
    safe("applicationsList").innerHTML = apps.map(function (app) {
      var user = state.users.find(function (item) { return item.uid === app.uid; }) || {};
      return '<article class="card"><div class="item-header"><div><h3>' + escapeHtml(app.name || "Unnamed applicant") + '</h3><p>' + escapeHtml(app.email || app.phone || "") + '</p></div>' + statusBadge(app.status) + '</div><div class="item-meta"><span><strong>Phone:</strong> ' + escapeHtml(app.phone || "") + '</span><span><strong>City / ZIP:</strong> ' + escapeHtml(app.city || "") + ' ' + escapeHtml(app.zipCode || "") + '</span><span><strong>Radius:</strong> ' + escapeHtml(app.serviceRadius || "") + '</span><span><strong>Coordinates:</strong> ' + escapeHtml(app.latitude != null && app.longitude != null ? app.latitude + ", " + app.longitude : "Not provided") + '</span><span><strong>Stripe setup:</strong> ' + escapeHtml(stripeText(user)) + '</span><span><strong>Can receive payouts:</strong> ' + escapeHtml(yesNo(user.stripePayoutsEnabled)) + '</span><span><strong>Submitted:</strong> ' + escapeHtml(formatDate(app.submittedAt)) + '</span></div><div class="pill-row">' + (app.skills || []).map(function (skill) { return '<span class="pill">' + escapeHtml(skill) + '</span>'; }).join("") + '</div><p style="margin-top:12px"><strong>Equipment:</strong> ' + escapeHtml(app.equipment || "") + '</p><p style="margin-top:8px"><strong>Why JCM:</strong> ' + escapeHtml(app.whyJCM || "") + '</p><div class="actions"><button class="btn btn-primary" type="button" onclick="approveApplication(\'' + app.id + '\', \'' + app.uid + '\', this)">Approve</button><button class="btn btn-danger" type="button" onclick="rejectApplication(\'' + app.id + '\', \'' + app.uid + '\', this)">Reject</button></div></article>';
    }).join("");
  };

  window.approveApplication = async function (id, uid, button) {
    setButtonLoading(button, true);
    try {
      var app = state.applications.find(function (item) { return item.id === id; }) || {};
      await db.batch()
        .update(db.collection("contractorApplications").doc(id), {
          status: "approved",
          reviewedAt: serverTimestamp(),
          reviewedBy: state.authUser.uid
        })
        .set(db.collection("users").doc(uid), {
          role: "contractor",
          contractorStatus: "approved",
          city: app.city || "",
          zipCode: app.zipCode || "",
          serviceRadius: app.serviceRadius || "",
          serviceRadiusMiles: app.serviceRadiusMiles || null,
          latitude: app.latitude == null ? null : app.latitude,
          longitude: app.longitude == null ? null : app.longitude,
          stripeOnboardingComplete: false,
          stripeChargesEnabled: false,
          stripePayoutsEnabled: false,
          updatedAt: serverTimestamp()
        }, { merge: true })
        .commit();
      toast("Contractor approved.", "success");
    } catch (error) {
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.renderUsers = function () {
    if (!isAdmin()) return;
    var term = (safe("userSearch") ? safe("userSearch").value : "").trim().toLowerCase();
    var users = state.users.filter(function (user) {
      var haystack = (user.displayName || "") + " " + (user.email || "") + " " + (user.phoneNumber || "");
      return !term || haystack.toLowerCase().includes(term);
    });
    if (!users.length) {
      safe("usersTableWrap").innerHTML = '<div class="card"><p>No users match this search.</p></div>';
      return;
    }
    safe("usersTableWrap").innerHTML = '<table><thead><tr><th>Photo</th><th>Name</th><th>Contact</th><th>Role</th><th>Contractor Status</th><th>Stripe Setup</th><th>Payouts</th><th>Service Area</th><th>Manage</th></tr></thead><tbody>' + users.map(function (user) {
      var area = [user.city || "", user.zipCode || "", user.serviceRadius || ""].filter(Boolean).join(" ");
      var staff = ["owner", "admin", "moderator"].includes(roleOf(user));
      var manage = staff
        ? '<span class="hint">Edit config/roles.json</span>'
        : '<button class="btn btn-secondary" type="button" onclick="openManageUser(\'' + user.uid + '\')">Manage</button>';
      return '<tr><td><img class="user-photo" src="' + escapeHtml(user.photoURL || "JCM_Leaf.png") + '" alt=""></td><td>' + escapeHtml(user.displayName || "") + (user.suspended ? " (Suspended)" : "") + '</td><td>' + escapeHtml(contactFor(user)) + '</td><td>' + escapeHtml(roleOf(user)) + '</td><td>' + escapeHtml(user.contractorStatus || "none") + '</td><td>' + escapeHtml(stripeText(user)) + '</td><td>' + escapeHtml(yesNo(user.stripePayoutsEnabled)) + '</td><td>' + escapeHtml(area || "Not provided") + '</td><td>' + manage + '</td></tr>';
    }).join("") + '</tbody></table>';
  };

  window.openManageUser = function (uid) {
    if (!isAdmin()) return;
    var user = state.users.find(function (item) { return item.uid === uid; });
    if (!user) return;
    if (["owner", "admin", "moderator"].includes(roleOf(user))) {
      toast("Edit config/roles.json in the private GitHub data repository to change staff access.", "info");
      return;
    }
    state.managedUserId = uid;
    safe("manageUserProfile").innerHTML = '<p><strong>' + escapeHtml(user.displayName || "Unnamed user") + '</strong></p><p>' + escapeHtml(contactFor(user)) + '</p><p>UID: ' + escapeHtml(uid) + '</p><p>Stripe setup: ' + escapeHtml(stripeText(user)) + '. Payouts enabled: ' + escapeHtml(yesNo(user.stripePayoutsEnabled)) + '.</p>';
    safe("manageRole").value = roleOf(user);
    safe("manageSuspended").checked = Boolean(user.suspended || roleOf(user) === "suspended");
    safe("manageUserModal").classList.add("active");
    document.body.classList.add("modal-open");
  };

  window.saveManagedUser = async function () {
    if (!isAdmin() || !state.managedUserId) return;
    var target = state.users.find(function (item) { return item.uid === state.managedUserId; }) || {};
    var nextRole = safe("manageRole").value;
    if (!["buyer", "contractor", "suspended"].includes(nextRole)) {
      toast("Assign owner, admin, and moderator roles in config/roles.json.", "error");
      return;
    }
    if (isOwnerRole(target) && !isOwnerRole(state.adminUser)) {
      toast("Only the owner can change an owner account.", "error");
      return;
    }
    if (["owner", "admin"].includes(nextRole) && !isOwnerRole(state.adminUser)) {
      toast("Only the owner can assign admin or owner roles.", "error");
      return;
    }
    if (state.managedUserId === state.authUser.uid && nextRole === "suspended") {
      toast("You cannot suspend your own account from here.", "error");
      return;
    }
    var button = safe("saveUserBtn");
    setButtonLoading(button, true);
    try {
      await db.collection("users").doc(state.managedUserId).set({
        role: nextRole,
        suspended: nextRole === "suspended" ? true : safe("manageSuspended").checked,
        updatedAt: serverTimestamp()
      }, { merge: true });
      closeManageUser();
      toast("User updated.", "success");
    } catch (error) {
      toast(dataMessage(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  };

  window.renderAnalytics = function () {
    if (!isAdmin()) return;
    var totals = [
      ["Total users", state.users.length],
      ["Total contractors", state.users.filter(function (user) { return roleOf(user) === "contractor"; }).length],
      ["Stripe complete", state.users.filter(function (user) { return user.stripeOnboardingComplete && user.stripePayoutsEnabled; }).length],
      ["Total service requests", state.jobs.length],
      ["Jobs open", countJobs("open")],
      ["Jobs claimed", countJobs("claimed")],
      ["Jobs completed", countJobs("completed")],
      ["Applications pending", state.applications.filter(function (app) { return app.status === "pending"; }).length],
      ["Support open", state.tickets.filter(function (ticket) { return ticket.status === "open"; }).length]
    ];
    safe("analyticsCards").innerHTML = totals.map(function (total) {
      return '<article class="card"><div class="stat-value">' + total[1] + '</div><p>' + escapeHtml(total[0]) + '</p></article>';
    }).join("");
    var statusCounts = ["pending_verification", "open", "claimed", "completed", "rejected"].map(function (status) {
      return [status, countJobs(status)];
    });
    var max = Math.max(1, ...statusCounts.map(function (item) { return item[1]; }));
    safe("jobStatusBars").innerHTML = statusCounts.map(function (item) {
      var pct = Math.round((item[1] / max) * 100);
      return '<div class="bar-row"><strong>' + escapeHtml(normalizeStatus(item[0])) + '</strong><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div><span>' + item[1] + '</span></div>';
    }).join("");
  };

  installAdminAuthDom();
})();
