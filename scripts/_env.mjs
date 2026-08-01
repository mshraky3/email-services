/** Load .env.local then .env, without a dotenv dependency (Node 21+). */
import { existsSync } from 'node:fs';

for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* already loaded, or unreadable — the caller will fail loudly if a var is missing */
    }
  }
}

export function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\n  Missing ${name}. Copy .env.example to .env.local and fill it in.\n`);
    process.exit(1);
  }
  return v;
}
