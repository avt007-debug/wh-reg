# WH Reg — Multi-Warehouse Inventory & Dispatch

Expo (React Native) mobile app on a **Supabase** backend, built, tested and deployed with **GitHub Actions**.

What it covers:
- manual, typo-tolerant item search with local names (no barcodes)
- carton/box/piece units
- GST-correct inward and outward
- Admin Override PIN
- inter-warehouse transfer notes
- an owner dashboard
- WhatsApp dispatch alerts and an 8:30 PM digest

**Website:** every push to `main` publishes the app to GitHub Pages
(`https://<github-username>.github.io/<repo>/`) via `.github/workflows/website.yml`, connected to the
live Supabase project `wh-reg` (Mumbai).

| Doc | Inside |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System diagram, security model (roles, grants, RLS), data model, repo layout, RPC list |
| [docs/ROADMAP.md](docs/ROADMAP.md) | GitHub repo → local Supabase → app → production project → WhatsApp → data → release |
| [docs/WHATSAPP.md](docs/WHATSAPP.md) | Meta setup, the two template texts, secrets, Vault, webhook, troubleshooting |

## Quick start (local, needs Docker + Supabase CLI)
```bash
pnpm install && pnpm --filter @wh/shared build
supabase start && supabase db reset        # migrations + dev seed
pnpm db:test                               # 90 database checks
cp apps/mobile/.env.example apps/mobile/.env   # fill URL + publishable key from `supabase status`
pnpm app                                   # Expo; scan QR with Expo Go
```
Dev logins (password `ChangeMe@123`): `owner` (PIN `246810`), `ravi.wha` (Warehouse A), `kumar.whb` (Warehouse B).

## Repository
```
.github/workflows/  ci.yml · deploy.yml · mobile.yml
supabase/           config.toml · migrations/ · seed.sql · functions/ · tests/
packages/shared/    GST, units, GSTIN, form schemas (+ tests)
apps/mobile/        Expo Router app (staff + owner areas)
docs/
```

## Tests
| Command | What |
|---|---|
| `pnpm db:test` | migrations + seed + 90 RLS/business checks on local Supabase |
| `pnpm db:test:plain` | same suite on any plain Postgres (`ADMIN_URL=…`), no Docker |
| `pnpm --filter @wh/shared test` | GST / UoM / GSTIN unit tests |
| `pnpm functions:check && pnpm functions:test` | Edge Functions type-check + unit tests (Deno) |
