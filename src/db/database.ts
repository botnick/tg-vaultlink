/**
 * VaultLink Bot — SQLite connection factory.
 *
 * Wraps `better-sqlite3` with a small singleton helper so the rest of the app
 * can reach the database without threading a handle through every module. The
 * connection is opened against {@link Config.DATABASE_PATH} (resolved relative
 * to `process.cwd()`) and configured with the WAL pragmas the rest of the
 * codebase expects:
 *
 *   - `journal_mode = WAL`        — concurrent readers, single writer
 *   - `synchronous = NORMAL`      — durable enough for our workload
 *   - `foreign_keys = ON`         — enforce referential integrity
 *   - `busy_timeout = 5000`       — wait 5s before raising SQLITE_BUSY
 *
 * If the underlying open fails (permission denied, missing parent dir that
 * could not be created, corrupt database, etc.) the runtime never silently
 * swaps to an in-memory database; an {@link AppError} with `DB_OPEN_FAILED`
 * is thrown so the caller can decide what to do. Tests that need an isolated
 * in-memory database open one directly via {@link openDatabase}; this module
 * intentionally has no fallback path.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { getConfig } from '../config/env.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { getLogger } from '../logger/logger.js';

/** Concrete instance type of a `better-sqlite3` database connection. */
export type DB = Database.Database;

/**
 * Back-compat alias for {@link DB}. Repository modules historically imported
 * the type as `Db`; both spellings refer to the same `better-sqlite3`
 * connection handle.
 */
export type Db = DB;

/**
 * Open a fresh database connection at `dbPath`. The path is resolved against
 * `process.cwd()` so relative values such as `./data/vaultlink.db` land in the
 * project root regardless of how the process was launched. The parent
 * directory is created on demand (`mkdir -p` semantics). The literal value
 * `:memory:` is honored as an in-memory database without any filesystem work.
 *
 * @throws {AppError} `DB_OPEN_FAILED` if the file cannot be opened or the
 *   parent directory cannot be created.
 */
export function openDatabase(dbPath: string): DB {
  const isMemory = dbPath === ':memory:';
  const absolutePath = isMemory ? ':memory:' : path.resolve(process.cwd(), dbPath);

  if (!isMemory) {
    const parentDir = path.dirname(absolutePath);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (cause) {
      throw new AppError(
        ErrorCode.DB_OPEN_FAILED,
        'unable to open database',
        { cause, meta: { path: absolutePath, stage: 'mkdir' } },
      );
    }
  }

  let db: DB;
  try {
    db = new Database(absolutePath, { fileMustExist: false });
  } catch (cause) {
    throw new AppError(
      ErrorCode.DB_OPEN_FAILED,
      'unable to open database',
      { cause, meta: { path: absolutePath } },
    );
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  } catch (cause) {
    try {
      db.close();
    } catch {
      // Closing a freshly-opened handle should not fail; ignore so the
      // original pragma error is the one surfaced to the caller.
    }
    throw new AppError(
      ErrorCode.DB_OPEN_FAILED,
      'unable to open database',
      { cause, meta: { path: absolutePath, stage: 'pragma' } },
    );
  }

  return db;
}

let cached: DB | undefined;
let cachedPath: string | undefined;

/**
 * Lazily open and cache the process-wide database handle. Subsequent calls
 * return the same instance until {@link closeDatabase} or
 * {@link resetDatabaseForTests} is invoked.
 */
export function getDatabase(): DB {
  if (cached) return cached;

  const config = getConfig();
  const absolutePath = config.DATABASE_PATH === ':memory:'
    ? ':memory:'
    : path.resolve(process.cwd(), config.DATABASE_PATH);

  try {
    cached = openDatabase(config.DATABASE_PATH);
    cachedPath = absolutePath;
    getLogger().info({ path: absolutePath }, 'db opened');
    return cached;
  } catch (err) {
    getLogger().error({ err, path: absolutePath }, 'failed to open database');
    throw err;
  }
}

/** Close the singleton connection if it is currently open. Idempotent. */
export function closeDatabase(): void {
  if (!cached) return;
  try {
    cached.close();
    if (cachedPath) {
      getLogger().info({ path: cachedPath }, 'db closed');
    }
  } catch {
    // Closing should not raise on a healthy handle; if it does, the singleton
    // is still cleared below so a subsequent open can succeed.
  } finally {
    cached = undefined;
    cachedPath = undefined;
  }
}

/**
 * Test-only hook that closes the cached singleton (if any) and clears the
 * memoized handle. Equivalent to {@link closeDatabase} today; exposed under a
 * distinct name so test helpers communicate intent and can evolve
 * independently of production close semantics.
 */
export function resetDatabaseForTests(): void {
  closeDatabase();
}
