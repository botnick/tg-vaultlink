/**
 * VaultLink Bot — migration runner.
 *
 * Walks `src/db/migrations/` (resolved relative to this module so it works
 * identically under `tsx`, the compiled `dist/` build, and Vitest), applies
 * any `*.sql` file that has not already been recorded in the
 * `schema_migrations` table, and exposes a small CLI entry point so
 * `pnpm db:migrate` and `pnpm db:reset` Just Work.
 *
 * Migration files are named `NNN_<slug>.sql` where `NNN` is a zero-padded
 * version. The version string is the prefix before the first underscore
 * (`001_init.sql` → `001`). Sorting is plain lexicographic on the filename;
 * the zero-padding keeps the order correct without a custom comparator.
 *
 * Each migration runs inside a single transaction together with the
 * `schema_migrations` insert, so a partially applied file leaves no trace and
 * can be retried safely. On failure the transaction is rolled back and the
 * underlying error is rethrown as an {@link AppError} carrying
 * `DB_MIGRATION_FAILED`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIGRATIONS_DIR_NAME, SCHEMA_MIGRATIONS_TABLE } from '../config/constants.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { getLogger } from '../logger/logger.js';
import { getDatabase, type DB } from './database.js';

/* ------------------------------------------------------------------------- *
 * Public types
 * ------------------------------------------------------------------------- */

/** Description of a single discovered migration file. */
export interface MigrationFile {
  /** Lexicographic version string parsed from the filename prefix (`001`). */
  version: string;
  /** Filename without the leading directory (`001_init.sql`). */
  name: string;
  /** Raw SQL contents of the file. */
  sql: string;
  /** Absolute path to the file on disk. */
  absPath: string;
}

/** Result returned from {@link runMigrations}. */
export interface MigrationResult {
  /** Versions applied during this invocation, in order. */
  applied: string[];
  /** Versions that were already recorded in `schema_migrations`. */
  alreadyApplied: string[];
}

/* ------------------------------------------------------------------------- *
 * Filesystem helpers
 * ------------------------------------------------------------------------- */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the on-disk migrations directory. The runner is shipped both as
 * `src/db/migrate.ts` (run via `tsx`) and `dist/db/migrate.js` (run via
 * `node`); in both cases the SQL files live in a sibling `migrations/`
 * directory. When running from `dist/` we transparently fall back to the
 * source tree so the build pipeline does not have to copy `.sql` files.
 */
function resolveMigrationsDir(): string {
  const sibling = path.join(HERE, MIGRATIONS_DIR_NAME);
  if (fs.existsSync(sibling)) return sibling;

  // dist/db/migrate.js → ../../src/db/migrations
  const fromDist = path.resolve(HERE, '..', '..', 'src', 'db', MIGRATIONS_DIR_NAME);
  if (fs.existsSync(fromDist)) return fromDist;

  throw new AppError(
    ErrorCode.DB_MIGRATION_FAILED,
    `migrations directory not found (looked in ${sibling} and ${fromDist})`,
  );
}

/** Extract the version segment (everything before the first `_`) from a filename. */
function versionFromName(name: string): string {
  const base = name.replace(/\.sql$/i, '');
  const idx = base.indexOf('_');
  return idx === -1 ? base : base.slice(0, idx);
}

