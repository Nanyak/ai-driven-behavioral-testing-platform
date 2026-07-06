import { applyMigrations, makePgPool } from "./postgres.js";

const pool = makePgPool();
try {
  await applyMigrations(pool);
  console.log("storage migrations applied");
} finally {
  await pool.end();
}
