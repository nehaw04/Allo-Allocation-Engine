import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    // 1. Read the idempotency header from the incoming request
    const idempotencyKey = request.headers.get('idempotency-key');

    await client.connect();
    
    // Explicitly await the params Promise from context (Next.js 16 compliant)
    const { id } = await context.params;

    await client.query('BEGIN');

    // 2. Fetch the targeted reservation with an exclusive write lock
    const reservationResult = await client.query(
      'SELECT * FROM "Reservation" WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (reservationResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: "RESERVATION_NOT_FOUND" }, { status: 404 });
    }

    const reservation = reservationResult.rows[0];

    // 3. Idempotency Boundary Check: If already CONFIRMED, return success gracefully
    if (reservation.status === 'CONFIRMED') {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { success: true, message: "Transaction finalized successfully." },
        {
          status: 200,
          headers: idempotencyKey ? { 'X-Cache-Idempotency': 'HIT' } : {}
        }
      );
    }

    // 4. Enforce Lifecycle Rules for Expiration
    if (reservation.status === 'RELEASED' || new Date(reservation.expiresAt) < new Date()) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: "RESERVATION_EXPIRED" }, { status: 410 });
    }

    // 5. Complete the purchase state changes
    await client.query(
      'UPDATE "Reservation" SET status = \'CONFIRMED\' WHERE id = $1',
      [id]
    );

    await client.query(
      'UPDATE "Stock" SET "totalUnits" = "totalUnits" - $1 WHERE "productId" = $2 AND "warehouseId" = $3',
      [reservation.quantity, reservation.productId, reservation.warehouseId]
    );

    await client.query('COMMIT');
    return NextResponse.json({ success: true, message: "Transaction finalized successfully." }, { status: 200 });

  } catch (error: any) {
    await client.query('ROLLBACK');
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    await client.end();
  }
}