const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { DATABASE_URL } = require("../config/env");

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on("error", (error) => console.error("PostgreSQL:", error));

const query = (text, params) => pool.query(text, params);

async function initializeDatabase() {
  if (!DATABASE_URL) return;
  const schemaPath = path.resolve(__dirname, "..", "..", "..", "database", "schema.sql");
  await pool.query(fs.readFileSync(schemaPath, "utf8"));
  console.log("Database schema is ready");
}

module.exports = {
  pool,
  query,
  initializeDatabase,
  closeDatabase: () => pool.end(),
};
