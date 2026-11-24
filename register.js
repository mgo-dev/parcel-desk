// Parcel Desk: resident sign-up page
(async () => {
  const $ = (s) => document.querySelector(s);
  const status = $("#status");
  const CFG = window.PARCEL_CONFIG || {};
  const code = new URLSearchParams(location.search).get("b");

  if (!window.supabase) { status.textContent = "This page couldn't load. Check your internet connection and refresh."; return; }
  if (!code) { status.textContent = "This sign-up link is incomplete. Scan the QR code in your building's lobby again, or ask the concierge for the link."; return; }

  const db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const { data, error } = await db.rpc("building_info", { p_code: code });
  if (error || !data || !data.length) {
    status.textContent = "This sign-up link isn't recognised. Scan the QR code in your building's lobby again, or ask the concierge for the link.";
    return;
  }
  const b = data[0];
  $("#building").textContent = b.name;
  document.querySelectorAll(".bname").forEach((el) => { el.textContent = b.name; });
  if (b.contact_email) {
    const a = document.createElement("a");
    a.href = "mailto:" + b.contact_email;
    a.textContent = b.contact_email;
    $("#contact").replaceChildren(a);
  }
  document.title = `Parcel emails, ${b.name}`;
  status.hidden = true;
  $("#form").hidden = false;

  $("#form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#name").value.trim();
    const flat = $("#flat").value.trim().replace(/\s+/g, " ").toUpperCase();
    const email = $("#email").value.trim().toLowerCase();
    const err = $("#error");
    const problem =
      name.length < 2 ? "Enter your full name." :
      !flat ? "Enter your flat number." :
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? "Check your email address. It should look like name@example.com." :
      !$("#consent").checked ? "Tick the box to agree to parcel emails." : "";
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    err.hidden = true;

    const btn = $("#submit");
    btn.disabled = true; btn.textContent = "Signing up…";
    const res = await db.rpc("register_resident", { p_code: code, p_name: name, p_flat: flat, p_email: email });
    btn.disabled = false; btn.textContent = "Sign up for parcel emails";

    const messages = {
      busy: "Sign-ups are paused for now because a lot are waiting to be checked. Ask the concierge desk to add you.",
      invalid_name: "Enter your full name.",
      invalid_flat: "Enter your flat number.",
      invalid_email: "Check your email address.",
      unknown_building: "This sign-up link isn't recognised. Ask the concierge for a new one.",
    };
    if (res.error || res.data !== "ok") {
      err.textContent = res.error ? "Sign-up didn't go through. Check your connection and try again." : (messages[res.data] || "Sign-up didn't go through. Try again.");
      err.hidden = false;
      return;
    }
    $("#form").hidden = true;
    $("#done-text").textContent = `The concierge will check your details. Once they're confirmed, we'll email ${email} with a collection code whenever a parcel arrives for Flat ${flat}.`;
    $("#done").hidden = false;
    window.scrollTo(0, 0);
  });
})();
