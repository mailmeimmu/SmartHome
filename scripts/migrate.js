const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const MYSQL_HOST = '156.67.104.77';
const MYSQL_PORT = 3306;
const MYSQL_USER = 'dbadminiot';
const MYSQL_PASSWORD = 'Dd@123456';

async function main() {
  const conn = await mysql.createConnection({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    multipleStatements: true,
  });

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Applying schema...');
  await conn.query(sql);
  console.log('Schema applied.');

  console.log('Ensuring role enum includes admin...');
  await conn.query("ALTER TABLE users MODIFY COLUMN role ENUM('admin','parent','member') NOT NULL DEFAULT 'member'");
  console.log('Role enum ensured.');
  await conn.end();
}

main().catch((e) => {
  console.error('Migration failed:', e.message || e);
  process.exit(1);
});
