/**
 * VaultLink Bot — Docker HEALTHCHECK script.
 *
 * One-shot: opens the database, asserts every migration on disk has been
 * recorded in `schema_migrations`, then closes and exits 0. Any error
 * reduces to exit 1 with a short stderr message — Docker only looks at the
 * exit code, but the message is useful when debugging container logs.
 */

import { getDatabase, closeDatabase } from './db/database.js';
import { ensureMigrationsApplied } from './db/migrate.js';

try {
  // Open the connection (validates DATABASE_PATH + WAL pragmas) before the
  // migration check actually queries `schema_migrations`.
  getDatabase();
  ensureMigrationsApplied();
  closeDatabase();
  process.exit(0);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('healthcheck failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
