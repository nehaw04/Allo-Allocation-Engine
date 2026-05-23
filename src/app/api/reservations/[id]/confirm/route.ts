import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

// Dynamic route context mapper
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  // Await the dynamic URL parameters explicitly for Next.js App Router stability
  const { id } = await context.params; 
  
  const client = new Client({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
  });

  try {
    await client.connect();
    await client.query('BEGIN');

    // Query using the cleanly mapped URL route path ID parameter string
    const resResult = await client.query('SELECT * FROM "Reservation" WHERE id = $1', [id]);
    
    if (resResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "Reservation entry not located." }, { status: 404 });
    }

    const reservation = resResult.rows[0];
    
    // Catch if this reservation block was already paid for by a parallel window click
    if (reservation.status === 'CONFIRMED') {
      await client.query('ROLLBACK');
      return NextResponse.json({ 
        success: false, 
        error: "TRANSACTION_ALREADY_PROCESSED",
        message: "This reservation has already been finalized and paid for." 
      }, { status: 400 }); // Swapped to a 400 Bad Request error code
    }

    if (reservation.status === 'RELEASED' || new Date(reservation.expiresAt) < new Date()) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "RESERVATION_EXPIRED" }, { status: 410 });
    }

    // Atomic Balance Drop
    await client.query(
      'UPDATE "Stock" SET "totalUnits" = "totalUnits" - $1 WHERE "productId" = $2 AND "warehouseId" = $3', 
      [reservation.quantity, reservation.productId, reservation.warehouseId]
    );
    
    // Finalize state change permanently
    await client.query('UPDATE "Reservation" SET status = \'CONFIRMED\' WHERE id = $1', [id]);

    await client.query('COMMIT');
    return NextResponse.json({ success: true, message: "Stock decremented permanently." }, { status: 200 });

  } catch (error: any) {
    await client.query('ROLLBACK');
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    await client.end();
  }
}