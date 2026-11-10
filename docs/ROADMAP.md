# Implementation Roadmap — local database to production

Each phase ends with a check you can run. Estimates assume one full-stack developer.

> **Start Meta Business verification on day 1.** It runs in parallel and is usually the
> slowest dependency for the WhatsApp alerts (Phase 5).

---

## Phase 0 — Prerequisites (½ day)
- [ ] Install Node 22 LTS, pnpm 10 (`corepack enable`), Docker Desktop, Git.
- [ ] An Android phone with **Expo Go** (for early testing) and USB debugging (for dev builds later).
- [ ] Create a Meta Business account, start **business verification**, and get a dedicated phone number for WhatsApp (not one already on the WhatsApp app).
- [ ] Decide hosting region: India (Mumbai, `ap-south-1`) keeps latency low and data in-country.

## Phase 1 — Local database (1 day)
```bash
cp .env.example .env
docker compose up -d db minio
export DATABASE_URL=postgres://migrator:migrator@localhost:5432/whreg
APP_API_PASSWORD=app_api_dev_password ./db/migrate.sh --seed
ADMIN_URL=postgres://migrator:migrator@localhost:5432/postgres ./db/test.sh
```
✅ **Check:** test run ends with `✓ ALL DATABASE TESTS PASSED`.

Then explore as each role to build intuition:
```sql
SET ROLE app_employee; SELECT set_config('app.user_id','00000000-0000-0000-0000-000000000010',false);
SELECT * FROM inventory_levels;          -- WHA only
SELECT * FROM fin.v_stock_overview;      -- ERROR: permission denied for schema fin
```

## Phase 2 — API locally (1–2 days)
```bash
pnpm install
pnpm --filter @wh/shared build
pnpm --filter @wh/api dev            # http://localhost:4000/health
pnpm --filter @wh/api dev:worker     # WA_DRY_RUN=true logs messages instead of sending
API_URL=http://localhost:4000 node apps/api/scripts/smoke.mjs
pnpm test                            # shared + API unit tests
```
✅ **Check:** `✓ ALL SMOKE CHECKS PASSED`, and the worker logs a `[whatsapp:dry-run]` dispatch alert.

Create the MinIO bucket `whreg-uploads` at http://localhost:9001 (minio / minio12345).

## Phase 3 — Mobile app locally (2–4 days)
```bash
# EXPO_PUBLIC_API_URL must be your PC's LAN IP, reachable from the phone
EXPO_PUBLIC_API_URL=http://192.168.1.10:4000 pnpm --filter @wh/mobile start
```
- [ ] Scan the QR code with Expo Go; log in as `ravi.wha` / `ChangeMe@123`.
- [ ] Walk through: search "pana" → outward 40 drills → see the PIN sheet → PIN `246810` → invoice saved.
- [ ] Log in as `owner` → dashboard, reorder, purchases → add a 3% discount → net cost changes.
- [ ] Run `pnpm --filter @wh/mobile align` after any Expo SDK upgrade.

✅ **Check:** staff account never shows a ₹ cost; owner sees valuation, margins, staff performance.

## Phase 4 — Your real master data (1–2 weeks, mostly business-side)
1. **Warehouses**: codes (2–4 letters, used in invoice numbers), GSTIN, state code.
2. **Catalogue** as a spreadsheet: SKU code, name, brand, category path (`Power Tools > Drills`), specification, HSN, GST %, base unit, pack sizes (BOX = 12, CTN = 120…), list selling price, reorder level. Write a one-off CSV importer (`apps/api/scripts/import-catalog.ts`) that runs as the owner session.
3. **Local names**: collect from floor staff the 2–3 words customers actually use per item ("pana", "pechkas", "gitti"). This decides whether search is fast or frustrating.
4. **Photos**: one clear photo per item on a plain background. Upload, then insert `product_images`.
5. **Parties**: vendors and dealers with GSTINs (the checksum validator catches typos).
6. **Users**: one login per person (no shared logins, or staff performance is meaningless). Each owner sets a PIN via `PUT /v1/owner/override-pin`.
7. **Opening stock**: do a **physical count per warehouse on a cut-over day**, then post it as `OPENING` stock adjustments. Never copy figures from old registers without counting.

