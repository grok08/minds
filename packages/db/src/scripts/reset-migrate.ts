import { Pool } from "pg";

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "minds",
  user: "postgres",
  password: "",
});

async function resetAndMigrate() {
  console.log("Dropping tables...");
  await pool.query(`DROP TABLE IF EXISTS state_transitions, memory, approvals, executions, events, tasks, goals, minds CASCADE`);
  console.log("Tables dropped");

  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  const { fileURLToPath } = await import("url");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = join(__filename, "..");

  const migrationPath = join(__dirname, "..", "..", "migrations", "001_initial_schema.sql");
  const sql = readFileSync(migrationPath, "utf-8");
  
  console.log("Running migration...");
  await pool.query(sql);
  console.log("Migration completed successfully");
  
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  console.log("Tables:", tables.rows);
  
  await pool.end();
}

resetAndMigrate().catch(console.error);