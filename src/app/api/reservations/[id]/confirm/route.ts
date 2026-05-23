import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

export async function POST(
  req: NextRequest, 
  { params }: { params: Promise<{ id: string }> }
) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    
    // Await the params Promise to unlock the structural ID string
    const { id } = await params;

    await client.query('BEGIN');

    // 1. Fetch the targeted reservation with an exclusive write lock
    const reservationResult = await client.query(
      'SELECT * FROM "Reservation" WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (reservationResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: "RESERVATION_NOT_FOUND" }, { status: 404 });
    }

    const reservation = reservationResult.rows[0];

    // 2. Enforce Lifecycle Rules
    if (reservation.status === 'CONFIRMED') {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: "TRANSACTION_ALREADY_PROCESSED" }, { status: 400 });
    }

    if (reservation.status === 'RELEASED' || new Date(reservation.expiresAt) < new Date()) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: "RESERVATION_EXPIRED" }, { status: 410 });
    }

    // 3. Complete the purchase state changes
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