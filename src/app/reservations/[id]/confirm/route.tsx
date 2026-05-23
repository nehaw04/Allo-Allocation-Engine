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

    // 1. Transaction Block: Lock tables to prevent other clients from interfering mid-flight
    await client.query('BEGIN');

    // 2. Lazy Expiry: Release expired holds back to the pool
    const now = new Date().toISOString();
    await client.query(`
      UPDATE "Reservation" 
      SET status = 'RELEASED' 
      WHERE status = 'PENDING' AND "expiresAt" < '${now}'
    `);

    // 3. Pessimistic Row Locking: Find stock levels and lock them down
    const stockQuery = `
      SELECT "totalUnits" FROM "Stock" 
      WHERE "productId" = $1 AND "warehouseId" = $2 
      FOR UPDATE
    `;
    const stockResult = await client.query(stockQuery, [productId, warehouseId]);

    if (stockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "Warehouse inventory target mapping not found." }, { status: 404 });
    }

    const totalPhysicalUnits = stockResult.rows[0].totalUnits;

    // 4. Sum up active holds that are still pending and unexpired
    const activeHoldsQuery = `
      SELECT COALESCE(SUM(quantity), 0) as reserved_units 
      FROM "Reservation"
      WHERE "productId" = $1 AND "warehouseId" = $2 AND status = 'PENDING' AND "expiresAt" > $3
    `;
    const holdsResult = await client.query(activeHoldsQuery, [productId, warehouseId, new Date()]);
    const totalReservedUnits = parseInt(holdsResult.rows[0].reserved_units, 10);

    const effectiveAvailableUnits = totalPhysicalUnits - totalReservedUnits;

    // 5. Catch concurrency oversells
    if (effectiveAvailableUnits < quantity) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "Requested quantities are out of stock due to real-time holds." }, { status: 409 });
    }

    // 6. Create a fresh 10-minute hold window
    const holdExpirationDeadline = new Date(Date.now() + 10 * 60 * 1000);
    const createReservationQuery = `
      INSERT INTO "Reservation" (id, "productId", "warehouseId", quantity, status, "expiresAt")
      VALUES (gen_random_uuid(), $1, $2, $3, 'PENDING', $4)
      RETURNING id, "expiresAt"
    `;
    const reservationResult = await client.query(createReservationQuery, [productId, warehouseId, quantity, holdExpirationDeadline]);
    
    await client.query('COMMIT');

    return NextResponse.json({
      success: true,
      message: "Inventory units locked effectively.",
      reservationId: reservationResult.rows[0].id,
      expiresAt: reservationResult.rows[0].expiresAt
    }, { status: 201 });

  } catch (error: any) {
    await client.query('ROLLBACK');
    return NextResponse.json({ error: "System fault processing data mutation.", details: error.message }, { status: 500 });
  } finally {
    await client.end();
  }
}