✅ **Check:** owner stock overview matches the physical count sheet line by line.

## Phase 5 — WhatsApp integration (2–3 days + Meta review time)
Follow [`WHATSAPP.md`](./WHATSAPP.md): register number → create the 2 **utility** templates → get approval → set env → configure webhook → turn off `WA_DRY_RUN`.

✅ **Check:** a test dispatch produces a WhatsApp on the owner's phone within seconds; the outbox row moves `PENDING → SENT → DELIVERED`; the 8:30 PM digest arrives once (not once per server).

## Phase 6 — Hardening before go-live (1–2 weeks)
| Item | Why |
|---|---|
| Offline drafts (SQLite queue keyed by `client_txn_id`) | Warehouses often have weak signal; drafts sync when back online. Stock checks still happen on the server. |
| Partial-receipt screen for transfer notes | API already supports per-line received quantities |
| GST invoice PDF + share to customer WhatsApp | Printable invoice from the dispatch |
| PO PDF to vendor from the reorder screen | Completes the one-click PO flow |
| Owner screens for users, warehouses, reorder levels, cancellations | APIs exist; build the UI |
| Owner entering inward/outward with a warehouse picker | API accepts `warehouseId` from owners |
| Error monitoring (Sentry for app + API), structured logs | Know about failures before staff call you |
| Rate limits & lockouts reviewed; dependency audit (`pnpm audit`) | Security baseline |
| Load test: 20 concurrent dispatches of the same SKU | Confirms row-locking prevents overselling |

## Phase 7 — Production deployment (3–5 days)
1. **Database**: managed Postgres 16 in Mumbai (e.g. AWS RDS, Azure Flexible Server, Supabase, Neon). Enable point-in-time recovery and daily snapshots; restrict network access to the API's egress.
   - Create a `migrator` role that owns the schema; run `./db/migrate.sh` from CI with `APP_API_PASSWORD` from the secrets store. **Never run `--seed` in production.**
   - Confirm `app_api` is NOT a superuser and has no `BYPASSRLS`: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='app_api';`
2. **API + worker**: build `apps/api/Dockerfile`; deploy two services from one image (`node dist/server.js` and `node dist/jobs/worker.js`) on ECS / Cloud Run / Render / Railway / Fly. Run ≥ 2 API replicas; the worker can scale too (SKIP LOCKED + dedupe keys make it safe).
3. **Secrets**: `JWT_SECRET` (64 random bytes), DB password, WhatsApp token & app secret, S3 keys → a secrets manager, never in the repo.
4. **Storage**: private S3/R2 bucket in-region, lifecycle rule to move receipts > 1 year to cheaper storage.
5. **TLS + domain**: `api.yourdomain.in` behind a load balancer; set the WhatsApp webhook to `https://api.yourdomain.in/webhooks/whatsapp`.
6. **Mobile release**: `eas build -p android --profile production` → Play Console **internal testing** track (or direct APK via MDM for company phones) → set `EXPO_PUBLIC_API_URL` to production. Use EAS Update for JS-only fixes.
7. **CI pipeline**: on every PR → typecheck, unit tests, `db/test.sh` against a Postgres service container, smoke test; on `main` → migrate → deploy API/worker → publish OTA update.

✅ **Check:** production smoke test with a test warehouse, then delete the test data via owner cancellation.

## Phase 8 — Rollout (2–3 weeks)
1. **Pilot one warehouse** with paper running in parallel for 1 week; reconcile daily.
2. Train staff on 3 things only: search (aliases!), outward, inward. Give each person their own login.
3. Go live in the pilot warehouse, then the next ones a week apart.
4. **Weekly cycle counts** of the top 50 SKUs; post differences as `ADJUST_AUDIT`.
5. Review dead-stock and reorder screens every Monday; tune reorder levels per warehouse.

## Later options
- E-way bill & e-invoice (IRN) generation via a GSP API.
- Batch/FIFO costing, multiple price lists per dealer tier, credit-limit blocking at dispatch.
- Customer payment entry & receivables ageing on top of `fin.customer_payments`.
- Web dashboard for the owner (Expo Router builds for web from the same code).
- Barcode/QR labels printed from SKU codes if you ever want scanning later — the schema needs no change.
