import { Pool } from "pg";

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "minds",
  user: "postgres",
  password: "",
});

async function test() {
  console.log("Testing connection...");
  try {
    const result = await pool.query("SELECT 1 as test");
    console.log("Result:", result.rows);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await pool.end();
  }
}

test();