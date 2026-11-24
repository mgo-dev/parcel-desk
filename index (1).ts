// Parcel Desk: "notify" function
// Sends parcel emails through Brevo. Called from the staff app.
//   { mode: "notify" }  -> emails residents about parcels not yet announced
//   { mode: "remind" }  -> reminds residents about parcels waiting 3+ days
//
// Secrets needed (Supabase > Edge Functions > Secrets):
//   BREVO_API_KEY   your Brevo API key
//   SENDER_EMAIL    the sender address you verified in Brevo
//   SENDER_NAME     optional, e.g. "Riverside House Concierge"

import { createClient } from "npm:@supabase/supabase-js@2";

const REMIND_AFTER_DAYS = 3;
const REMIND_STOP_DAYS = 9; // no reminders after this, so at most 2 per parcel (day 3 and day 6)
const KEEP_COLLECTED_DAYS = 90; // collected parcels are deleted after this
const KEEP_UNAPPROVED_DAYS = 30; // sign-ups nobody approved are deleted after this
const DAY = 24 * 60 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]
  );

const ukTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // Server-only key: works with both Supabase key systems (legacy and new)
  let serverKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serverKey) {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      serverKey = keys.default || Object.values(keys)[0] || "";
    } catch { /* handled below */ }
  }
  if (!serverKey) return json({ error: "The function can't find its server key. Check Supabase settings." }, 500);

  // deno-lint-ignore no-explicit-any
  const admin: any = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serverKey as string,
    { auth: { persistSession: false } },
  );

  // 1. Who is calling? Must be a signed-in staff member.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "Please sign in again." }, 401);

  const { data: staff } = await admin
    .from("staff")
    .select("building_id, buildings(name, contact_email)")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (!staff) return json({ error: "This account isn't linked to a building." }, 403);
  const building = Array.isArray(staff.buildings) ? staff.buildings[0] : staff.buildings;

  // 2. Email settings
  const apiKey = Deno.env.get("BREVO_API_KEY");
  const senderEmail = Deno.env.get("SENDER_EMAIL");
  if (!apiKey || !senderEmail) {
    return json({ error: "Email isn't set up yet. Add BREVO_API_KEY and SENDER_EMAIL in Supabase secrets." }, 500);
  }
  const sender = { email: senderEmail, name: Deno.env.get("SENDER_NAME") || `${building.name} Concierge` };

  let mode = "notify";
  try {
    const body = await req.json();
    if (body?.mode === "remind") mode = "remind";
  } catch { /* no body: default to notify */ }

  // 3. Which parcels?
  const now = new Date();
  let query = admin
    .from("parcels")
    .select("id, flat, code, carrier, size, note, created_at")
    .eq("building_id", staff.building_id)
    .is("collected_at", null)
    .order("created_at");

  if (mode === "remind") {
    const cutoff = new Date(now.getTime() - REMIND_AFTER_DAYS * DAY).toISOString();
    const stopAt = new Date(now.getTime() - REMIND_STOP_DAYS * DAY).toISOString();
    query = query
      .lt("created_at", cutoff)
      .gt("created_at", stopAt)
      .not("notified_at", "is", null)
      .or(`reminded_at.is.null,reminded_at.lt.${cutoff}`);
  } else {
    query = query.is("notified_at", null);
  }

  const { data: parcels, error: pErr } = await query;
  if (pErr) return json({ error: pErr.message }, 500);
  if (!parcels?.length) return json({ sent: 0, parcels: 0, flatsWithoutEmail: [], failedFlats: [] });

  const flats: string[] = [...new Set<string>(parcels.map((p: { flat: string }) => p.flat))];
  const { data: residents, error: rErr } = await admin
    .from("residents")
    .select("name, email, flat")
    .eq("building_id", staff.building_id)
    .not("approved_at", "is", null) // only residents the concierge has approved
    .in("flat", flats);
  if (rErr) return json({ error: rErr.message }, 500);

  const byFlat = new Map<string, { name: string; email: string }[]>();
  for (const r of residents ?? []) {
    if (!byFlat.has(r.flat)) byFlat.set(r.flat, []);
    byFlat.get(r.flat)!.push(r);
  }

  // 4. Send one email per resident, listing all their flat's parcels
  let sent = 0;
  let lastError = "";
  const doneIds: string[] = [];
  const flatsWithoutEmail: string[] = [];
  const failedFlats: string[] = [];

  for (const flat of flats) {
    const flatParcels = parcels.filter((p: { flat: string }) => p.flat === flat);
    const people = byFlat.get(flat) ?? [];
    if (!people.length) {
      flatsWithoutEmail.push(flat);
      continue;
    }
    let anySent = false;
    for (const person of people) {
      const { subject, html, text } = buildEmail(mode, person.name, flat, flatParcels, building);
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender,
          to: [{ email: person.email, name: person.name }],
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });
      if (res.ok) {
        sent++;
        anySent = true;
      } else {
        lastError = `Brevo said: ${res.status} ${await res.text()}`;
        console.error(lastError);
      }
    }
    if (anySent) doneIds.push(...flatParcels.map((p: { id: string }) => p.id));
    else failedFlats.push(flat);
  }

  if (doneIds.length) {
    const stamp = now.toISOString();
    await admin
      .from("parcels")
      .update(mode === "remind" ? { reminded_at: stamp } : { notified_at: stamp })
      .in("id", doneIds);
  }

  // 5. Housekeeping for this building:
  //    delete parcels collected more than 90 days ago,
  //    and sign-ups nobody approved within 30 days
  await admin
    .from("parcels")
    .delete()
    .eq("building_id", staff.building_id)
    .lt("collected_at", new Date(now.getTime() - KEEP_COLLECTED_DAYS * DAY).toISOString());
  await admin
    .from("residents")
    .delete()
    .eq("building_id", staff.building_id)
    .is("approved_at", null)
    .lt("created_at", new Date(now.getTime() - KEEP_UNAPPROVED_DAYS * DAY).toISOString());

  if (!sent && failedFlats.length) return json({ error: lastError || "Emails couldn't be sent." }, 502);
  return json({ sent, parcels: doneIds.length, flatsWithoutEmail, failedFlats });
});

