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
    await client.connect();
    
    // Explicitly await the params Promise from context
    const { id } = await context.params; 

    await client.query(
      'UPDATE "Reservation" SET status = \'RELEASED\' WHERE id = $1 AND status = \'PENDING\'',
      [id]
    );

    return NextResponse.json({ success: true, message: "Reservation released successfully." }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    await client.end();
  }
}