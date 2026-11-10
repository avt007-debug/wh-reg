# Implementation Roadmap — GitHub + Supabase, from zero to go-live

Each phase ends with a check. Estimates assume one developer.

> **Start Meta Business verification on day 1.** It runs in parallel and is usually the slowest
> dependency (Phase 5).

---

## Phase 0 — Accounts & tools (½ day)
- [ ] **GitHub**: create a **private** repository (e.g. `wh-reg`).
- [ ] **Supabase**: create an organisation and a project in **Mumbai (ap-south-1)**. Save the database password.
  - Use the Pro plan for production. Free projects pause after a week without activity, which would also pause the 8:30 PM digest.
- [ ] **Expo**: create an account at expo.dev (cloud builds).
- [ ] **Meta**: business.facebook.com → start **Business Verification**; get a dedicated WhatsApp number.
- [ ] On your PC: Node 22 LTS, pnpm (`corepack enable`), Git, **Docker Desktop**, Supabase CLI (`scoop install supabase` on Windows, `brew install supabase/tap/supabase` on macOS), Deno 2.
  - On Windows, run the `*.sh` scripts from **Git Bash** or **WSL**.

## Phase 1 — Put the code on GitHub (½ hour)
```bash
cd "WH Reg"
git init -b main            # skip if the folder already has .git
git add -A && git commit -m "WH Reg: Supabase + Expo scaffold"
git remote add origin https://github.com/<you>/wh-reg.git
git push -u origin main
```
Then in GitHub → **Settings → Secrets and variables → Actions**:

| Name | Type | Value |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | secret | supabase.com/dashboard/account/tokens |
| `SUPABASE_DB_PASSWORD` | secret | the project's database password |
| `SUPABASE_PROJECT_ID` | variable | project ref (the `xxxx` in `xxxx.supabase.co`) |
| `EXPO_TOKEN` | secret | expo.dev → Account → Access tokens |

Optionally create **Settings → Environments → `production`** with yourself as required reviewer, so every deploy waits for your click.

✅ **Check:** the **CI** workflow runs green on the first push (app tests, Edge Function tests, and the full database suite on a real local Supabase stack).

## Phase 2 — Local Supabase (1 day)
```bash
pnpm install && pnpm --filter @wh/shared build
supabase start                   # Postgres, Auth, Storage, REST, Studio on localhost (Docker)
supabase db reset                # applies migrations + seed.sql
pnpm db:test                     # → ✓ ALL DATABASE TESTS PASSED
```
Open Studio at http://127.0.0.1:54323. Explore `users`, `products` and `inventory_levels`, and
notice there's no `fin` schema in the API docs.

Edge Functions locally:
```bash
cp supabase/functions/.env.example supabase/functions/.env     # keep WA_DRY_RUN=true
pnpm functions:serve
curl -X POST http://127.0.0.1:54321/functions/v1/whatsapp-relay -H "x-relay-secret: <RELAY_SECRET>"
```
✅ **Check:** the relay logs `[whatsapp:dry-run]` messages for queued dispatch alerts.

## Phase 3 — App against local Supabase (2–4 days)
```bash
cp apps/mobile/.env.example apps/mobile/.env
#   EXPO_PUBLIC_SUPABASE_URL=http://<your-PC-LAN-IP>:54321
#   EXPO_PUBLIC_SUPABASE_KEY=<publishable key printed by `supabase status`>
pnpm app                         # scan the QR code with Expo Go on an Android phone
```
- [ ] Log in as `ravi.wha` / `ChangeMe@123`. Search "pana", then outward 40 drills. The PIN sheet appears; enter PIN `246810` and the invoice saves.
- [ ] Log in as `owner`. Check the dashboard and reorder screens, then Purchases → add a 3% discount and watch the net cost change. On Team, create a staff login.

✅ **Check:** a staff login never shows a ₹ cost; owner screens show valuation, margins and staff performance.

