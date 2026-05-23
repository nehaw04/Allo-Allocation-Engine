# Allo — Distributed Inventory & Reservation Engine

> A production-grade inventory reservation system solving the checkout race condition for multi-warehouse retail and D2C brands.

---

## The Problem

When a customer reaches checkout, payment can take several minutes — 3DS flows, UPI confirmations, wallet redirects. During that window, thousands of other shoppers may be viewing the same product page.

- **Decrement at payment** → two customers pay for the same physical unit
- **Decrement at add-to-cart** → inventory looks depleted, 80% of carts abandoned, conversion tanks

**The solution:** a timed reservation. Hold the units for 10 minutes at checkout. Confirm on payment success, release on failure or timeout.

---

## Live Demo

**Deployed URL:** `[your-vercel-url]`
**Seed data:** 2 warehouses × 2 products pre-loaded (MacBook Pro M3, iPhone 15 Pro Max)

---

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript end-to-end |
| Database | Neon PostgreSQL (hosted) |
| ORM | Prisma |
| Validation | Zod |
| Cache / Lock | Upstash Redis |
| Styling | Tailwind CSS v4 |

---

## API Reference

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/products` | Lists products with available stock per warehouse |
| `GET` | `/api/warehouses` | Lists all warehouses |
| `POST` | `/api/reservations` | Reserves units — returns `409` if insufficient stock |
| `POST` | `/api/reservations/:id/confirm` | Confirms reservation (payment succeeded) — returns `410` if expired |
| `POST` | `/api/reservations/:id/release` | Releases reservation early (cancelled or payment failed) |

---

## Concurrency Design

The reservation endpoint is race-condition-free via **pessimistic row locking**:

```sql
SELECT "totalUnits" FROM "Stock"
WHERE "productId" = $1 AND "warehouseId" = $2
FOR UPDATE
```

When two simultaneous requests arrive for the last unit:

1. Both enter a `BEGIN` transaction block
2. One acquires the `FOR UPDATE` lock; the other **stalls at the DB boundary**
3. The first calculates available units, inserts the hold, and `COMMIT`s
4. The second unblocks, recalculates (now 0 available), and returns `409 Conflict`

No application-level mutex, no Redis lock required — the database enforces serializability.

---

## Reservation Expiry

**Strategy: Lazy Cleanup on Read**

Rather than running a background cron job that polls every minute (wasted compute, infrastructure overhead), expired reservations are released inline on every read:

```sql
UPDATE "Reservation"
SET status = 'RELEASED'
WHERE status = 'PENDING' AND "expiresAt" < NOW()
```

This runs on every `GET /api/products` and every `POST /api/reservations` — the two highest-frequency paths. The `Reservation(status, expiresAt)` composite index ensures this is a fast indexed scan, not a full table scan.

**Trade-off:** a reservation technically "holds" stock for up to the expiry window + the lag until the next read. For this use case (10-minute windows, frequent product page loads), this is acceptable. In a lower-traffic system, a Vercel Cron job running every minute would be a cleaner alternative.

---

## Running Locally

### 1. Clone & install

```bash
git clone [repo-url]
cd allo-fulfillment-platform
npm install
```

### 2. Environment variables

Create a `.env` file in the root:

```env
DATABASE_URL=postgresql://[user]:[password]@[host]/[db]?sslmode=require
UPSTASH_REDIS_REST_URL=https://[your-upstash-url]
UPSTASH_REDIS_REST_TOKEN=[your-upstash-token]
```

- **Neon:** create a free project at [neon.tech](https://neon.tech) and copy the connection string
- **Upstash:** create a free Redis database at [upstash.com](https://upstash.com)

### 3. Run migrations

```bash
npx prisma migrate deploy
```

### 4. Seed the database

```bash
node prisma/seed.js
```

This seeds:
- 2 warehouses (Mumbai Central Hub, Delhi NCR Logistics Center)
- 2 products (MacBook Pro M3, iPhone 15 Pro Max)
- Stock entries per warehouse

### 5. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── products/route.tsx        # GET /api/products
│   │   ├── warehouses/route.ts       # GET /api/warehouses
│   │   └── reservations/
│   │       ├── route.tsx             # POST /api/reservations
│   │       └── [id]/
│   │           ├── confirm/route.ts  # POST /api/reservations/:id/confirm
│   │           └── release/route.ts  # POST /api/reservations/:id/release
│   ├── page.tsx                      # Main UI
│   └── layout.tsx
├── lib/
│   ├── db.ts                         # Prisma client singleton
│   ├── redis.ts                      # Upstash Redis client
│   ├── validation.ts                 # Zod schemas
│   └── expiryCleanup.ts              # Utility: release expired reservations
prisma/
├── schema.prisma                     # Data model
├── migrations/                       # SQL migration history
└── seed.js                           # Database seed script
```

---

## Data Model

```
Warehouse  ──< Stock >── Product
                 │
                 └──< Reservation (PENDING | CONFIRMED | RELEASED)
```

- `Stock` stores physical total units per product per warehouse
- `Reservation` tracks holds with `expiresAt` and `status`
- Available units = `Stock.totalUnits` − `SUM(active Reservation.quantity)`

---

## Trade-offs & What I'd Do Differently

**What's working well:**
- Pessimistic locking is simple and correct — no distributed lock manager needed for single-region Postgres
- Lazy expiry cleanup is zero-overhead for the current traffic pattern
- The composite index on `(status, expiresAt)` makes cleanup queries fast at scale

**Given more time:**
- **Idempotency keys:** The `idempotencyKey` field is modeled in the schema. I'd implement the full flow: read the `Idempotency-Key` header, check Redis for a cached response, return it on retry, or store after first execution. Currently the field exists but isn't used.
- **Available stock in API response:** `GET /api/products` currently returns `totalUnits` (physical), not `totalUnits − activeReservations` (available). This means the UI can show stock as available when it's fully held. A subquery or view would fix this.
- **Optimistic locking alternative:** For very high-write scenarios, optimistic locking with a version column + retry loop can outperform `SELECT FOR UPDATE` by reducing lock contention. Worth benchmarking at scale.
- **Health checks & observability:** No structured logging, no error monitoring (Sentry), no DB connection pooling (PgBouncer/Prisma Accelerate). All production necessities.
- **E2E tests:** The concurrency guarantee should be validated with a test that fires two simultaneous reservation requests for the last unit and asserts exactly one 201 and one 409.
