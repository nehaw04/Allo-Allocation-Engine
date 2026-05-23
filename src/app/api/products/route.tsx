import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

export const dynamic = 'force-dynamic';

// 1. Keep your working GET function exactly the same
export async function GET() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  try {
    await client.connect();
    const queryText = 'SELECT p.id as product_id, p.sku, p.name, p.description, p.price, w.id as warehouse_id, w.name as warehouse_name, w.location, s."totalUnits" FROM "Product" p LEFT JOIN "Stock" s ON p.id = s."productId" LEFT JOIN "Warehouse" w ON s."warehouseId" = w.id;';
    const result = await client.query(queryText);
    return NextResponse.json({ success: true, catalog: result.rows }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    await client.end();
  }
}

// 2. Mount the POST handler right next to it so it shares the working URL!
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

    const now = new Date().toISOString();
    await client.query(`UPDATE "Reservation" SET status = 'RELEASED' WHERE status = 'PENDING' AND "expiresAt" < '${now}'`);

    const stockResult = await client.query('SELECT "totalUnits" FROM "Stock" WHERE "productId" = $1 AND "warehouseId" = $2 FOR UPDATE', [productId, warehouseId]);
    if (stockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "Warehouse inventory target mapping not found." }, { status: 404 });
    }

    const totalPhysicalUnits = stockResult.rows[0].totalUnits;
    const holdsResult = await client.query('SELECT COALESCE(SUM(quantity), 0) as reserved_units FROM "Reservation" WHERE "productId" = $1 AND "warehouseId" = $2 AND status = \'PENDING\' AND "expiresAt" > $3', [productId, warehouseId, new Date()]);
    const totalReservedUnits = parseInt(holdsResult.rows[0].reserved_units, 10);
    const effectiveAvailableUnits = totalPhysicalUnits - totalReservedUnits;

    if (effectiveAvailableUnits < quantity) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "Requested quantities are out of stock due to real-time holds." }, { status: 409 });
    }

    const holdExpirationDeadline = new Date(Date.now() + 10 * 60 * 1000);
    const reservationResult = await client.query('INSERT INTO "Reservation" (id, "productId", "warehouseId", quantity, status, "expiresAt") VALUES (gen_random_uuid(), $1, $2, $3, \'PENDING\', $4) RETURNING id, "expiresAt"', [productId, warehouseId, quantity, holdExpirationDeadline]);
    
    await client.query('COMMIT');

    return NextResponse.json({
      success: true,
      message: "Inventory units locked effectively via Shared Channel.",
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
export async function PATCH(req: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const body = await req.json();
    const { reservationId } = body;

    await client.query('BEGIN');

    // 1. Fetch the targeted reservation details
    const resResult = await client.query('SELECT * FROM "Reservation" WHERE id = $1', [reservationId]);
    if (resResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "Reservation entry not located." }, { status: 404 });
    }

    const reservation = resResult.rows[0];

    if (reservation.status === 'CONFIRMED') {
      await client.query('ROLLBACK');
      return NextResponse.json({ message: "Purchase verified previously." }, { status: 200 });
    }

    if (reservation.status === 'RELEASED' || new Date(reservation.expiresAt) < new Date()) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "Reservation hold timeframe has expired. Inventory reallocated." }, { status: 410 });
    }

    // 2. Atomically decrement the total physical stock levels upon successful payment
    await client.query(
      'UPDATE "Stock" SET "totalUnits" = "totalUnits" - $1 WHERE "productId" = $2 AND "warehouseId" = $3',
      [reservation.quantity, reservation.productId, reservation.warehouseId]
    );

    // 3. Mark the reservation state as permanently CONFIRMED
    const updateRes = await client.query(
      'UPDATE "Reservation" SET status = \'CONFIRMED\' WHERE id = $1 RETURNING status',
      [reservationId]
    );

    await client.query('COMMIT');

    return NextResponse.json({
      success: true,
      message: "Transaction processed, physical stock decremented permanently.",
      status: updateRes.rows[0].status
    }, { status: 200 });

  } catch (error: any) {
    await client.query('ROLLBACK');
    return NextResponse.json({ error: "Internal processing crash during checkout.", details: error.message }, { status: 500 });
  } finally {
    await client.end();
  }
}