## Phase 4 — Production Supabase project (½ day)
1. **Deploy the backend.** Push to `main` (or run **Actions → Deploy to Supabase**). This runs CI → `supabase db push --remote` → `supabase functions deploy`.
   - Run it once manually with **push_config = true** to apply `config.toml` (sign-ups off, 10-character passwords).
2. **API keys:** Dashboard → Settings → API keys → use the **publishable** key in the app. The secret key stays server-side and is never in GitHub.
3. **First owner login** (one time, SQL editor):
   ```sql
   -- Create the Auth user in Dashboard → Authentication → Add user:
   --   email owner@staff.whreg.app, password <strong>, "Auto confirm" on. Then:
   insert into public.users (id, login_id, full_name, role)
   select id, 'owner', 'Your Name', 'OWNER' from auth.users where email = 'owner@staff.whreg.app';
   ```
   Every other login is created from the app's **Team** tab (`admin-users` function).
4. **Warehouses**: insert real rows (2–4 letter codes, GSTIN, state code) in Studio.
5. **Set your Override PIN** from Team → "My Admin Override PIN".

✅ **Check:** owner can log into the production build; `select * from cron.job;` shows `whreg-eod-digest` and `whreg-whatsapp-retry`.

## Phase 5 — WhatsApp (2–3 days + Meta review)
Follow [`WHATSAPP.md`](./WHATSAPP.md): register the number → submit the 2 **utility** templates →
set function secrets → create the 2 Vault secrets → set the webhook URL → `WA_DRY_RUN=false`.

✅ **Check:** a test dispatch sends a WhatsApp to the owner within seconds. The Team tab shows it as `SENT → DELIVERED`, and the 8:30 PM digest arrives once.

## Phase 6 — Real master data (1–2 weeks, mostly business-side)
1. **Catalogue** spreadsheet: SKU, name, brand, category path, specification, HSN, GST %, base unit, pack sizes (BOX = 12, CTN = 120…), list price, reorder level. Import CSVs with Studio's Table Editor (`brands` → `categories` → `products` → `product_uoms`).
2. **Local names**: collect the 2–3 words customers actually use per item, and enter them as `product_aliases`. Staff can also add them later by long-pressing a search result.
3. **Photos**: upload to the `product-images` bucket, then add `product_images` rows.
4. **Vendors & dealers** with GSTINs (typos are caught by the checksum).
5. **Opening stock**: do a physical count per warehouse on the cut-over day, then post it with `owner_adjust_stock(..., 'OPENING', qty)` or bulk SQL.

✅ **Check:** the owner's stock overview matches the count sheets line by line.

## Phase 7 — App release (2–3 days)
1. expo.dev → project → **Environment variables** (`preview` and `production`): `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_KEY`, `EXPO_PUBLIC_LOGIN_EMAIL_DOMAIN`.
2. GitHub → **Actions → Mobile build → preview**: produces an installable APK for testing phones.
3. **production** produces an AAB for Play Console (internal testing track), or distribute the APK through your device management for company phones.

## Phase 8 — Hardening & rollout (2–4 weeks)
| Item | Why |
|---|---|
| Offline drafts (SQLite queue keyed by `clientTxnId`) | weak warehouse signal. Stock is still checked on the server. |
| Partial-receipt screen for transfers | the RPC already accepts per-line received quantities |
| GST invoice PDF + share to customer | printable invoice |
| PO PDF to vendor from the reorder screen | completes one-click PO |
| Supabase **Branching** (GitHub integration) | every PR gets its own preview database |
| Point-in-time recovery, Sentry for app + functions | operations |
| Pilot one warehouse with paper in parallel for a week | reconcile daily before full go-live |
| Weekly cycle counts of the top 50 SKUs → `owner_adjust_stock(..., 'ADJUST_AUDIT')` | keeps stock accurate |

## Day-to-day development loop
```
branch → change SQL in supabase/migrations (new file: `supabase migration new <name>`)
       → `supabase db reset && pnpm db:test`
       → push & open PR → CI must be green
       → merge to main → Deploy workflow → (approve) → live on Supabase
```
Never edit a migration that has already been deployed. Add a new one instead.