/** Discover and load every migration on disk, sorted lexicographically by filename. */
export function loadMigrationFiles(): MigrationFile[] {
  const dir = resolveMigrationsDir();
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.sql'))
    .map((d) => d.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return names.map((name) => {
    const absPath = path.join(dir, name);
    let sql: string;
    try {
      sql = fs.readFileSync(absPath, 'utf8');
    } catch (cause) {
      throw new AppError(
        ErrorCode.DB_MIGRATION_FAILED,
        `failed to read migration ${name}`,
        { cause, meta: { name, absPath } },
      );
    }
    return { version: versionFromName(name), name, sql, absPath };
  });
}

/* ------------------------------------------------------------------------- *
 * Schema bookkeeping
 * ------------------------------------------------------------------------- */

function ensureMigrationsTable(db: DB): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
       version TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     );`,
  );
}

/**
 * Return the sorted list of migration versions already recorded in
 * `schema_migrations`. Defaults to the singleton handle when no `db` is
 * passed (matching the rest of the runner).
 */
export function appliedVersions(db?: DB): string[] {
  const conn = db ?? getDatabase();
  ensureMigrationsTable(conn);
  return conn
    .prepare<[], { version: string }>(
      `SELECT version FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY version ASC`,
    )
    .all()
    .map((r) => r.version);
}

/* ------------------------------------------------------------------------- *
 * Reset
 * ------------------------------------------------------------------------- */

interface SqliteObjectRow {
  type: 'table' | 'index' | 'view' | 'trigger';
  name: string;
}

/**
 * Drop every user-defined object (tables, indexes, views, triggers) except
 * the `schema_migrations` bookkeeping table itself, then clear the
 * bookkeeping rows so the next pass re-applies every migration. Wrapped in a
 * single transaction so a failure mid-drop leaves the database untouched.
 */
function performReset(db: DB): void {
  ensureMigrationsTable(db);

  const objects = db
    .prepare<[], SqliteObjectRow>(
      `SELECT type, name FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
          AND name <> '${SCHEMA_MIGRATIONS_TABLE}'
          AND type IN ('table','index','view','trigger')`,
    )
    .all();

  // Drop in dependency-friendly order: triggers first, then views, indexes,
  // tables. Within each bucket SQLite handles the rest.
  const order: SqliteObjectRow['type'][] = ['trigger', 'view', 'index', 'table'];
  const buckets = new Map<SqliteObjectRow['type'], string[]>();
  for (const t of order) buckets.set(t, []);
  for (const o of objects) {
    const list = buckets.get(o.type);
    if (list) list.push(o.name);
  }

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      for (const t of order) {
        for (const name of buckets.get(t) ?? []) {
          const quoted = `"${name.replace(/"/g, '""')}"`;
          // SQLite auto-drops indexes that belong to a dropped table, so the
          // earlier index drops may be redundant — `DROP ... IF EXISTS` keeps
          // that idempotent.
          db.exec(`DROP ${t.toUpperCase()} IF EXISTS ${quoted};`);
        }
      }
      db.exec(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE};`);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/* ------------------------------------------------------------------------- *
 * Apply
 * ------------------------------------------------------------------------- */

/**
 * Apply every migration that has not yet been recorded in
 * `schema_migrations`. Operates on the singleton handle returned by
 * {@link getDatabase}.
 *
 * @param opts.reset If true, drop every user object except
 *   `schema_migrations`, clear the bookkeeping table, and re-apply every
 *   migration from scratch. Always followed by a normal apply pass.
 */
export async function runMigrations(
  opts: { reset?: boolean } = {},
): Promise<MigrationResult> {
  const log = getLogger();
  const db = getDatabase();
  const files = loadMigrationFiles();

  ensureMigrationsTable(db);

  if (opts.reset) {
    log.warn('--reset requested; dropping all user objects and re-applying migrations');
    try {
      performReset(db);
    } catch (cause) {
      throw new AppError(
        ErrorCode.DB_MIGRATION_FAILED,
        'failed to reset database',
        { cause },
      );
    }
  }

  const already = new Set(appliedVersions(db));
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  const insert = db.prepare(
    `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}(version, applied_at) VALUES (?, datetime('now'))`,
  );

  for (const file of files) {
    if (already.has(file.version)) {
      result.alreadyApplied.push(file.version);
      log.debug({ version: file.version }, 'migration already applied');
      continue;
    }

    const apply = db.transaction((sql: string, version: string) => {
      db.exec(sql);
      insert.run(version);
    });

    try {
      apply(file.sql, file.version);
      result.applied.push(file.version);
      log.info({ version: file.version }, `applied migration ${file.version}`);
    } catch (cause) {
      throw new AppError(
        ErrorCode.DB_MIGRATION_FAILED,
        `failed to apply migration ${file.version}`,
        { cause, meta: { version: file.version, name: file.name } },
      );
    }
  }

  return result;
}

/* ------------------------------------------------------------------------- *
 * Boot-time guard
 * ------------------------------------------------------------------------- */

/**
 * Verify that every migration on disk has been recorded in
 * `schema_migrations`. Intended to be called from app boot (or the
 * healthcheck) so the bot refuses to start against an out-of-date database
 * instead of silently corrupting state.
 *
 * @throws {AppError} `DB_MIGRATION_FAILED` if at least one migration file
 *   has no corresponding row in `schema_migrations`.
 */
export function ensureMigrationsApplied(): void {
  const db = getDatabase();
  const files = loadMigrationFiles();
  const applied = new Set(appliedVersions(db));
  const missing = files.map((f) => f.version).filter((v) => !applied.has(v));

  if (missing.length > 0) {
    throw new AppError(
      ErrorCode.DB_MIGRATION_FAILED,
      `database schema is out of date; pending migrations: ${missing.join(', ')}`,
      { meta: { missing } },
    );
  }
}

/* ------------------------------------------------------------------------- *
 * CLI entry point
 * ------------------------------------------------------------------------- */

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isCli) {
  try {
    const reset = process.argv.includes('--reset');
    const { applied, alreadyApplied } = await runMigrations({ reset });
    const log = getLogger();
    log.info({ applied, alreadyApplied }, 'migrations complete');
    process.stdout.write('✔ migrations up-to-date\n');
    process.exit(0);
  } catch (e) {
    getLogger().error({ err: e }, 'migrations failed');
    process.exit(1);
  }
}
