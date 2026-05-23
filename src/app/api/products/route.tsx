import { NextResponse } from 'next/server';
import { Client } from 'pg';

export const dynamic = 'force-dynamic';

export async function GET() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    
    // Lazy Cleanup: release expired holds on read
    const now = new Date().toISOString();
    await client.query('UPDATE "Reservation" SET status = \'RELEASED\' WHERE status = \'PENDING\' AND "expiresAt" < $1', [now]);

    const queryText = `
      SELECT 
        p.id as product_id, p.sku, p.name, p.description, p.price,
        w.id as warehouse_id, w.name as warehouse_name, w.location,
        s."totalUnits"
      FROM "Product" p
      LEFT JOIN "Stock" s ON p.id = s."productId"
      LEFT JOIN "Warehouse" w ON s."warehouseId" = w.id;
    `;
    const result = await client.query(queryText);
    return NextResponse.json({ success: true, catalog: result.rows }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    await client.end();
  }
  // Inside your GET function in src/app/api/products/route.ts:
  const query = `
    SELECT 
      p.id as product_id,
      p.sku,
      p.name,
      p.description,
      p.price,
      w.id as warehouse_id,
      w.name as warehouse_name,
      w.location,
      s."totalUnits" as physical_units,
      -- Calculate true available stock dynamically (Physical Units - Active Holds)
      (s."totalUnits" - COALESCE(
        (SELECT SUM(r.quantity) 
        FROM "Reservation" r 
        WHERE r."productId" = p.id 
          AND r."warehouseId" = w.id 
          AND r.status = 'PENDING' 
          AND r."expiresAt" > NOW()
        ), 0)
      ) as "totalUnits" 
    FROM "Stock" s
    JOIN "Product" p ON s."productId" = p.id
    JOIN "Warehouse" w ON s."warehouseId" = w.id
    ORDER BY p.name ASC, w.name ASC;
  `;
}