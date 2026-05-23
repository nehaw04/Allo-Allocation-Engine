# Allo Distributed Inventory & Allocation Engine (V2.1)

A high-concurrency, production-grade inventory reservation and order-fulfillment engine built with **Next.js (App Router)**, **TypeScript**, and a hosted **Neon PostgreSQL** database layer. 

This platform prevents overselling during high-traffic checkout flows (e.g., flash sales, deep wallet redirects, UPI completions) by introducing a pessimistic locking reservation system with a 10-minute automated holding state.

---

## 🚀 Core Architectural System Design

### 1. Concurrency Control & Race-Condition Prevention
To completely eliminate double-allocation issues without introducing heavy distributed locking overhead, this engine utilizes database-level **Pessimistic Row Locking**. 
When a reservation request hits `POST /api/reservations`:
* A raw PostgreSQL transaction block is initiated (`BEGIN`).
* The targeted stock row is immediately locked via `SELECT ... FOR UPDATE`. This forces concurrent parallel requests for the exact same SKU to stall at the database boundary until the active transaction either commits or rolls back.
* Available units are calculated safely in real-time by deducting unexpired holds from physical inventory totals. If units are available, the 10-minute hold window is inserted, and the state commits (`COMMIT`). Otherwise, it safely executes a `ROLLBACK` and handles a `409 Conflict`.

### 2. High-Efficiency Expiry Mechanism: Lazy Cleanup on Read
Rather than running an expensive background cron worker or continuous polling thread that drains compute resources every minute, this system leverages a highly efficient **Lazy Cleanup on Read** strategy. 
* Every time a client initiates a catalog lookup (`GET /api/products`) or an allocation request (`POST /api/reservations`), the system runs a fast, indexed query to instantly mutate expired pending records:
  ```sql
  UPDATE "Reservation" 
  SET status = 'RELEASED' 
  WHERE status = 'PENDING' AND "expiresAt" < NOW();