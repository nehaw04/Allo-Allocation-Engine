import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';
import { ReservationSchema } from '@/lib/validation'; // Zod validation layout

export async function POST(req: NextRequest) {
  const client = new Client({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
  });

  try {
    await client.connect();
    const body = await req.json();

    // 1. Validate the request body using Zod
    const validation = ReservationSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: "VALIDATION_ERROR", issues: validation.error.format() },
        { status: 400 }
      );
    }

    // Extract clean, validated parameters
    const { productId, warehouseId, quantity } = validation.data;

    // 2. Extract Idempotency-Key from headers for deduplication boundary checking
    const idempotencyKey = req.headers.get('idempotency-key');

    if (idempotencyKey) {
      // Fast structural point lookup to check if this specific write request already cleared
      const duplicateCheck = await client.query(
        'SELECT id, "expiresAt" FROM "Reservation" WHERE "idempotencyKey" = $1',
        [idempotencyKey]
      );

      // IDEMPOTENCY HIT: Deduplicate instantly. Return original payload safely without repeating side effects
      if (duplicateCheck.rows.length > 0) {
        return NextResponse.json({ 
          success: true, 
          message: "Duplicate request boundary hit. Returning cached allocation state.",
          reservationId: duplicateCheck.rows[0].id, 
          expiresAt: duplicateCheck.rows[0].expiresAt 
        }, { 
          status: 200, 
          headers: { 'X-Cache-Idempotency': 'HIT' } 
        });
      }
    }

    // =========================================================================
    // 🔏 ATOMIC TRANSACTION LOGIC & PESSIMISTIC LOCKING
    // =========================================================================
    await client.query('BEGIN');

    // 1. Lazy Cleanup: Flush expired entries before evaluating allocation capacity
    await client.query(
      'UPDATE "Reservation" SET status = \'RELEASED\' WHERE status = \'PENDING\' AND "expiresAt" < NOW()'
    );

    // 2. Pessimistic Row Lock: Grip the physical stock inventory row securely
    const stockResult = await client.query(
      'SELECT "totalUnits" FROM "Stock" WHERE "productId" = $1 AND "warehouseId" = $2 FOR UPDATE',
      [productId, warehouseId]
    );

    if (stockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "Inventory node targets not found." }, { status: 404 });
    }

    // Explicitly parse the physical units row integer
    const totalUnits = parseInt(stockResult.rows[0].totalUnits, 10);

    // 3. Collect active, pending reservations using native PostgreSQL NOW() formatting
    const holdsResult = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) as reserved_units 
       FROM "Reservation" 
       WHERE "productId" = $1 AND "warehouseId" = $2 AND status = 'PENDING' AND "expiresAt" > NOW()`,
      [productId, warehouseId]
    );
    const totalReserved = parseInt(holdsResult.rows[0].reserved_units, 10);

    const availableInventoryPool = totalUnits - totalReserved;

    // 🚨 STOPSHIP FAILSAFE: Core Concurrency Guard
    if (availableInventoryPool <= 0 || availableInventoryPool < quantity) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { success: false, error: "CONFLICT_409", message: "Target allocation units exhausted by parallel workers." }, 
        { status: 409 }
      );
    }

    // 4. Secure the Hold Entry with explicit Idempotency Key mapping
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 Minute Hold Limit
    
    const insertResult = await client.query(
      `INSERT INTO "Reservation" (id, "productId", "warehouseId", quantity, status, "expiresAt", "idempotencyKey") 
       VALUES (gen_random_uuid(), $1, $2, $3, 'PENDING', $4, $5) 
       RETURNING id, "expiresAt"`,
      [productId, warehouseId, quantity, expiresAt, idempotencyKey]
    );

    await client.query('COMMIT');
    
    return NextResponse.json({ 
      success: true, 
      reservationId: insertResult.rows[0].id, 
      expiresAt: insertResult.rows[0].expiresAt 
    }, { status: 201 });

  } catch (error: any) {
    await client.query('ROLLBACK');
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    await client.end();
  }
}