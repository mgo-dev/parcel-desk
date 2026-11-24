# Parcel Desk: setup guide

About an hour from start to finish. Everything here runs on free plans. Steps marked 🔒 are security settings: don't skip them.

**What's in this folder**

| File | What it does |
|---|---|
| `index.html`, `app.js`, `style.css` | The concierge app (log parcels, mark collected, approve and manage residents) |
| `register.html`, `register.js` | The page residents use to sign up |
| `config.js` | Where you paste your Supabase details |
| `vendor/` | Copies of the two libraries the app uses, so it never loads code from other websites |
| `manifest.json`, `icon-*.png` | Lets staff add the app to their phone's home screen |
| `supabase/schema.sql` | Creates the database and its security rules |
| `supabase/functions/notify/index.ts` | Sends the emails through Brevo |
| `.github/workflows/keep-alive.yml` | Daily ping so Supabase never pauses |
| `.gitignore` | Stops backup files from being uploaded to GitHub by accident |

---

## 0. 🔒 Protect your accounts first

You'll create (or use) three accounts: GitHub, Supabase and Brevo. Anyone who gets into one of them gets into your residents' data, so for each:

- use a long, unique password (a password manager helps)
- turn on two-step verification in the account's security settings

## 1. Create the database (Supabase)

1. Sign up at supabase.com and create a new project. 🔒 Pick the **London** region so residents' data stays in the UK. Save the database password somewhere safe.
2. Open **SQL Editor**, click **New query**, paste everything from `supabase/schema.sql` and click **Run**. You should see "Success". It's safe to run again if you ever need to.

## 2. 🔒 Switch off public account creation

By default, Supabase lets anyone create a login for your project. Those logins can't see any data (the security rules block them), but there's no reason to allow them.

1. Go to **Authentication > Sign In / Providers**.
2. Turn off **Allow new users to sign up** and save.
3. If you see a **minimum password length** option under the Email provider, set it to 12.

You'll still be able to create concierge logins yourself in step 4.

## 3. Add your building

In the SQL Editor, run this with your own details. The code goes into the residents' sign-up link, so make it hard to guess (building name plus a few random letters and numbers):

```sql
insert into buildings (name, code, contact_email)
values ('Riverside House', 'RIVERSIDE-7Q4K', 'concierge@yourbuilding.co.uk');
```

The contact email is shown to residents for questions or removal requests.

## 4. Create the concierge login

1. Go to **Authentication > Users > Add user > Create new user**. Enter the desk email and a password of at least 12 characters, and tick **Auto Confirm User**.
2. Link that login to your building in the SQL Editor (use the same email and code as above):

```sql
insert into staff (user_id, building_id, name)
select u.id, b.id, 'Front desk'
from auth.users u, buildings b
where u.email = 'desk@yourbuilding.co.uk' and b.code = 'RIVERSIDE-7Q4K';
```

Repeat for each staff member, or let the team share one desk login. 🔒 When someone leaves, delete their login on the Users page (or change the shared password).

## 5. Set up email (Brevo)

1. Sign up at brevo.com (free plan: 300 emails a day).
2. Add and verify a sender address (Brevo sends a confirmation email). An address on a domain you own lands in inboxes far more reliably than a Gmail or Hotmail address.
3. Create an API key in Brevo's **SMTP & API** settings and copy it. 🔒 Only ever paste it into Supabase secrets (next step), never into a file.

## 6. Add the email function (Supabase)

1. In Supabase, go to **Edge Functions > Deploy a new function > Via editor**.
2. Name it exactly `notify`, replace the sample code with everything from `supabase/functions/notify/index.ts`, and deploy.
3. In the Edge Functions **Secrets** page, add:
   - `BREVO_API_KEY`: the key from step 5
   - `SENDER_EMAIL`: the sender address you verified
   - `SENDER_NAME`: optional, e.g. `Riverside House Concierge`

## 7. Connect the app

1. In Supabase, open **Project Settings > API Keys** (or **API**). Copy the **Project URL** and the **publishable** (or **anon**) key.
2. Paste them into `config.js`.

The publishable/anon key is designed to be public: the security rules protect your data. 🔒 Never put the **secret** or **service_role** key in any file. If you ever do by mistake, create a new one in Supabase straight away so the old one stops working.

