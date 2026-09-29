import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./postgres.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  console.log(
    "🚀 Running database migrations for Sagentic on Neon PostgreSQL...",
  );
  const schemaPath = path.join(__dirname, "../../sql/001_initial_schema.sql");

  if (!fs.existsSync(schemaPath)) {
    console.error(`❌ Migration schema not found at: ${schemaPath}`);
    process.exit(1);
  }

  if (!pool) {
    console.error(
      "❌ DATABASE_URL must be defined to run database migrations.",
    );
    process.exit(1);
  }

  const sql = fs.readFileSync(schemaPath, "utf-8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(
      "✅ Migrations executed successfully! All tables & pgvector indexes verified.",
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
