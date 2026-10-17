// Applies backend/schema.sql to the TigerData service in DATABASE_URL, then
// proves the round trip: inserts one telemetry row, reads it back through the
// telemetry_1m continuous aggregate, and lists the hypertables.
//   npm run db:init
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPgPool } from './server.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set (put it in .env and run `npm run db:init`).');
  process.exit(1);
}

const pool = await createPgPool({ databaseUrl, pgCaFile: process.env.PG_CA_FILE || null });
const sql = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
// Statements run one at a time: continuous aggregates cannot be created
// inside a transaction block, and one already-applied policy must not stop
// the rest.
const statements = sql
  .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
  .split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);

let failed = 0;
for (const statement of statements) {
  try {
    await pool.query(statement);
    console.log(`ok    ${statement.split('\n')[0].slice(0, 90)}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${statement.split('\n')[0].slice(0, 90)}\n      ${err.message}`);
  }
}

const probe = new Date().toISOString();
await pool.query(
  `INSERT INTO telemetry (observed_at, drone_id, provenance, battery_pct, altitude_m, payload)
   VALUES ($1, 'db-init-probe', 'db-init', 100, 0, $2)`,
  [probe, JSON.stringify({ observed_at: probe, drone_id: 'db-init-probe', provenance: 'db-init' })],
);
const { rows: readBack } = await pool.query(
  `SELECT bucket, samples FROM telemetry_1m WHERE drone_id = 'db-init-probe' ORDER BY bucket DESC LIMIT 1`,
);
await pool.query(`DELETE FROM telemetry WHERE drone_id = 'db-init-probe'`);
const { rows: hypertables } = await pool.query(
  'SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1',
);
console.log(`\ninsert + read-back via telemetry_1m: ${readBack.length ? `ok (bucket ${new Date(readBack[0].bucket).toISOString()})` : 'FAILED'}`);
console.log(`hypertables: ${hypertables.map((r) => r.hypertable_name).join(', ')}`);
console.log(failed ? `${failed} statement(s) failed — see above (already-applied settings are safe to ignore)` : 'schema applied cleanly');
await pool.end();