type Parcel = { code: string; carrier: string | null; size: string | null; note: string | null; created_at: string };

function buildEmail(
  mode: string,
  fullName: string,
  flat: string,
  parcels: Parcel[],
  building: { name: string; contact_email: string | null },
) {
  const first = (fullName || "").trim().split(/\s+/)[0] || "there";
  const n = parcels.length;
  const many = n > 1;
  const remind = mode === "remind";

  const subject = remind
    ? `Reminder: ${many ? `${n} parcels are` : "your parcel is"} waiting at reception`
    : `${many ? `${n} parcels are` : "Your parcel is"} ready to collect`;

  const intro = remind
    ? `Just a reminder that ${many ? `${n} parcels for Flat ${flat} are` : `a parcel for Flat ${flat} is`} still waiting at the concierge desk at ${building.name}.`
    : `${many ? `${n} parcels have` : "A parcel has"} arrived for Flat ${flat} and ${many ? "are" : "is"} ready to collect from the concierge desk at ${building.name}.`;

  const contact = building.contact_email || "the concierge desk";

  const rows = parcels.map((p) => {
    const details = [p.carrier, p.size, p.note].filter(Boolean).join(", ");
    return `<tr>
      <td style="padding:12px 16px;border-top:1px solid #DCE0E6;font-size:24px;font-weight:700;letter-spacing:2px;color:#1D2433">${esc(p.code)}</td>
      <td style="padding:12px 16px;border-top:1px solid #DCE0E6;color:#4A5366;font-size:14px">${esc(details || "Parcel")}<br>Arrived ${esc(ukTime(p.created_at))}</td>
    </tr>`;
  }).join("");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F3F4F7">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1D2433">
    <div style="height:8px;background:#F5C518"></div>
    <div style="padding:24px 24px 8px">
      <p style="margin:0 0 12px">Hi ${esc(first)},</p>
      <p style="margin:0 0 20px">${esc(intro)}</p>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:0 16px 6px;font-size:13px;color:#4A5366">Collection code</td><td style="padding:0 16px 6px;font-size:13px;color:#4A5366">Details</td></tr>
      ${rows}
    </table>
    <div style="padding:20px 24px 24px">
      <p style="margin:0">Please show your collection code when you pick up.</p>
      <p style="margin:24px 0 0;font-size:12px;color:#6B7385">You're getting this because you signed up for parcel emails at ${esc(building.name)}. To change or remove your details, contact ${esc(contact)}.</p>
    </div>
  </div></body></html>`;

  const text = [
    `Hi ${first},`,
    "",
    intro,
    "",
    ...parcels.map((p) =>
      `Collection code ${p.code}: ${[p.carrier, p.size, p.note].filter(Boolean).join(", ") || "Parcel"}, arrived ${ukTime(p.created_at)}`
    ),
    "",
    "Please show your collection code when you pick up.",
    "",
    `You're getting this because you signed up for parcel emails at ${building.name}. To change or remove your details, contact ${contact}.`,
  ].join("\n");

  return { subject, html, text };
}
