import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";

const poolConnection = mysql.createPool({
  host: process.env.DATABASE_HOST!,
  port: Number(process.env.DATABASE_PORT || 3306),
  user: process.env.DATABASE_USER!,
  password: process.env.DATABASE_PASSWORD!,
  database: process.env.DATABASE_NAME!,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 2,
});

export const db = drizzle(poolConnection, { schema, mode: "default" });
