import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME || "minds",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "",
});

async function initDatabase() {
  console.log("Initializing database...");

  const migrationPath = join(__dirname, "..", "..", "migrations", "001_initial_schema.sql");
  const sql = readFileSync(migrationPath, "utf-8");
  console.log("Running migration:", migrationPath);
  console.log("SQL length:", sql.length);

  try {
    await pool.query(sql);
    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    throw error;
  } finally {
    await pool.end();
  }
}

initDatabase().catch(() => process.exit(1));