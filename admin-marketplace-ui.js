(function () {
  "use strict";

  var refreshTimer = null;

  function byId(id) { return document.getElementById(id); }
  function esc(value) { return typeof escapeHtml === "function" ? escapeHtml(value == null ? "" : String(value)) : String(value == null ? "" : value); }
  function role() {
    var value = String((state.adminUser && state.adminUser.role) || "buyer").toLowerCase();
    return value === "user" ? "buyer" : value;
  }
  function isAdminAccount() { return ["owner", "admin"].includes(role()); }
  function money(cents) { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(cents || 0) / 100); }
  function date(value) {
    if (!value) return "Not set";
    var raw = value.__jcmTimestamp || value;
    return new Date(raw).toLocaleString();
  }
  async function api(action, payload) {
    var token = await state.authUser.getIdToken();
    var response = await fetch("/api/jobs/workflow", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || "Admin request failed.");
    return data;
  }
  function notify(error) { toast((error && error.message) || "Admin action failed.", "error"); }
  function count(items, predicate) { return (items || []).filter(predicate).length; }
  function text(id) { return byId(id) ? byId(id).value.trim() : ""; }

  function installStyles() {
    if (byId("adminMarketplaceStyles")) return;
    var style = document.createElement("style");
    style.id = "adminMarketplaceStyles";
    style.textContent = [
      ".sandbox-banner{border:1px solid #e0a92f;background:#fff7df;color:#684500;border-radius:12px;padding:12px 14px;margin:0 0 18px;font-weight:700}",
      ".admin-market-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}",
      ".admin-row{border:1px solid var(--border);border-radius:12px;padding:14px;background:#fff}",
      ".admin-row p{margin:6px 0}",
      ".admin-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}",
      ".admin-actions .btn{width:auto}",
      ".admin-form{display:grid;gap:8px;margin-top:10px}",
      ".admin-form input,.admin-form select,.admin-form textarea{width:100%}",
      ".urgent-ticket{border-left:5px solid #b42318}",
      ".audit-row{font-size:.9rem}",
      "@media(max-width:700px){.admin-actions .btn{width:100%}}"
    ].join("");
    document.head.appendChild(style);
  }

  function tab(id, title, copy) {
    return '<section class="tab" id="tab-' + id + '"><div class="section-header"><div><h1>' + esc(title) + '</h1><p>' + esc(copy) + '</p></div></div><div class="list" id="' + id + 'List"></div></section>';
  }

  function installDom() {
    installStyles();
    var nav = document.querySelector(".sidebar");
    if (nav) {
      nav.innerHTML = [
        ["overview", "Overview"],
        ["applications", "Contractor Applications"],
        ["requests", "Jobs / Requests"],
        ["users", "Users"],
        ["quotes", "Quotes"],
        ["disputes", "Disputes"],
        ["support", "Support"],
        ["payments", "Payments / Test Stripe"],
        ["audits", "Audit Logs"]
      ].map(function (item, index) {
        return '<button class="tab-button ' + (index === 0 ? "active" : "") + '" data-tab="' + item[0] + '" type="button" onclick="showTab(\'' + item[0] + '\')">' + item[1] + '</button>';
      }).join("");
    }
    var main = document.querySelector(".admin-main");
    if (main) {
      main.innerHTML = [
        '<div class="sandbox-banner">Stripe Sandbox / Test Mode: no real money is charged or paid. Contractor payout setup, buyer checkout, transfers, and refunds are test operations only.</div>',
        '<section class="tab active" id="tab-overview"><div class="section-header"><div><h1>Overview</h1><p>Operational marketplace snapshot.</p></div></div><div class="grid" id="adminOverviewStats"></div></section>',
        tab("applications", "Contractor Applications", "Pending applications only. Approved and rejected applications leave this list immediately."),
        tab("requests", "Jobs / Requests", "Review lifecycle, payment state, and admin-only force actions with reasons."),
        tab("users", "Users", "Suspend or restore ordinary accounts. Staff roles remain controlled by config/roles.json."),
        tab("quotes", "Quotes", "Review real contractor quote records."),
        tab("disputes", "Disputes", "Resolve disputed jobs with a required reason. Partial resolutions are intentionally unavailable until fully implemented."),
        tab("support", "Support", "Urgent tickets are prioritized."),
        tab("payments", "Payments / Test Stripe", "Review non-sensitive Stripe Test Mode metadata and payout release state."),
        tab("audits", "Audit Logs", "Review trusted marketplace actions and private-detail reveals.")
      ].join("");
    }
    state.activeTab = "overview";
  }

  window.showTab = function (name) {
    if (["users", "payments", "audits"].includes(name) && !isAdminAccount()) {
      toast("Admin or owner access is required for this tab.", "error");
      name = "overview";
    }
    state.activeTab = name;
    document.querySelectorAll(".tab").forEach(function (item) { item.classList.toggle("active", item.id === "tab-" + name); });
    document.querySelectorAll(".tab-button").forEach(function (item) { item.classList.toggle("active", item.dataset.tab === name); });
  };

  async function loadAdmin(silent) {
    if (!state.authUser || !state.adminUser) return;
    try {
      state.adminMarketplace = await api("adminOverview");
      renderAllMarketplaceAdmin();
    } catch (error) {
      if (!silent) notify(error);
    }
  }
  window.loadMarketplaceAdmin = loadAdmin;

  function renderOverview(data) {
    var stats = [
      ["Open requests", count(data.jobs, function (job) { return ["open", "quotes_received"].includes(job.status); })],
      ["Pending applications", data.applications.length],
      ["Open disputes", count(data.disputes, function (item) { return item.status === "open"; })],
      ["Urgent support", count(data.tickets, function (item) { return item.status === "open" && item.priority === "urgent"; })],
      ["Awaiting payment", count(data.jobs, function (job) { return job.status === "awaiting_payment"; })],
      ["Payment held", count(data.payments, function (item) { return item.paymentStatus === "held_pending_completion"; })]
    ];
    byId("adminOverviewStats").innerHTML = stats.map(function (item) { return '<article class="card"><div class="stat-value">' + item[1] + '</div><p>' + esc(item[0]) + '</p></article>'; }).join("");
  }

  function renderApplications(data) {
    byId("applicationsList").innerHTML = data.applications.length ? data.applications.map(function (app) {
      return '<article class="admin-row"><div class="item-header"><div><h3>' + esc(app.businessName || app.name || "Applicant") + '</h3><p>' + esc(app.email || "") + '</p></div>' + statusBadge(app.status) + '</div><p><strong>Phone:</strong> ' + esc(app.phone) + '</p><p><strong>Service area:</strong> ' + esc([app.city, app.zipCode, app.serviceRadius].filter(Boolean).join(" ")) + '</p><p><strong>Services:</strong> ' + esc((app.servicesOffered || app.skills || []).join(", ")) + '</p><p><strong>Equipment:</strong> ' + esc(app.equipment || "") + '</p><p><strong>Experience:</strong> ' + esc(app.experience || "") + '</p><p class="hint">Insurance or license information is applicant-provided and not represented as verified.</p><form class="admin-form" onsubmit="reviewMarketplaceApplication(event,\'' + esc(app.id) + '\',\'approve\')"><label>Approval note<input id="app-note-' + esc(app.id) + '" maxlength="1200" placeholder="Optional internal note"></label><div class="admin-actions"><button class="btn btn-primary" type="submit">Approve</button><button class="btn btn-danger" type="button" onclick="rejectMarketplaceApplication(\'' + esc(app.id) + '\')">Reject</button></div></form></article>';
    }).join("") : '<div class="card"><p>No pending contractor applications.</p></div>';
  }

  function forceForm(job) {
    if (!isAdminAccount()) return "";
    return '<form class="admin-form" onsubmit="forceMarketplaceStatus(event,\'' + esc(job.id) + '\')"><label>Force status<select id="force-status-' + esc(job.id) + '">' + (state.adminMarketplace.jobStatuses || []).map(function (status) { return '<option ' + (status === job.status ? "selected" : "") + '>' + esc(status) + '</option>'; }).join("") + '</select></label><label>Required admin reason<textarea id="force-reason-' + esc(job.id) + '" maxlength="1600" required></textarea></label><button class="btn btn-secondary" type="submit">Apply Admin Status Override</button></form>';
  }

  function renderRequests(data) {
    byId("requestsList").innerHTML = data.jobs.length ? data.jobs.map(function (job) {
      return '<article class="admin-row"><div class="item-header"><div><h3>' + esc(job.title || "Service request") + '</h3><p>' + esc([job.city, job.zipCode].filter(Boolean).join(" ")) + '</p></div>' + statusBadge(job.status) + '</div><p><strong>Service:</strong> ' + esc(job.serviceType) + '</p><p><strong>Buyer ID:</strong> ' + esc(job.postedBy) + '</p><p><strong>Accepted contractor:</strong> ' + esc(job.acceptedContractorName || "None") + '</p><p><strong>Payment:</strong> ' + esc(job.paymentStatus || "not_required") + '</p><div class="admin-actions"><button class="btn btn-secondary" type="button" onclick="revealMarketplaceBuyer(\'' + esc(job.id) + '\')">Reveal Buyer Details with Reason</button></div><div id="buyer-' + esc(job.id) + '"></div>' + forceForm(job) + '</article>';
    }).join("") : '<div class="card"><p>No requests found.</p></div>';
  }

  function renderUsers(data) {
    if (!isAdminAccount()) {
      byId("usersList").innerHTML = '<div class="card"><p>Admin or owner access is required.</p></div>';
      return;
    }
    byId("usersList").innerHTML = data.users.length ? data.users.map(function (user) {
      var staff = ["owner", "admin", "moderator"].includes(String(user.role || "").toLowerCase());
      return '<article class="admin-row"><h3>' + esc(user.displayName || user.email || "User") + '</h3><p>' + esc(user.email || "") + '</p><p><strong>Role:</strong> ' + esc(user.role || "buyer") + '</p><p><strong>Contractor status:</strong> ' + esc(user.contractorStatus || "none") + '</p><p><strong>Stripe Test Mode ready:</strong> ' + esc(user.stripeOnboardingComplete && user.stripePayoutsEnabled ? "Yes" : "No") + '</p>' + (staff ? '<p class="hint">Manage staff access in config/roles.json.</p>' : '<form class="admin-form" onsubmit="updateMarketplaceUser(event,\'' + esc(user.uid) + '\',' + (!user.suspended) + ')"><label>Required reason<input id="user-reason-' + esc(user.uid) + '" maxlength="1200" required></label><button class="btn btn-secondary" type="submit">' + (user.suspended ? "Unsuspend User" : "Suspend User") + '</button></form>') + '</article>';
    }).join("") : '<div class="card"><p>No users found.</p></div>';
  }

  function renderQuotes(data) {
    byId("quotesList").innerHTML = data.quotes.length ? data.quotes.map(function (quote) {
      return '<article class="admin-row"><h3>' + esc(quote.contractorBusinessName || quote.contractorDisplayName || "Contractor") + '</h3><p><strong>Job:</strong> ' + esc(quote.jobId) + '</p><p><strong>Status:</strong> ' + esc(quote.status) + '</p><p><strong>Price:</strong> ' + esc(quote.priceCents ? money(quote.priceCents) : quote.priceNote || "Price note only") + '</p><p>' + esc(quote.message || "") + '</p></article>';
    }).join("") : '<div class="card"><p>No quotes submitted yet.</p></div>';
  }

  function renderDisputes(data) {
    byId("disputesList").innerHTML = data.disputes.length ? data.disputes.map(function (item) {
      var form = item.status === "open" && isAdminAccount() ? '<form class="admin-form" onsubmit="resolveMarketplaceDispute(event,\'' + esc(item.jobId) + '\')"><label>Resolution<select id="resolution-' + esc(item.jobId) + '"><option value="release_contractor">Release full contractor payout</option><option value="refund_buyer">Refund buyer fully</option><option value="close_without_payout">Close without payout if no payment collected</option><option value="reopen_job">Reopen job if payment is resolved</option></select></label><label>Required reason<textarea id="resolution-reason-' + esc(item.jobId) + '" maxlength="1600" required></textarea></label><button class="btn btn-primary" type="submit">Resolve Dispute</button></form>' : "";
      return '<article class="admin-row"><div class="item-header"><div><h3>Dispute for ' + esc(item.jobId) + '</h3><p>' + esc(item.reason) + '</p></div>' + statusBadge(item.status) + '</div><p>' + esc(item.note || "") + '</p>' + form + '</article>';
    }).join("") : '<div class="card"><p>No disputes found.</p></div>';
  }

  function renderSupport(data) {
    byId("supportList").innerHTML = data.tickets.length ? data.tickets.map(function (ticket) {
      var form = ticket.status === "open" ? '<form class="admin-form" onsubmit="closeMarketplaceTicket(event,\'' + esc(ticket.id) + '\')"><label>Resolution note<input id="ticket-note-' + esc(ticket.id) + '" maxlength="1200" required></label><button class="btn btn-secondary" type="submit">Close Ticket</button></form>' : "";
      return '<article class="admin-row ' + (ticket.priority === "urgent" ? "urgent-ticket" : "") + '"><div class="item-header"><div><h3>' + esc(ticket.topic) + '</h3><p>' + esc(ticket.userEmail || ticket.email || "") + '</p></div>' + statusBadge(ticket.status) + '</div><p><strong>Priority:</strong> ' + esc(ticket.priority || "normal") + '</p><p><strong>Job:</strong> ' + esc(ticket.jobId || "Not linked") + '</p><p>' + esc(ticket.message) + '</p>' + form + '</article>';
    }).join("") : '<div class="card"><p>No support tickets found.</p></div>';
  }

  function renderPayments(data) {
    if (!isAdminAccount()) {
      byId("paymentsList").innerHTML = '<div class="card"><p>Admin or owner access is required.</p></div>';
      return;
    }
    byId("paymentsList").innerHTML = data.payments.length ? data.payments.map(function (item) {
      return '<article class="admin-row"><div class="item-header"><div><h3>' + esc(item.jobId) + '</h3><p>Stripe ' + esc(item.stripeMode || "test") + ' mode</p></div>' + statusBadge(item.paymentStatus) + '</div><p><strong>Final price:</strong> ' + money(item.finalAmountCents) + '</p><p><strong>JCM 30% fee:</strong> ' + money(item.platformFeeCents) + '</p><p><strong>Contractor 70% payout:</strong> ' + money(item.contractorAmountCents) + '</p><p><strong>Release:</strong> ' + esc(item.releaseStatus) + '</p><p><strong>Refund:</strong> ' + esc(item.refundStatus) + '</p><p><strong>Payment Intent:</strong> ' + esc(item.stripePaymentIntentId || "Not created") + '</p><p><strong>Transfer:</strong> ' + esc(item.stripeTransferId || "Not released") + '</p></article>';
    }).join("") : '<div class="card"><p>No payment records yet.</p></div>';
  }

  function renderAudits(data) {
    if (!isAdminAccount()) {
      byId("auditsList").innerHTML = '<div class="card"><p>Admin or owner access is required.</p></div>';
      return;
    }
    byId("auditsList").innerHTML = data.audits.length ? data.audits.map(function (item) {
      return '<article class="admin-row audit-row"><strong>' + esc(item.actionType) + '</strong><p>' + esc(item.actorRole) + ': ' + esc(item.actorId) + '</p><p>' + esc(item.targetType) + ': ' + esc(item.targetId) + '</p><p>' + esc(item.reason || item.note || "") + '</p><p>' + esc(date(item.createdAt)) + '</p></article>';
    }).join("") : '<div class="card"><p>No audit records yet.</p></div>';
  }

  function renderAllMarketplaceAdmin() {
    var data = state.adminMarketplace;
    if (!data) return;
    renderOverview(data);
    renderApplications(data);
    renderRequests(data);
    renderUsers(data);
    renderQuotes(data);
    renderDisputes(data);
    renderSupport(data);
    renderPayments(data);
    renderAudits(data);
  }
  window.renderAll = renderAllMarketplaceAdmin;

  window.reviewMarketplaceApplication = async function (event, applicationId, decision) {
    event.preventDefault();
    try {
      await api("adminReviewApplication", { applicationId: applicationId, decision: decision, reason: text("app-note-" + applicationId) });
      await loadAdmin(true);
      toast("Contractor application approved.", "success");
    } catch (error) { notify(error); }
  };
  window.rejectMarketplaceApplication = async function (applicationId) {
    var reason = window.prompt("Enter the rejection reason. This is required.");
    if (!reason) return;
    try {
      await api("adminReviewApplication", { applicationId: applicationId, decision: "reject", reason: reason });
      await loadAdmin(true);
      toast("Contractor application rejected.", "success");
    } catch (error) { notify(error); }
  };
  window.forceMarketplaceStatus = async function (event, jobId) { event.preventDefault(); try { await api("adminForceStatus", { jobId: jobId, status: text("force-status-" + jobId), reason: text("force-reason-" + jobId) }); await loadAdmin(true); toast("Job status updated with audit log.", "success"); } catch (error) { notify(error); } };
  window.updateMarketplaceUser = async function (event, uid, suspended) { event.preventDefault(); try { await api("adminUpdateUser", { uid: uid, suspended: suspended, reason: text("user-reason-" + uid) }); await loadAdmin(true); toast("User updated.", "success"); } catch (error) { notify(error); } };
  window.resolveMarketplaceDispute = async function (event, jobId) { event.preventDefault(); try { await api("adminResolveDispute", { jobId: jobId, resolution: text("resolution-" + jobId), reason: text("resolution-reason-" + jobId) }); await loadAdmin(true); toast("Dispute resolved.", "success"); } catch (error) { notify(error); } };
  window.closeMarketplaceTicket = async function (event, ticketId) { event.preventDefault(); try { await api("adminCloseTicket", { ticketId: ticketId, reason: text("ticket-note-" + ticketId) }); await loadAdmin(true); toast("Support ticket closed.", "success"); } catch (error) { notify(error); } };
  window.revealMarketplaceBuyer = async function (jobId) {
    var reason = window.prompt("Enter the moderation or support reason for revealing private buyer details.");
    if (!reason) return;
    try {
      var result = await api("revealPrivateDetails", { jobId: jobId, reason: reason });
      var item = result.details;
      byId("buyer-" + jobId).innerHTML = '<div class="admin-row"><strong>' + esc(item.posterName || "Buyer") + '</strong><p>' + esc(item.fullAddress || "No address provided") + '</p><p>' + esc(item.posterPhone || "") + '</p><p>' + esc(item.posterEmail || "") + '</p><p><strong>Gate / lock:</strong> ' + esc(item.gateInstructions || "None") + '</p><p><strong>Access:</strong> ' + esc(item.parkingInstructions || "None") + '</p></div>';
    } catch (error) { notify(error); }
  };

  window.attachListeners = function () {
    if (refreshTimer) clearInterval(refreshTimer);
    loadAdmin(true);
    refreshTimer = setInterval(function () { loadAdmin(true); }, 30000);
    state.unsubscribes.push(function () { if (refreshTimer) clearInterval(refreshTimer); });
  };

  installDom();
  auth.onAuthStateChanged(function (user) {
    if (!user) return;
    setTimeout(function () {
      if (state.adminUser) {
        window.attachListeners();
        loadAdmin(true);
      }
    }, 200);
  });
})();
