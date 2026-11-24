// Parcel Desk: staff app
(() => {
  "use strict";

  const CFG = window.PARCEL_CONFIG || {};
  const CARRIERS = ["Royal Mail", "Amazon", "Evri", "DPD", "DHL", "UPS", "Yodel", "Other"];
  const SIZES = ["Small", "Medium", "Large"];
  const REMIND_AFTER_DAYS = 3;
  const REMIND_STOP_DAYS = 9;          // at most 2 reminders per parcel (day 3 and day 6)
  const REMIND_HOURS = [9, 20];        // automatic reminders only between 9am and 8pm UK time
  const AUTO_SEND_SECONDS = 30;   // wait after the last parcel, so Undo still works and a delivery round goes out together
  const AUTO_SEND_MAX_WAIT = 120; // never hold emails longer than this while parcels keep coming in
  const DAY = 24 * 60 * 60 * 1000;
  const PARCEL_FIELDS = "id, flat, carrier, size, note, code, created_at, notified_at, reminded_at";

  const $ = (s, root = document) => root.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const normFlat = (s) => String(s || "").trim().replace(/\s+/g, " ").toUpperCase();
  const flatOrder = (a, b) => a.localeCompare(b, "en-GB", { numeric: true, sensitivity: "base" });
  const finePointer = window.matchMedia("(pointer: fine)").matches;

  const S = { user: null, building: null, residents: [], pendingRes: [], resMap: new Map(), parcels: [], tab: "log" };
  const RES_FIELDS = "id, flat, name, email, created_at, approved_at";

  function show(id) {
    for (const s of ["screen-setup", "screen-login", "screen-password", "screen-app"]) $("#" + s).hidden = s !== id;
  }

  function setupMessage(msg, signedIn = false) {
    $("#setup-msg").textContent = msg;
    $("#setup-signout").hidden = !signedIn;
    show("screen-setup");
  }

  // ---------- Config check ----------
  if (!window.supabase) {
    setupMessage("The app couldn't load. Check your internet connection and refresh the page.");
    return;
  }
  if (!CFG.supabaseUrl || CFG.supabaseUrl.includes("YOUR-PROJECT") || !CFG.supabaseKey || CFG.supabaseKey.includes("YOUR-")) {
    setupMessage("Add your Supabase project URL and key to config.js, then upload it to GitHub again.");
    return;
  }
  // Invite and password-reset emails bring people back here with details in the address.
  // Read them before the Supabase library tidies the address up.
  const linkInfo = new URLSearchParams(location.hash.slice(1));
  const linkType = linkInfo.get("type"); // "invite" or "recovery"
  const linkError = linkInfo.get("error_description") || linkInfo.get("error");

  const db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const appUrl = location.origin + location.pathname;

  // ---------- Helpers ----------
  let toastTimer;
  function toast(msg, undo) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>` + (undo ? `<button type="button">Undo</button>` : "");
    if (undo) t.querySelector("button").onclick = () => { t.hidden = true; undo(); };
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 7000 : 4000);
  }

  const timeOnly = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  function arrived(iso) {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - DAY);
    if (d.toDateString() === today.toDateString()) return `Arrived today, ${timeOnly(iso)}`;
    if (d.toDateString() === yesterday.toDateString()) return `Arrived yesterday, ${timeOnly(iso)}`;
    return "Arrived " + d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  const daysWaiting = (p) => Math.floor((Date.now() - new Date(p.created_at)) / DAY);
  const hasEmail = (flat) => S.resMap.has(flat);

  const pending = () => S.parcels.filter((p) => !p.notified_at && hasEmail(p.flat));
  const remindDue = () => S.parcels.filter((p) => {
    const limit = REMIND_AFTER_DAYS * DAY;
    const age = Date.now() - new Date(p.created_at);
    return p.notified_at && hasEmail(p.flat) &&
      age > limit && age < REMIND_STOP_DAYS * DAY &&
      (!p.reminded_at || Date.now() - new Date(p.reminded_at) > limit);
  });

  function rebuildResMap() {
    S.residents.sort((a, b) => flatOrder(a.flat, b.flat) || a.name.localeCompare(b.name));
    S.resMap = new Map();
    for (const r of S.residents) {
      if (!S.resMap.has(r.flat)) S.resMap.set(r.flat, []);
      S.resMap.get(r.flat).push(r);
    }
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  // ---------- Auth ----------
  async function start() {
    const { data } = await db.auth.getSession();
    if (linkError) {
      history.replaceState(null, "", appUrl);
      if (data.session) await db.auth.signOut({ scope: "local" });
      showLogin("", "That link has expired or was already used. Ask for a new invitation, or use Forgot your password? below.");
      return;
    }
    if (data.session && (linkType === "invite" || linkType === "recovery")) {
      showPasswordScreen(linkType, data.session.user);
      return;
    }
    if (data.session) await enter(data.session.user);
    else showLogin();
  }

  function showLogin(info = "", error = "") {
    $("#login-info").textContent = info;
    $("#login-info").hidden = !info;
    $("#login-error").textContent = error;
    $("#login-error").hidden = !error;
    show("screen-login");
  }

  function showPasswordScreen(type, user) {
    history.replaceState(null, "", appUrl);
    S.passwordUser = user;
    const invite = type === "invite";
    $("#password-title").textContent = invite ? "Choose your password" : "Set a new password";
    $("#password-intro").textContent = invite
      ? `Welcome. Choose a password for ${user.email}. You'll use it to sign in to Parcel Desk, and only you will know it.`
      : `Choose a new password for ${user.email}.`;
    $("#password-username").value = user.email || "";
    $("#password-error").hidden = true;
    show("screen-password");
    $("#new-password").focus();
  }

  $("#password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = $("#new-password").value;
    const p2 = $("#new-password-2").value;
    const errEl = $("#password-error");
    const problem =
      p1.length < 12 ? "Use at least 12 characters." :
      p1 !== p2 ? "The two passwords don't match. Type them again." : "";
    if (problem) { errEl.textContent = problem; errEl.hidden = false; return; }
    errEl.hidden = true;
    const btn = $("#password-btn");
    busy(btn, true, "Saving…");
    const { data, error } = await db.auth.updateUser({ password: p1 });
    busy(btn, false);
    if (error) {
      errEl.textContent = /different from the old/i.test(error.message)
        ? "Choose a password you haven't used here before."
        : /session|expired|jwt/i.test(error.message)
          ? "This link has expired. Ask for a new invitation, or use Forgot your password? on the sign-in page."
          : error.message;
      errEl.hidden = false;
      return;
    }
    $("#password-form").reset();
    toast("Password saved.");
    await enter(data.user || S.passwordUser);
  });

  $("#forgot-btn").addEventListener("click", async () => {
    const email = $("#login-email").value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      showLogin("", "Type your email address above first, then tap Forgot your password? again.");
      $("#login-email").focus();
      return;
    }
    const btn = $("#forgot-btn");
    busy(btn, true, "Sending…");
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: appUrl });
    busy(btn, false);
    if (error && /rate|too many|seconds/i.test(error.message)) {
      showLogin("", "A reset email was sent very recently. Wait a minute, then try again.");
      return;
    }
    // Same message whether or not the email has a login, so nobody can check who has access.
    showLogin(`If ${email} has a Parcel Desk login, we've sent it a link to set a new password. Check the spam folder too.`);
  });

  async function enter(user) {
    S.user = user;
    const { data, error } = await db
      .from("staff")
      .select("building_id, name, buildings(id, name, code, contact_email)")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) return setupMessage(`Your account couldn't be loaded: ${error.message}`, true);
    if (!data) return setupMessage("This login isn't linked to a building yet. Link it in Supabase (step 3 of the setup guide), then sign in again.", true);

    S.building = Array.isArray(data.buildings) ? data.buildings[0] : data.buildings;
    $("#building-name").textContent = S.building.name;
    document.title = `${S.building.name} parcels`;
    show("screen-app");
    renderChips();
    renderSignupLink();
    await loadAll();
    if (finePointer) $("#flat-input").focus();
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#login-btn");
    const errEl = $("#login-error");
    busy(btn, true, "Signing in…");
    const { data, error } = await db.auth.signInWithPassword({
      email: $("#login-email").value.trim(),
      password: $("#login-password").value,
    });
    busy(btn, false);
    if (error) {
      errEl.textContent = /invalid login/i.test(error.message)
        ? "That email and password don't match. Check them and try again."
        : error.message;
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    $("#login-info").hidden = true;
    await enter(data.user);
  });

  async function signOut() {
    await db.auth.signOut();
    location.reload();
  }
  $("#signout-btn").addEventListener("click", signOut);
  $("#setup-signout").addEventListener("click", signOut);

  // ---------- Data ----------
  async function loadAll() {
    const [r, p] = await Promise.all([
      db.from("residents").select(RES_FIELDS),
      db.from("parcels").select(PARCEL_FIELDS).is("collected_at", null).order("created_at", { ascending: false }),
    ]);
    if (r.error || p.error) {
      toast("Couldn't refresh. Check your connection and try again.");
      return;
    }
    S.residents = r.data.filter((x) => x.approved_at);
    S.pendingRes = r.data.filter((x) => !x.approved_at).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    rebuildResMap();
    S.parcels = p.data;
    renderAll();
    if (pending().length && !auto.timer && !auto.sending && !auto.paused) scheduleAutoSend();
    maybeAutoRemind();
  }

  // Automatic reminders: daytime only, and after a failure wait an hour before trying again
  const remindState = { busy: false, retryAfter: 0 };
  function ukHour() {
    return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/London" }).format(new Date()));
  }
  function maybeAutoRemind() {
    const h = ukHour();
    if (!remindDue().length || remindState.busy || auto.sending) return;
    if (h < REMIND_HOURS[0] || h >= REMIND_HOURS[1]) return;
    if (Date.now() < remindState.retryAfter) return;
    sendEmails("remind", null, true);
  }

  function renderAll() {
    renderFlatHint();
    renderToday();
    renderWaiting();
    renderResidents();
    renderSendbar();
    const n = S.parcels.length;
    const c = $("#waiting-count");
    c.textContent = n;
    c.hidden = n === 0;
    const pc = $("#pending-count");
    pc.textContent = S.pendingRes.length;
    pc.hidden = S.pendingRes.length === 0;
  }

  // ---------- Tabs ----------
  function setTab(tab) {
    S.tab = tab;
    for (const t of ["log", "waiting", "residents"]) {
      $("#tab-" + t).hidden = t !== tab;
      $("#tabbtn-" + t).setAttribute("aria-selected", String(t === tab));
    }
    window.scrollTo(0, 0);
    if (tab === "log" && finePointer) $("#flat-input").focus();
    if (tab === "waiting" && finePointer) $("#waiting-search").focus();
  }

  // ---------- Log parcel ----------
  function renderChips() {
    const chip = (v) => `<button type="button" class="chip" aria-pressed="false" data-value="${esc(v)}">${esc(v)}</button>`;
    $("#carrier-chips").innerHTML = CARRIERS.map(chip).join("");
    $("#size-chips").innerHTML = SIZES.map(chip).join("");
  }
  const chipValue = (id) => $(`#${id} .chip[aria-pressed="true"]`)?.dataset.value || null;
  const clearChips = (id) => document.querySelectorAll(`#${id} .chip`).forEach((c) => c.setAttribute("aria-pressed", "false"));

  function renderFlatHint() {
    const el = $("#flat-hint");
    const v = normFlat($("#flat-input").value);
    if (!v) { el.innerHTML = ""; return; }

    const people = S.resMap.get(v);
    if (people) {
      el.innerHTML = `<p class="note note-ok">${people.length === 1
        ? `${esc(people[0].name)} will get an email.`
        : `${people.length} residents will get an email: ${esc(people.map((p) => p.name).join(", "))}.`}</p>`;
      return;
    }

    const matches = [...S.resMap.keys()].filter((f) => f.startsWith(v)).sort(flatOrder).slice(0, 8);
    if (matches.length) {
      el.innerHTML = `<div class="suggest" aria-label="Matching flats">${matches.map((f) => {
        const ppl = S.resMap.get(f);
        const who = ppl[0].name.split(" ")[0] + (ppl.length > 1 ? ` +${ppl.length - 1}` : "");
        return `<button type="button" data-flat="${esc(f)}">${esc(f)}<small>${esc(who)}</small></button>`;
      }).join("")}</div>`;
      return;
    }
    const waiting = S.pendingRes.filter((r) => r.flat === v);
    el.innerHTML = waiting.length
      ? `<p class="note note-warn">${esc(waiting.map((r) => r.name).join(", "))} signed up for Flat ${esc(v)} but ${waiting.length === 1 ? "isn't" : "aren't"} approved yet. Approve them in Residents so they get emails.</p>`
      : `<p class="note note-warn">No one in Flat ${esc(v)} has signed up yet. You can still log the parcel, but no email will go out.</p>`;
  }

  $("#flat-input").addEventListener("input", renderFlatHint);

  $("#log-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const flat = normFlat($("#flat-input").value);
    if (!flat) {
      toast("Type the flat number first.");
      $("#flat-input").focus();
      return;
    }
    const btn = $("#log-btn");
    busy(btn, true, "Logging…");
    const { data, error } = await db
      .from("parcels")
      .insert({
        building_id: S.building.id,
        flat,
        carrier: chipValue("carrier-chips"),
        size: chipValue("size-chips"),
        note: $("#note-input").value.trim() || null,
      })
      .select(PARCEL_FIELDS)
      .single();
    busy(btn, false);
    if (error) return toast(`The parcel wasn't logged: ${error.message}`);

    S.parcels.unshift(data);
    $("#flat-input").value = "";
    $("#note-input").value = "";
    clearChips("size-chips"); // carrier stays selected: couriers often drop several at once
    auto.paused = false;
    scheduleAutoSend(true);
    renderAll();
    $("#flat-input").focus();

    const who = hasEmail(data.flat) ? " Email goes out shortly." : "";
    toast(`Logged for Flat ${data.flat}. Code ${data.code}.${who}`, async () => {
      const { error: delErr } = await db.from("parcels").delete().eq("id", data.id);
      if (delErr) return toast(`Couldn't undo: ${delErr.message}`);
      S.parcels = S.parcels.filter((p) => p.id !== data.id);
      if (!pending().length) cancelAutoSend();
      renderAll();
      toast("Parcel removed. No email will be sent for it.");
    });
  });

  function badges(p) {
    const out = [];
    if (!hasEmail(p.flat)) out.push(`<span class="badge badge-none">No email registered</span>`);
    else if (!p.notified_at) out.push(`<span class="badge badge-wait">Not emailed yet</span>`);
    const d = daysWaiting(p);
    if (d >= REMIND_AFTER_DAYS) out.push(`<span class="badge badge-late">Waiting ${d} days</span>`);
    return out.join("");
  }

  function renderToday() {
    const today = new Date().toDateString();
    const items = S.parcels.filter((p) => new Date(p.created_at).toDateString() === today);
    const el = $("#today-list");
    if (!items.length) {
      el.innerHTML = `<p class="muted">Parcels you log today will appear here.</p>`;
      return;
    }
    el.innerHTML = `<h2 style="margin-bottom:10px">Logged today, still waiting</h2>
      <div class="group">${items.map((p) => `
        <div class="row">
          <div>
            <span class="flat-tag"><b>${esc(p.flat)}</b></span>
            <span class="meta" style="margin-left:8px">${esc(timeOnly(p.created_at))}${p.carrier ? ", " + esc(p.carrier) : ""}</span>
            <div class="badges">${badges(p)}</div>
          </div>
          <span class="code">${esc(p.code)}</span>
        </div>`).join("")}
      </div>`;
  }

  // ---------- Waiting ----------
  function renderWaiting() {
    const due = remindDue();
    $("#remind-box").innerHTML = due.length
      ? `<div class="note note-info" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
           <span>${due.length} ${due.length === 1 ? "parcel needs" : "parcels need"} a reminder. They go out automatically between 9am and 8pm.</span>
           <button class="btn btn-small" type="button" data-action="remind">Send reminders now</button>
         </div>`
      : "";

    const el = $("#waiting-list");
    if (!S.parcels.length) {
      el.innerHTML = `<div class="panel empty"><h3>No parcels waiting</h3>
        <p class="soft" style="margin-top:6px">Parcels you log will show here until they're collected.</p></div>`;
      return;
    }

    const q = normFlat($("#waiting-search").value);
    const list = q ? S.parcels.filter((p) => p.flat.startsWith(q) || p.code.startsWith(q)) : S.parcels;
    if (!list.length) {
      el.innerHTML = `<p class="muted">No waiting parcels match “${esc(q)}”.</p>`;
      return;
    }

    const groups = new Map();
    for (const p of list) {
      if (!groups.has(p.flat)) groups.set(p.flat, []);
      groups.get(p.flat).push(p);
    }
    el.innerHTML = [...groups.entries()].sort((a, b) => flatOrder(a[0], b[0])).map(([flat, ps]) => {
      ps.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const people = S.resMap.get(flat) || [];
      return `<div class="group">
        <div class="group-head">
          <div>
            <span class="flat-tag"><b>${esc(flat)}</b></span>
            <div class="who">${people.length ? esc(people.map((r) => r.name).join(", ")) : "No one registered"}</div>
          </div>
          ${ps.length > 1 ? `<button class="btn btn-small btn-go" type="button" data-action="collect-flat" data-flat="${esc(flat)}">All ${ps.length} collected</button>` : ""}
        </div>
        ${ps.map((p) => `
          <div class="row">
            <div>
              <span class="code">${esc(p.code)}</span>
              <div class="meta">${esc([p.carrier, p.size, p.note].filter(Boolean).join(", ") || "Parcel")}</div>
              <div class="meta">${esc(arrived(p.created_at))}</div>
              <div class="badges">${badges(p)}</div>
            </div>
            <button class="btn btn-small btn-go" type="button" data-action="collect" data-id="${esc(p.id)}">Collected</button>
          </div>`).join("")}
      </div>`;
    }).join("");
  }

  $("#waiting-search").addEventListener("input", renderWaiting);

  async function markCollected(ids, label) {
    const { error } = await db
      .from("parcels")
      .update({ collected_at: new Date().toISOString(), collected_by: S.user.id })
      .in("id", ids);
    if (error) return toast(`Couldn't mark as collected: ${error.message}`);

    const removed = S.parcels.filter((p) => ids.includes(p.id));
    S.parcels = S.parcels.filter((p) => !ids.includes(p.id));
    renderAll();
    toast(label, async () => {
      const { error: undoErr } = await db
        .from("parcels")
        .update({ collected_at: null, collected_by: null })
        .in("id", ids);
      if (undoErr) return toast(`Couldn't undo: ${undoErr.message}`);
      S.parcels = [...removed, ...S.parcels].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      renderAll();
    });
  }

  // ---------- Emails (sent automatically) ----------
  // After a parcel is logged, emails go out by themselves once nothing new
  // has been logged for AUTO_SEND_SECONDS. "Send now" skips the wait.
  const auto = { timer: null, tick: null, at: 0, first: 0, sending: false, paused: false };

  function scheduleAutoSend(extend = false) {
    if (!pending().length) return;
    const now = Date.now();
    if (!auto.first) auto.first = now;
    let at = now + AUTO_SEND_SECONDS * 1000;
    if (!extend && auto.at) at = Math.min(at, auto.at);
    at = Math.min(at, auto.first + AUTO_SEND_MAX_WAIT * 1000);
    auto.at = Math.max(at, now + 1000);
    clearTimeout(auto.timer);
    auto.timer = setTimeout(() => sendEmails("notify", $("#send-btn"), true), auto.at - now);
    if (!auto.tick) auto.tick = setInterval(renderSendbar, 1000);
    renderSendbar();
  }

  function cancelAutoSend() {
    clearTimeout(auto.timer);
    clearInterval(auto.tick);
    Object.assign(auto, { timer: null, tick: null, at: 0, first: 0 });
    renderSendbar();
  }

  function renderSendbar() {
    const n = pending().length;
    $("#sendbar").hidden = n === 0;
    if (!n) return;
    const what = `${n} ${n === 1 ? "parcel" : "parcels"}`;
    if (auto.sending) {
      $("#sendbar-text").textContent = `Emailing residents about ${what}…`;
    } else if (auto.at) {
      const secs = Math.max(0, Math.ceil((auto.at - Date.now()) / 1000));
      $("#sendbar-text").textContent = `Emailing residents about ${what} in ${secs}s`;
      $("#send-btn").textContent = "Send now";
    } else {
      $("#sendbar-text").textContent = `${what} not emailed yet`;
      $("#send-btn").textContent = "Send emails";
    }
  }

  async function sendEmails(mode, btn, automatic = false) {
    if (mode === "notify") {
      if (auto.sending) return;
      clearTimeout(auto.timer);
      clearInterval(auto.tick);
      Object.assign(auto, { timer: null, tick: null, at: 0, first: 0, sending: true });
      renderSendbar();
    }
    if (mode === "remind") {
      if (remindState.busy) return;
      remindState.busy = true;
    }
    busy(btn, true, "Sending…");
    const { data, error } = await db.functions.invoke("notify", { body: { mode } });
    busy(btn, false);
    if (mode === "notify") auto.sending = false;
    if (mode === "remind") {
      remindState.busy = false;
      remindState.retryAfter = error || data?.failedFlats?.length ? Date.now() + 60 * 60 * 1000 : 0;
    }
    if (error) {
      let msg = error.message;
      try {
        const body = await error.context.json();
        if (body?.error) msg = body.error;
      } catch { /* keep generic message */ }
      if (mode === "notify") { auto.paused = true; renderSendbar(); }
      if (mode === "remind" && automatic) return; // quiet: it tries again in an hour, and the button is there
      return toast(`Emails weren't sent. ${String(msg).trim().replace(/\.?$/, ".")} Tap Send emails to try again.`);
    }
    if (mode === "notify") {
      auto.paused = false;
      if (data.failedFlats?.length) auto.paused = true; // don't retry on a loop; the button stays
    }
    await loadAll();
    const people = `${data.sent} ${data.sent === 1 ? "resident" : "residents"}`;
    let msg = data.sent
      ? (mode === "remind" ? `Sent a reminder to ${people} about waiting parcels.` : `Emailed ${people}.`)
      : automatic ? "" : "Nothing to send.";
    if (data.failedFlats?.length) msg += ` Couldn't email Flat ${data.failedFlats.join(", ")}. Tap Send emails to try again.`;
    if (msg.trim()) toast(msg.trim());
  }

  $("#send-btn").addEventListener("click", (e) => { auto.paused = false; sendEmails("notify", e.currentTarget); });

  // ---------- Residents ----------
  const signupUrl = () => new URL(`register.html?b=${encodeURIComponent(S.building.code)}`, location.href).href;

  function renderSignupLink() {
    const url = signupUrl();
    $("#signup-link").innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  }

  function renderPending() {
    const el = $("#pending-box");
    if (!S.pendingRes.length) { el.innerHTML = ""; el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `
      <div class="pending-head">
        <h2>New sign-ups to check</h2>
        <p class="soft small">Approve only people you know live in that flat. They won't get any emails until you do.</p>
      </div>
      ${S.pendingRes.map((r) => {
        const others = (S.resMap.get(r.flat) || []).map((x) => x.name);
        return `
        <div class="res-row pending-row">
          <div style="display:flex;gap:14px;align-items:baseline;min-width:0;flex:1">
            <span class="res-flat">${esc(r.flat)}</span>
            <div style="min-width:0;flex:1">
              <div>${esc(r.name)}</div>
              <div class="email">${esc(r.email)}</div>
              <div class="meta small">${others.length ? `Already on this flat: ${esc(others.join(", "))}` : "No one else on this flat yet"}</div>
            </div>
          </div>
          <div class="actions pending-actions">
            <button class="btn btn-small btn-go" type="button" data-action="approve-res" data-id="${esc(r.id)}" aria-label="Approve ${esc(r.name)}">Approve</button>
            <button class="btn btn-small" type="button" data-action="reject-res" data-id="${esc(r.id)}" aria-label="Reject ${esc(r.name)}">Reject</button>
          </div>
        </div>`;
      }).join("")}`;
  }

  async function approveResident(id) {
    const r = S.pendingRes.find((x) => x.id === id);
    if (!r) return;
    const { data, error } = await db
      .from("residents")
      .update({ approved_at: new Date().toISOString() })
      .eq("id", id)
      .select(RES_FIELDS)
      .single();
    if (error) return toast(`Couldn't approve: ${error.message}`);
    S.pendingRes = S.pendingRes.filter((x) => x.id !== id);
    S.residents.push(data);
    rebuildResMap();
    renderAll();
    toast(`Approved ${r.name} for Flat ${r.flat}.`, async () => {
      const { error: undoErr } = await db.from("residents").update({ approved_at: null }).eq("id", id);
      if (undoErr) return toast(`Couldn't undo: ${undoErr.message}`);
      loadAll();
    });
  }

  async function rejectResident(id) {
    const r = S.pendingRes.find((x) => x.id === id);
    if (!r) return;
    const { error } = await db.from("residents").delete().eq("id", id);
    if (error) return toast(`Couldn't reject: ${error.message}`);
    S.pendingRes = S.pendingRes.filter((x) => x.id !== id);
    renderAll();
    toast(`Rejected ${r.name}. Their details were deleted.`, async () => {
      const { error: undoErr } = await db
        .from("residents")
        .insert({ building_id: S.building.id, name: r.name, flat: r.flat, email: r.email, approved_at: null });
      if (undoErr) return toast(`Couldn't undo: ${undoErr.message}`);
      loadAll();
    });
  }

  function renderResidents() {
    renderPending();
    const q = $("#res-search").value.trim().toLowerCase();
    const list = q
      ? S.residents.filter((r) =>
          r.name.toLowerCase().includes(q) || r.email.includes(q) || r.flat.toLowerCase().startsWith(q))
      : S.residents;

    $("#res-count").textContent = S.residents.length
      ? `${S.residents.length} ${S.residents.length === 1 ? "person" : "people"} in ${S.resMap.size} ${S.resMap.size === 1 ? "flat" : "flats"}`
      : "";

    $("#res-list").innerHTML = list.length
      ? list.map((r) => `
        <div class="res-row">
          <div style="display:flex;gap:14px;align-items:baseline;min-width:0;flex:1">
            <span class="res-flat">${esc(r.flat)}</span>
            <div style="min-width:0;flex:1"><div>${esc(r.name)}</div><div class="email">${esc(r.email)}</div></div>
          </div>
          <button class="btn btn-small" type="button" data-action="remove-res" data-id="${esc(r.id)}" aria-label="Remove ${esc(r.name)}">Remove</button>
        </div>`).join("")
      : `<div class="empty"><p class="soft">${S.residents.length
          ? "No one matches that search."
          : "No residents yet. Share the sign-up link or print the lobby poster to get started."}</p></div>`;
  }

  $("#res-search").addEventListener("input", renderResidents);

  $("#add-res-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#res-name").value.trim();
    const flat = normFlat($("#res-flat").value);
    const email = $("#res-email").value.trim().toLowerCase();
    const errEl = $("#res-error");
    const problem =
      name.length < 2 ? "Add the resident's full name." :
      !flat ? "Add the flat number." :
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? "Check the email address." :
      !$("#res-consent").checked ? "Confirm they've agreed to get parcel emails." : "";
    if (problem) {
      errEl.textContent = problem;
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;

    const btn = $("#add-res-btn");
    busy(btn, true, "Adding…");
    const { data, error } = await db
      .from("residents")
      .insert({ building_id: S.building.id, name, flat, email })
      .select(RES_FIELDS)
      .single();
    busy(btn, false);
    if (error) {
      errEl.textContent = error.code === "23505"
        ? "This email is already on that flat. If it's in New sign-ups to check, approve it there."
        : error.message;
      errEl.hidden = false;
      return;
    }
    S.residents.push(data);
    rebuildResMap();
    renderAll();
    e.target.reset();
    toast(`Added ${data.name} to Flat ${data.flat}.`);
  });

  async function removeResident(id) {
    const r = S.residents.find((x) => x.id === id);
    if (!r) return;
    const { error } = await db.from("residents").delete().eq("id", id);
    if (error) return toast(`Couldn't remove: ${error.message}`);
    S.residents = S.residents.filter((x) => x.id !== id);
    rebuildResMap();
    renderAll();
    toast(`Removed ${r.name} from Flat ${r.flat}.`, async () => {
      const { data, error: undoErr } = await db
        .from("residents")
        .insert({ building_id: S.building.id, name: r.name, flat: r.flat, email: r.email })
        .select(RES_FIELDS)
        .single();
      if (undoErr) return toast(`Couldn't undo: ${undoErr.message}`);
      S.residents.push(data);
      rebuildResMap();
      renderAll();
    });
  }

  $("#copy-link-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(signupUrl());
      toast("Link copied.");
    } catch {
      toast("Couldn't copy. Press and hold the link to copy it.");
    }
  });

  // ---------- Lobby poster ----------
  $("#poster-btn").addEventListener("click", () => {
    const url = signupUrl();
    $("#poster-building").textContent = S.building.name;
    $("#poster-url").textContent = url;
    try {
      const qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
      $("#poster-qr").innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
    } catch {
      $("#poster-qr").innerHTML = `<p style="color:#1D2433">The QR code couldn't load. Residents can type the link below.</p>`;
    }
    $("#poster").hidden = false;
  });
  $("#close-poster-btn").addEventListener("click", () => { $("#poster").hidden = true; });
  $("#print-btn")?.addEventListener("click", () => window.print());

  // ---------- Backups (CSV) ----------
  function csvCell(v) {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function downloadCsv(filename, rows) {
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  const ukDate = (iso) => (iso ? new Date(iso).toLocaleString("en-GB") : "");

  $("#export-res-btn").addEventListener("click", () => {
    downloadCsv(`residents-${stamp()}.csv`, [
      ["Flat", "Name", "Email", "Signed up", "Status"],
      ...S.residents.map((r) => [r.flat, r.name, r.email, ukDate(r.created_at), "Approved"]),
      ...S.pendingRes.map((r) => [r.flat, r.name, r.email, ukDate(r.created_at), "Waiting for approval"]),
    ]);
  });

  $("#export-parcels-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, "Preparing…");
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("parcels")
        .select("flat, code, carrier, size, note, created_at, notified_at, reminded_at, collected_at")
        .order("created_at", { ascending: false })
        .range(from, from + 999);
      if (error) { busy(btn, false); return toast(`Couldn't download: ${error.message}`); }
      all.push(...data);
      if (data.length < 1000) break;
    }
    busy(btn, false);
    downloadCsv(`parcel-log-${stamp()}.csv`, [
      ["Flat", "Code", "Carrier", "Size", "Note", "Arrived", "Emailed", "Reminded", "Collected"],
      ...all.map((p) => [p.flat, p.code, p.carrier, p.size, p.note,
        ukDate(p.created_at), ukDate(p.notified_at), ukDate(p.reminded_at), ukDate(p.collected_at)]),
    ]);
  });

  // ---------- Click handling ----------
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) {
      const on = chip.getAttribute("aria-pressed") === "true";
      chip.parentElement.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
      chip.setAttribute("aria-pressed", String(!on));
      return;
    }
    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) return setTab(tabBtn.dataset.tab);

    const sug = e.target.closest("[data-flat]:not([data-action])");
    if (sug) {
      $("#flat-input").value = sug.dataset.flat;
      renderFlatHint();
      $("#flat-input").focus();
      return;
    }

    const act = e.target.closest("[data-action]");
    if (!act) return;
    const action = act.dataset.action;
    if (action === "collect") {
      const p = S.parcels.find((x) => x.id === act.dataset.id);
      markCollected([act.dataset.id], p ? `Flat ${p.flat}: code ${p.code} collected.` : "Marked collected.");
    } else if (action === "collect-flat") {
      const ids = S.parcels.filter((p) => p.flat === act.dataset.flat).map((p) => p.id);
      markCollected(ids, `Flat ${act.dataset.flat}: ${ids.length} parcels collected.`);
    } else if (action === "remind") {
      sendEmails("remind", act);
    } else if (action === "remove-res") {
      removeResident(act.dataset.id);
    } else if (action === "approve-res") {
      approveResident(act.dataset.id);
    } else if (action === "reject-res") {
      rejectResident(act.dataset.id);
    }
  });

  // Keep multiple desk devices in sync
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.building) loadAll();
  });
  setInterval(() => {
    if (document.visibilityState === "visible" && S.building) loadAll();
  }, 2 * 60 * 1000);

  db.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" && S.user) location.reload();
    if (event === "PASSWORD_RECOVERY" && session && $("#screen-password").hidden) {
      setTimeout(() => showPasswordScreen("recovery", session.user), 0);
    }
  });

  start();
})();
