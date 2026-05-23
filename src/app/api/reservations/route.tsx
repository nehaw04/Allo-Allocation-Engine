import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

export async function POST(req: NextRequest) {
  const client = new Client({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
  });

  try {
    await client.connect();
    const body = await req.json();
    const { productId, warehouseId, quantity } = body;

    await client.query('BEGIN');

    // 1. Lazy Cleanup: Flush expired entries before evaluating limits
    await client.query(
      'UPDATE "Reservation" SET status = \'RELEASED\' WHERE status = \'PENDING\' AND "expiresAt" < NOW()'
    );

    // 2. Pessimistic Row Lock: Grip the physical stock inventory row
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

    // 4. Secure the Hold Entry
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 Minute Hold Limit
    const insertResult = await client.query(
      'INSERT INTO "Reservation" (id, "productId", "warehouseId", quantity, status, "expiresAt") VALUES (gen_random_uuid(), $1, $2, $3, \'PENDING\', $4) RETURNING id, "expiresAt"',
      [productId, warehouseId, quantity, expiresAt]
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