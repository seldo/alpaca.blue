// One-shot migration: create the cross_post_mirrors table.
// Run with: npx tsx scripts/migrate-cross-post-mirrors.ts
//
// drizzle-kit push has a bug with MariaDB 11.8, so schema changes are
// applied as plain SQL through mysql2 instead.

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
    multipleStatements: true,
  });

  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cross_post_mirrors'`,
      [process.env.DATABASE_NAME]
    );
    if (rows.length > 0) {
      console.log("cross_post_mirrors already exists; nothing to do.");
      return;
    }

    await conn.query(`
      CREATE TABLE cross_post_mirrors (
        id INT AUTO_INCREMENT NOT NULL,
        user_id INT NOT NULL,
        original_post_id INT NOT NULL,
        mirror_platform VARCHAR(50) NOT NULL,
        mirror_platform_post_id VARCHAR(512) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT cross_post_mirrors_id PRIMARY KEY (id),
        CONSTRAINT mirror_user_platform_post_idx UNIQUE (user_id, mirror_platform, mirror_platform_post_id),
        CONSTRAINT fk_mirror_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_mirror_original FOREIGN KEY (original_post_id) REFERENCES posts(id) ON DELETE CASCADE,
        INDEX mirror_original_idx (original_post_id)
      )
    `);
    console.log("Created cross_post_mirrors.");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
