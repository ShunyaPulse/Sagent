import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

// Suppress pg-connection-string SSL deprecation warning in Node 20+
process.on("warning", (warning) => {
  if (
    warning.name === "SecurityWarning" ||
    warning.message.includes("SSL modes")
  ) {
    return;
  }
  console.warn(warning);
});

const normalizedDbUrl = env.DATABASE_URL
  ? env.DATABASE_URL.replace(
      /sslmode=(require|prefer|verify-ca)/g,
      "sslmode=verify-full",
    )
  : undefined;

export const pool = new Pool({
  connectionString: normalizedDbUrl,
  ssl: env.NODE_ENV === "production" ? true : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("❌ Unexpected error on idle Neon PostgreSQL client:", err);
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;

  if (process.env.DEBUG_SQL === "true") {
    console.log(`[SQL Query] (${duration}ms) ${text.slice(0, 80)}...`);
  }
  return res;
}

export async function checkDbHealth(): Promise<boolean> {
  try {
    const res = await pool.query("SELECT 1 as healthy");
    return res.rows[0]?.healthy === 1;
  } catch (err) {
    console.error("❌ Database health check failed:", err);
    return false;
  }
}
