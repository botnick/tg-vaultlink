/**
 * User repository — Telegram-identified accounts.
 *
 * A thin SQL wrapper around the `users` table. Reads return raw row shapes;
 * the upsert path is split into a primary `insert` (fresh registration) and
 * a generic `update` that builds its SET clause from the keys actually
 * present in the patch. `setBanned` is a deliberate convenience wrapper
 * because the ban toggle is the only column we want to be able to flip in
 * isolation without spelling it out at every call site.
 */

import type { Db } from '../db/database.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { UserRow, UserRole } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

type UpdatableField = 'username' | 'first_name' | 'last_name' | 'locale' | 'role';

export class UserRepository {
  private readonly findByTelegramIdStmt;
  private readonly findByIdStmt;
  private readonly insertStmt;
  private readonly setBannedStmt;
  private readonly countAllStmt;
  private readonly listStmt;
  private readonly listByRoleStmt;

  constructor(private readonly db: Db) {
    this.findByTelegramIdStmt = db.prepare('SELECT * FROM users WHERE telegram_user_id = ?');
    this.findByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');

    this.insertStmt = db.prepare(
      `INSERT INTO users (
         telegram_user_id, username, first_name, last_name, locale, role, is_banned, created_at, updated_at
       ) VALUES (
         @telegram_user_id, @username, @first_name, @last_name, @locale, @role, 0, @now, @now
       )
       RETURNING *`,
    );

    this.setBannedStmt = db.prepare(
      `UPDATE users SET is_banned = @banned, updated_at = @now WHERE id = @id RETURNING *`,
    );

    this.countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM users');
    this.listStmt = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT ? OFFSET ?');
    this.listByRoleStmt = db.prepare(
      'SELECT * FROM users WHERE role = ? ORDER BY id ASC LIMIT ? OFFSET ?',
    );
  }

  /** All users with the given role (e.g. `super_admin`). Stable order by id. */
  listByRole(role: UserRole, limit: number, offset: number): UserRow[] {
    return this.listByRoleStmt.all(role, limit, offset) as unknown as UserRow[];
  }

  findByTelegramId(telegramUserId: string): UserRow | undefined {
    return this.findByTelegramIdStmt.get(telegramUserId) as unknown as UserRow | undefined;
  }

  findById(id: number): UserRow | undefined {
    return this.findByIdStmt.get(id) as unknown as UserRow | undefined;
  }

  insert(input: {
    telegram_user_id: string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    locale: string | null;
    role?: UserRole;
  }): UserRow {
    const row = this.insertStmt.get({
      telegram_user_id: input.telegram_user_id,
      username: input.username,
      first_name: input.first_name,
      last_name: input.last_name,
      locale: input.locale,
      role: input.role ?? 'user',
      now: nowIso(),
    }) as unknown as UserRow | undefined;

    if (!row) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'User insert returned no row', {
        meta: { telegram_user_id: input.telegram_user_id },
      });
    }
    return row;
  }

  update(id: number, fields: Partial<Pick<UserRow, UpdatableField>>): UserRow {
    const allowed: UpdatableField[] = ['username', 'first_name', 'last_name', 'locale', 'role'];
    const params: Record<string, unknown> = { id, now: nowIso() };
    const setClauses: string[] = [];

    for (const key of allowed) {
      const value = fields[key];
      if (value !== undefined) {
        setClauses.push(`${key} = @${key}`);
        params[key] = value;
      }
    }
    setClauses.push('updated_at = @now');

    const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = @id RETURNING *`;
    const row = this.db.prepare(sql).get(params) as unknown as UserRow | undefined;
    if (!row) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, `User ${id} not found`, { meta: { id } });
    }
    return row;
  }

  setBanned(id: number, banned: boolean): UserRow {
    const row = this.setBannedStmt.get({
      id,
      banned: banned ? 1 : 0,
      now: nowIso(),
    }) as unknown as UserRow | undefined;
    if (!row) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, `User ${id} not found`, { meta: { id } });
    }
    return row;
  }

  countAll(): number {
    const row = this.countAllStmt.get() as { n: number };
    return row.n;
  }

  list(limit: number, offset: number): UserRow[] {
    return this.listStmt.all(limit, offset) as unknown as UserRow[];
  }
}