## 8. Put it online (GitHub Pages)

1. Upload all files to your GitHub repository, keeping the folder structure. Make sure `.gitignore` and the `vendor` and `.github` folders are included.
2. Go to **Settings > Pages**, choose **Deploy from a branch**, select `main` and `/ (root)`, and save.
3. 🔒 On the same page, tick **Enforce HTTPS** once it's available.
4. After a minute your app is live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

## 9. Keep it awake

In the repository, go to **Settings > Secrets and variables > Actions** and add:

- `SUPABASE_URL`: your Project URL
- `SUPABASE_KEY`: your publishable/anon key

Then open the **Actions** tab, pick **Keep Supabase awake** and click **Run workflow**. A green tick means it works.

## 10. Test it end to end

1. Open the app and sign in with the desk login.
2. Go to **Residents**, open the sign-up link and register yourself.
3. Back in the app, your sign-up appears under **New sign-ups to check**. Tap **Approve**.
4. Log a parcel for your flat, then tap **Send emails**. Check your inbox (and spam folder).
5. Go to **Waiting**, find the parcel and tap **Collected**.

When it works, tap **Show lobby poster**, print it and put it up near the entrance and the lifts.

---

## Day-to-day use

- **New sign-ups:** a yellow number on the **Residents** tab means people are waiting to be checked. 🔒 Approve only people you know live in that flat; reject anything you don't recognise. Unapproved sign-ups get no emails and are deleted after 30 days.
- **Log parcel:** type the flat, tap the carrier if you like, press Enter or **Log parcel**. The carrier stays selected, so a pile from the same courier is quick.
- **Send emails:** parcels wait in the dark bar at the bottom until you tap **Send emails**. Each approved resident gets one email listing all their parcels and collection codes.
- **Collection:** ask for the code from the email and search it in **Waiting**. 🔒 Check the person's name matches one of the names shown for that flat before tapping **Collected**. Every action has an Undo for a few seconds.
- **Reminders:** after 3 days, a **Send reminders** button appears in **Waiting**.
- **Move-outs:** remove the resident in **Residents**.
- **Backups:** download both CSV files weekly from **Residents**. 🔒 Keep them somewhere private, never in GitHub or a shared folder.
- **Shared devices:** the desk login stays signed in on the desk phone or tablet. 🔒 If you sign in on a personal or shared computer, tap **Sign out** when you're done.
- **Phone app:** open the site on the desk phone and choose **Add to Home Screen**.

Collected parcels are deleted automatically after 90 days.

## How residents' data is protected

- Residents can only add themselves. They can never see the list, and the sign-up page doesn't reveal whether someone is already registered.
- New sign-ups get no emails until the concierge approves them, so nobody can add their own email to a neighbour's flat to get their collection codes.
- Each building's staff can only see and change their own building's residents and parcels.
- The app records which login logged, approved and collected each item, and that can't be faked from the app.
- The pages refuse to run code from anywhere except your own site, which blocks the most common kind of web attack.
- Sign-ups are capped (5 waiting per flat, 100 per building) to stop someone flooding the list.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Add your Supabase project URL and key to config.js" | Fill in `config.js` and upload it again |
| "This login isn't linked to a building yet" | Run the SQL in step 4 with the right email and code |
| "Emails weren't sent. Email isn't set up yet" | Add the secrets in step 6 |
| "Emails weren't sent" with "Invalid JWT" | In the `notify` function settings, turn off **Verify JWT** and try again. It's safe: the function checks the login itself |
| "Brevo said: 401" | The Brevo API key is wrong; create a new one |
| "Brevo said: 400" with a sender message | The sender email isn't verified in Brevo |
| Emails land in spam | Use a sender on your own domain and set up the domain authentication Brevo offers |
| Residents see "Sign-ups are paused for now" | Too many sign-ups are waiting. Approve or reject them in **Residents** |
| You think a key or password has leaked | Change the password, or create a new key in Supabase or Brevo and update it where it's used |

## Adding another building later

Repeat steps 3 and 4 with the new building's name, code and staff logins. Each building's staff only ever see their own residents and parcels.
