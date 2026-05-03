import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";

// Cache the pool on globalThis so Next.js HMR re-evaluating this module in
// dev doesn't create a new pool on every save (each old pool keeps its
// connections open and you blow past max_connections within a few reloads).
const globalForPool = globalThis as unknown as { __mysqlPool?: mysql.Pool };

const poolConnection =
  globalForPool.__mysqlPool ??
  mysql.createPool({
    host: process.env.DATABASE_HOST!,
    port: Number(process.env.DATABASE_PORT || 3306),
    user: process.env.DATABASE_USER!,
    password: process.env.DATABASE_PASSWORD!,
    database: process.env.DATABASE_NAME!,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 2,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPool.__mysqlPool = poolConnection;
}

export const db = drizzle(poolConnection, { schema, mode: "default" });
