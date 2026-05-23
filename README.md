<div align="center">

# Allo Allocation Engine

**Timed inventory reservation for multi-warehouse checkout flows**

[![Live Demo](https://img.shields.io/badge/Live%20Demo-allo--allocation--engine.vercel.app-4f46e5?style=flat-square&logo=vercel)](https://allo-allocation-engine.vercel.app)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript)](https://typescriptlang.org)
[![Postgres](https://img.shields.io/badge/Neon-PostgreSQL-00e5bf?style=flat-square&logo=postgresql)](https://neon.tech)

</div>

---

## The Problem

When a customer reaches checkout, payment can take several minutes — 3DS flows, UPI confirmations, wallet redirects. Two naive approaches both fail:

| Approach | What breaks |
|---|---|
| Decrement stock at payment | Two customers pay for the same unit. One gets a refund. Ops cleans up manually. |
| Decrement stock at add-to-cart | 80% of carts are abandoned. Inventory looks depleted. Conversion tanks. |

**The fix:** a timed reservation. Hold the units for 10 minutes when the customer enters checkout. Confirm on payment success → permanently decrement stock. Expire or cancel → release back to the pool.

---

## Live Demo

**→ [allo-allocation-engine.vercel.app](https://allo-allocation-engine.vercel.app)**

Seeded with 2 warehouses × 2 products. The full flow — reserve, countdown, confirm/cancel, 409/410 error states — is demoed live.

---

## Running Locally

### 1. Clone and install

```bash
git clone <repo-url>
cd allo-fulfillment-platform
npm install
```

### 2. Environment variables

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
```

Get a free hosted Postgres instance from [neon.tech](https://neon.tech) → copy the connection string from your project dashboard. The `sslmode=require` param is mandatory for Neon.

### 3. Apply migrations

```bash
npx prisma migrate deploy
```

Creates all tables: `Warehouse`, `Product`, `Stock`, `Reservation`, and the `ReservationStatus` enum. Migration history lives in `prisma/migrations/`.

### 4. Generate the Prisma client

```bash
npx prisma generate
```

> Note: `npm run build` runs this automatically. Only needed separately in local dev if you skip the build step.

### 5. Seed the database

```bash
node prisma/seed.js
```

Inserts:
- 2 warehouses: **Mumbai Central Hub** (Maharashtra) and **Delhi NCR Logistics Center** (Delhi)
- 2 products: **MacBook Pro M3** ₹1,69,900 and **iPhone 15 Pro Max** ₹1,39,900
- 4 stock rows distributing units across both warehouse/product combinations

### 6. Start dev server

```bash
npm run dev
# → http://localhost:3000
```

---

## Architecture

### Data model

```
Warehouse ──< Stock >── Product
                           │
                           └──< Reservation
                                  status: PENDING | CONFIRMED | RELEASED
                                  expiresAt: DateTime
```

- `Stock.totalUnits` = physical units in warehouse. **Never decremented for a hold** — only decremented on confirmed purchase.
- Available units at any point = `Stock.totalUnits − SUM(active PENDING Reservation.quantity)`
- This is computed dynamically in the query — not stored as a column — so it is always current without a sync step.

```sql
-- Available stock calculation in GET /api/products
SELECT
  s."totalUnits" - COALESCE((
    SELECT SUM(r.quantity)
    FROM "Reservation" r
    WHERE r."productId" = p.id
      AND r."warehouseId" = w.id
      AND r.status = 'PENDING'
      AND r."expiresAt" > NOW()
  ), 0) AS "totalUnits"
FROM "Stock" s
JOIN "Product" p ON s."productId" = p.id
JOIN "Warehouse" w ON s."warehouseId" = w.id
```

### API surface

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/products` | Products with live available stock per warehouse |
| `GET` | `/api/warehouses` | All warehouse records |
| `POST` | `/api/reservations` | Creates a 10-min hold. `409` if stock exhausted |
| `POST` | `/api/reservations/:id/confirm` | Finalises purchase, decrements physical stock. `410` if expired |
| `POST` | `/api/reservations/:id/release` | Releases hold early (cancel / payment failed) |

---

## Concurrency Design

The reservation endpoint is race-condition-free via **PostgreSQL pessimistic row locking**.

```sql
BEGIN;

-- 1. Flush expired holds before evaluating capacity
UPDATE "Reservation"
  SET status = 'RELEASED'
  WHERE status = 'PENDING' AND "expiresAt" < NOW();

-- 2. Acquire exclusive lock on the stock row
--    Second concurrent request BLOCKS here until first commits
SELECT "totalUnits" FROM "Stock"
  WHERE "productId" = $1 AND "warehouseId" = $2
  FOR UPDATE;

-- 3. Count active holds (within same transaction)
SELECT COALESCE(SUM(quantity), 0) AS reserved
  FROM "Reservation"
  WHERE "productId" = $1 AND "warehouseId" = $2
    AND status = 'PENDING' AND "expiresAt" > NOW();

-- 4a. If (totalUnits - reserved) >= requested → INSERT reservation, COMMIT
-- 4b. If not → ROLLBACK, return 409

COMMIT;
```

**What happens when two requests race for the last unit:**

```
Request A                   Postgres               Request B
─────────────────────────────────────────────────────────────
BEGIN                   →
SELECT ... FOR UPDATE   →  ← lock acquired
                                                   BEGIN   →
                                                   SELECT ... FOR UPDATE →
                                                           ← BLOCKED (waiting for A)
INSERT Reservation      →
COMMIT                  →  ← lock released
← 201 Created
                                                           ← unblocked
                                                   recalculate: 0 available
                                                   ROLLBACK →
                                                   ← 409 Conflict
```

No application-level mutex. No Redis lock. The database enforces serializability.

---

## Reservation Expiry

**Strategy: lazy cleanup on read**

Expired reservations are released inline on every high-frequency read path, rather than running a background cron that polls every minute.

```sql
UPDATE "Reservation"
  SET status = 'RELEASED'
  WHERE status = 'PENDING' AND "expiresAt" < NOW();
```

This runs at the start of:
- Every `GET /api/products` call (catalog load)
- Every `POST /api/reservations` call (before the lock is acquired, inside the transaction)

A composite index on `(status, expiresAt)` makes this an indexed scan — not a full table scan — even at scale.

**Frontend countdown:** The UI mirrors the server-side `expiresAt` timestamp with a live countdown timer. When it hits zero, the reservation state is cleared immediately and the catalog is refreshed — the product reappears as available without any manual page reload.

**Trade-off:** A reservation technically holds stock until the next catalog read after expiry. For 10-minute windows with frequent product page loads, this lag is negligible. For a lower-traffic system, a Vercel Cron job every minute would be a cleaner guarantee:

```json
// vercel.json
{
  "crons": [{ "path": "/api/cron/cleanup", "schedule": "* * * * *" }]
}
```

---

## Idempotency (Bonus — Implemented on `/api/reservations`)

The `POST /api/reservations` endpoint is idempotent via an `Idempotency-Key` request header.

**How it works:**

1. Client sends `Idempotency-Key: <uuid>` with the request
2. Before opening a transaction, the server checks for an existing `Reservation` with that key
3. If found → return the original `reservationId` and `expiresAt` immediately, with `X-Cache-Idempotency: HIT` header. No side effects run.
4. If not found → proceed with the full reservation flow, storing the key on the new row

```typescript
// Fast point-lookup before the transaction
const duplicateCheck = await client.query(
  'SELECT id, "expiresAt" FROM "Reservation" WHERE "idempotencyKey" = $1',
  [idempotencyKey]
);
if (duplicateCheck.rows.length > 0) {
  return NextResponse.json({ reservationId: ..., expiresAt: ... }, {
    headers: { 'X-Cache-Idempotency': 'HIT' }
  });
}
```

The `idempotencyKey` column has a `UNIQUE` index, so duplicate inserts are also caught as a database-level safety net.

> **Scope:** Idempotency is implemented on `POST /api/reservations`. The assignment also mentions the confirm endpoint — that's not implemented here (see trade-offs).

---

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── products/route.tsx            # GET /api/products
│   │   ├── warehouses/route.ts           # GET /api/warehouses
│   │   └── reservations/
│   │       ├── route.tsx                 # POST /api/reservations
│   │       └── [id]/
│   │           ├── confirm/route.ts      # POST /api/reservations/:id/confirm
│   │           └── release/route.ts      # POST /api/reservations/:id/release
│   ├── page.tsx                          # UI: product listing + reservation panel
│   └── layout.tsx
├── lib/
│   ├── db.ts                             # Prisma client singleton
│   └── validation.ts                     # Zod schemas
prisma/
├── schema.prisma
├── migrations/
└── seed.js
```

### Why `pg` alongside Prisma?

Prisma's transaction API doesn't natively expose `SELECT FOR UPDATE`, which is the linchpin of the concurrency guarantee. Raw SQL via `node-postgres` gives precise control over lock acquisition order and lets the lazy cleanup, lock, and insert happen in a single atomic block.

---

## Stack

| Layer | Technology | Why |
|---|---|---|
| Framework | Next.js 16 App Router | Required |
| Language | TypeScript | End-to-end type safety |
| Database | Neon (PostgreSQL) | Hosted, serverless-compatible, free tier |
| ORM / Migrations | Prisma | Schema-first migrations, type-safe client |
| DB Client | node-postgres (`pg`) | Raw SQL needed for `SELECT FOR UPDATE` |
| Validation | Zod | Request body validation, shared schemas |
| Styling | Tailwind CSS v4 | Utility-first, fast iteration |

---

## Trade-offs and What I'd Do Differently

**Idempotency on confirm:**
The `POST /api/reservations/:id/confirm` endpoint doesn't implement idempotency. The assignment asks for both endpoints. The correct approach: store a client-supplied `Idempotency-Key` on the reservation row at confirm time, return `200` immediately on retry without re-decrementing stock. Skipped for time.

**Connection handling:**
Each API route opens and closes a `pg.Client` per request. Under load this will exhaust Neon's connection limit. In production this should be replaced with a `pg.Pool` singleton, or proxied through PgBouncer / Prisma Accelerate. The current pattern is fine for a demo but not for production traffic.

**Optimistic vs. pessimistic locking:**
`SELECT FOR UPDATE` serialises all writes through a queue for high-contention rows. For very high-write SKUs (flash sales), an optimistic locking approach — version column + conditional update + retry loop — can reduce lock contention. Worth benchmarking against real traffic before choosing.

**Concurrency test:**
The correctness guarantee should be validated with an automated test: fire two simultaneous `POST /api/reservations` requests for the last unit and assert exactly one `201` and one `409`. Currently untested programmatically — it works, but it's not proven in CI.

**Observability:**
No structured logging, no error monitoring, no query performance tracking. All production necessities that were out of scope here.
