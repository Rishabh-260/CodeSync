import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

export const pool = new pg.Pool({
  connectionString,
  max: 10,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
});
export const db = drizzle(pool, { schema });
