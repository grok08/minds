import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "minds",
  user: "postgres",
  password: "",
});

async function runMigration() {
  console.log("Running migrations...");
  
  const migrationsDir = join(__dirname, "..", "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  
  for (const file of files) {
    const migrationPath = join(migrationsDir, file);
    console.log("Running migration:", file);
    
    const sql = readFileSync(migrationPath, "utf-8");
    
    try {
      await pool.query(sql);
      console.log(`Migration ${file} completed successfully`);
    } catch (error) {
      console.error(`Migration ${file} failed:`, error);
      throw error;
    }
  }
  
  // Verify tables
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  console.log("Tables:", tables.rows);
  
  await pool.end();
}

runMigration();