/**
 * VaultLink Bot — runtime settings service.
 *
 * Wraps the `settings` table with typed getters/setters so feature toggles
 * and tunables that admins flip from the bot UI can be read without each
 * call site re-implementing the parse logic. Storage is always a string
 * (matching the column type); booleans are normalized to the literals
 * `'true'`/`'false'` and numbers via `String(value)`.
 *
 * Callers that need a "fall back to env-config default" semantics should
 * combine the returned `undefined` with their own default — this layer never
 * invents values.
 */

import type { SettingsRow } from '../types/index.js';

export interface ISettingsRepository {
  get(key: string): SettingsRow | undefined;
  set(key: string, value: string): SettingsRow;
  delete(key: string): void;
  all(): SettingsRow[];
}

export class SettingsService {
  private readonly repo: ISettingsRepository;

  constructor(repo: ISettingsRepository) {
    this.repo = repo;
  }

  /** Raw string read; returns `undefined` when the key is not stored. */
  getString(key: string): string | undefined {
    return this.repo.get(key)?.value;
  }

  /**
   * Read a numeric setting. Returns `undefined` when the key is missing or
   * the stored value cannot be parsed as a finite number.
   */
  getNumber(key: string): number | undefined {
    const raw = this.getString(key);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  /**
   * Read a boolean setting. Recognizes only the canonical `'true'`/`'false'`
   * literals written by {@link setBoolean}; anything else is treated as
   * absent so a corrupt row never silently coerces to `false`.
   */
  getBoolean(key: string): boolean | undefined {
    const raw = this.getString(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }

  setString(key: string, value: string): void {
    this.repo.set(key, value);
  }

  setNumber(key: string, value: number): void {
    this.repo.set(key, String(value));
  }

  setBoolean(key: string, value: boolean): void {
    this.repo.set(key, value ? 'true' : 'false');
  }

  delete(key: string): void {
    this.repo.delete(key);
  }

  /** Snapshot of every key/value pair currently stored. */
  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.repo.all()) {
      out[row.key] = row.value;
    }
    return out;
  }
}
