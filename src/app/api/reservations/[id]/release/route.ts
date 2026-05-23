import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query('UPDATE "Reservation" SET status = \'RELEASED\' WHERE id = $1 AND status = \'PENDING\'');
    return NextResponse.json({ success: true, message: "Hold dropped early. Stock units freed." }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    await client.end();
  }
}