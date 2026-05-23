const { Client } = require('pg');
require('dotenv').config();

// Create a direct PostgreSQL client instance
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function main() {
  console.log("Connecting directly to cloud database cluster...");
  await client.connect();

  console.log("Wiping out old transactional matrices...");
  // Clear tables in reverse dependency order to respect foreign key constraints
  await client.query('TRUNCATE TABLE "Reservation", "Stock", "Product", "Warehouse" CASCADE;');

  console.log("Seeding regional deployment centers...");
  // Use raw SQL inserts with returning clauses to handle UUID tracking parameters
  const wh1 = await client.query(`
    INSERT INTO "Warehouse" (id, name, location) 
    VALUES (gen_random_uuid(), 'Mumbai Central Hub', 'Maharashtra, IN') 
    RETURNING id;
  `);
  const wh2 = await client.query(`
    INSERT INTO "Warehouse" (id, name, location) 
    VALUES (gen_random_uuid(), 'Delhi NCR Logistics Center', 'Delhi, IN') 
    RETURNING id;
  `);

  console.log("Seeding regional core inventory configurations...");
  const p1 = await client.query(`
    INSERT INTO "Product" (id, sku, name, description, price) 
    VALUES (gen_random_uuid(), 'MACBOOK-M3-16GB', 'MacBook Pro M3', '16GB Unified Memory, 512GB SSD Space Gray', 169900.00) 
    RETURNING id;
  `);
  const p2 = await client.query(`
    INSERT INTO "Product" (id, sku, name, description, price) 
    VALUES (gen_random_uuid(), 'IPHONE-15-PRO', 'iPhone 15 Pro Max', 'Natural Titanium, 256GB Storage Network Unlocked', 139900.00) 
    RETURNING id;
  `);

  const wh1Id = wh1.rows[0].id;
  const wh2Id = wh2.rows[0].id;
  const p1Id = p1.rows[0].id;
  const p2Id = p2.rows[0].id;

  console.log("Binding product entities to warehouse locations...");
  await client.query(`
    INSERT INTO "Stock" (id, "productId", "warehouseId", "totalUnits") VALUES
    (gen_random_uuid(), '${p1Id}', '${wh1Id}', 10),
    (gen_random_uuid(), '${p1Id}', '${wh2Id}', 5),
    (gen_random_uuid(), '${p2Id}', '${wh1Id}', 1),
    (gen_random_uuid(), '${p2Id}', '${wh2Id}', 25);
  `);

  console.log("🎉 Cloud database raw data injection completed successfully!");
}

main()
  .catch((e) => {
    console.error("Execution sequence failed:", e);
  })
  .finally(async () => {
    await client.end();
    process.exit(0);
  });