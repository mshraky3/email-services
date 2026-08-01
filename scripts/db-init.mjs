/**
 * Apply lib/schema.sql. Idempotent — safe to re-run after any schema change.
 *
 *   npm run db:init
 */
import './_env.mjs';
import { required } from './_env.mjs';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const connectionString = required('DATABASE_URL');
const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query(readFileSync('lib/schema.sql', 'utf8'));

  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`);

  console.log(`\n  Schema applied. ${rows.length} tables:\n`);
  for (const r of rows) console.log(`    - ${r.table_name}`);

  const { rows: ver } = await client.query(`SELECT v FROM schema_meta WHERE k = 'version'`);
  console.log(`\n  Schema version: ${ver[0]?.v ?? '?'}`);

  const { rows: settings } = await client.query(`SELECT k, v FROM quota_settings ORDER BY k`);
  console.log('\n  Settings:');
  for (const s of settings) console.log(`    ${s.k.padEnd(20)} ${s.v}`);

  console.log('\n  Mail is sent immediately on arrival — no queue, no scheduler.');
  console.log('  daily_budget is the point at which Resend hands over to Gmail.');
  console.log('\n  Next: npm run db:seed\n');
} finally {
  await client.end();
}
