/**
 * Settings repository — runtime-mutable key/value store.
 *
 * Values are always strings (a setting that needs structure stores JSON and
 * the calling service parses it). `set` is an UPSERT that returns the row,
 * so callers get the updated `updated_at` for free without a follow-up read.
 */

import type { Db } from '../db/database.js';
import type { SettingsRow } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export class SettingsRepository {
  private readonly getStmt;
  private readonly setStmt;
  private readonly deleteStmt;
  private readonly allStmt;

  constructor(private readonly db: Db) {
    this.getStmt = db.prepare('SELECT * FROM settings WHERE key = ?');
    this.setStmt = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @now)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       RETURNING *`,
    );
    this.deleteStmt = db.prepare('DELETE FROM settings WHERE key = ?');
    this.allStmt = db.prepare('SELECT * FROM settings ORDER BY key ASC');
  }

  get(key: string): SettingsRow | undefined {
    return this.getStmt.get(key) as unknown as SettingsRow | undefined;
  }

  set(key: string, value: string): SettingsRow {
    return this.setStmt.get({ key, value, now: nowIso() }) as unknown as SettingsRow;
  }

  delete(key: string): void {
    this.deleteStmt.run(key);
  }

  all(): SettingsRow[] {
    return this.allStmt.all() as unknown as SettingsRow[];
  }
}
