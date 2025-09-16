const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const { MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD } = process.env;
  if (!MYSQL_HOST || !MYSQL_USER) {
    console.error('Missing MySQL connection env. Copy server/.env.example to server/.env');
    process.exit(1);
  }
  // Connect without database first to create it
  const conn = await mysql.createConnection({
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT || 3306),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    multipleStatements: true,
  });

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Applying schema...');
  await conn.query(sql);
  console.log('Schema applied.');
  await conn.end();
}

main().catch((e) => {
  console.error('Migration failed:', e.message || e);
  process.exit(1);
});

