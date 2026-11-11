// One-shot migration: add the repost_fanout preference column to users.
// Run with: npx tsx scripts/migrate-repost-fanout.ts
//
// drizzle-kit push has a bug with MariaDB 11.8, so schema changes go through
// raw SQL via mysql2 instead.

import { config } from "dotenv";
import mysql from "mysql2/promise";

config({ path: ".env.local" });

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST!,
    port: Number(process.env.DATABASE_PORT || 3306),
    user: process.env.DATABASE_USER!,
    password: process.env.DATABASE_PASSWORD!,
    database: process.env.DATABASE_NAME!,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const [cols] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'repost_fanout'`,
      [process.env.DATABASE_NAME]
    );
    if (cols.length > 0) {
      console.log("repost_fanout already present; nothing to do.");
      return;
    }
    await conn.query("ALTER TABLE users ADD COLUMN repost_fanout TINYINT(1) NOT NULL DEFAULT 1");
    console.log("Added users.repost_fanout.");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
