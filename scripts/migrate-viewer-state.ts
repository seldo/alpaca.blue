// One-shot migration: add viewer_liked and viewer_reposted columns to posts.
// Run with: npx tsx scripts/migrate-viewer-state.ts
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
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'posts'
         AND COLUMN_NAME IN ('viewer_liked', 'viewer_reposted')`,
      [process.env.DATABASE_NAME]
    );
    const existing = new Set(cols.map((r) => r.COLUMN_NAME as string));
    const toAdd: string[] = [];
    if (!existing.has("viewer_liked")) toAdd.push("ADD COLUMN viewer_liked TINYINT(1) DEFAULT 0");
    if (!existing.has("viewer_reposted")) toAdd.push("ADD COLUMN viewer_reposted TINYINT(1) DEFAULT 0");
    if (toAdd.length === 0) {
      console.log("Both columns already present; nothing to do.");
      return;
    }
    await conn.query(`ALTER TABLE posts ${toAdd.join(", ")}`);
    console.log(`Added ${toAdd.length} column(s).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
