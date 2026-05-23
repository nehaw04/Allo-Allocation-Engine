import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

// 1. Update the signature: params is now a Promise
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
    
    // 2. Await the params Promise to cleanly extract the ID
    const { id } = await params; 

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