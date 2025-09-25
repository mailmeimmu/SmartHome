const mysql = require('mysql2/promise');

const MYSQL_HOST = process.env.MYSQL_HOST || '156.67.104.77';
const MYSQL_PORT = Number(process.env.MYSQL_PORT) || 3306;
const MYSQL_USER = process.env.MYSQL_USER || 'dbadminiot';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || 'Dd@123456';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'dbadminiot_iot';

const pool = mysql.createPool({
  host: MYSQL_HOST,
  port: MYSQL_PORT,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  connectionLimit: 10,
  waitForConnections: true,
});

module.exports = { pool };
