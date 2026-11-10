# WH Reg — Multi-Warehouse Inventory & Dispatch

Cross-platform mobile app (Expo / React Native) + API (Fastify) + PostgreSQL for a hardware
distributor with several warehouses: manual high-speed item search (no barcodes), carton/box/piece
units, GST-correct inward and outward, Admin Override PIN, inter-warehouse transfer notes, an owner
executive dashboard, and WhatsApp dispatch + end-of-day alerts.

| Doc | What's inside |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System diagram, security model (RBAC + RLS), data model, folder structure, API list, interpretations of the brief |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Step-by-step: local DB → API → app → master data → WhatsApp → production → rollout |
| [docs/WHATSAPP.md](docs/WHATSAPP.md) | Meta setup, the two template texts to submit, webhook, retries, cost |
| `db/migrations/*.sql` | Complete PostgreSQL DDL, triggers, RLS policies, analytics |

## Quick start (local)
```bash
cp .env.example .env
docker compose up -d db minio
DATABASE_URL=postgres://migrator:migrator@localhost:5432/whreg APP_API_PASSWORD=app_api_dev_password ./db/migrate.sh --seed
pnpm install && pnpm --filter @wh/shared build
pnpm --filter @wh/api dev            # API on :4000
pnpm --filter @wh/api dev:worker     # WhatsApp worker (dry-run)
EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000 pnpm --filter @wh/mobile start
```
Dev logins (password `ChangeMe@123`): `owner` (PIN `246810`), `ravi.wha` (Warehouse A), `kumar.whb` (Warehouse B).

## Tests
```bash
ADMIN_URL=postgres://migrator:migrator@localhost:5432/postgres ./db/test.sh   # 60+ DB/RLS assertions
pnpm test                                                                    # GST/UoM/GSTIN + WhatsApp unit tests
API_URL=http://localhost:4000 node apps/api/scripts/smoke.mjs                # end-to-end HTTP
```
