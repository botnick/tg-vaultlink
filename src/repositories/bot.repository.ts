/**
 * Managed-bot repository — owner-supplied child bots.
 *
 * Tokens are stored as `(encrypted_token, token_nonce, token_auth_tag)` — the
 * AES-GCM tuple from `crypto.ts`. We never decrypt here; that's strictly the
 * crypto layer's job. Status flips (`active` -> `error`/`removed`) keep the
 * row around so an owner who re-adds the same token can be matched against
 * history. Newly inserted bots default to `status='active'` via the column
 * DEFAULT and we let the schema set `last_error = NULL`.
 */

import type { Db } from '../db/database.js';
import type { BotMode, BotStatus, ManagedBotRow } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export class BotRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly findByUsernameStmt;
  private readonly findByTelegramBotIdStmt;
  private readonly listByOwnerStmt;
  private readonly listActiveStmt;
  private readonly listAllStmt;
  private readonly setStatusStmt;
  private readonly setModeStmt;
  private readonly countAllStmt;
  private readonly countByStatusStmt;
  private readonly countByOwnerStmt;

  constructor(private readonly db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO managed_bots (
         owner_user_id, telegram_bot_id, username, display_name,
         encrypted_token, token_nonce, token_auth_tag,
         mode, created_at, updated_at
       ) VALUES (
         @owner_user_id, @telegram_bot_id, @username, @display_name,
         @encrypted_token, @token_nonce, @token_auth_tag,
         @mode, @now, @now
       )
       RETURNING *`,
    );

    this.findByIdStmt = db.prepare('SELECT * FROM managed_bots WHERE id = ?');
    this.findByUsernameStmt = db.prepare('SELECT * FROM managed_bots WHERE username = ?');
    this.findByTelegramBotIdStmt = db.prepare(
      'SELECT * FROM managed_bots WHERE telegram_bot_id = ?',
    );

    this.listByOwnerStmt = db.prepare(
      'SELECT * FROM managed_bots WHERE owner_user_id = ? ORDER BY id ASC',
    );
    this.listActiveStmt = db.prepare(
      "SELECT * FROM managed_bots WHERE status = 'active' ORDER BY id ASC",
    );
    this.listAllStmt = db.prepare('SELECT * FROM managed_bots ORDER BY id ASC LIMIT ? OFFSET ?');

    this.setStatusStmt = db.prepare(
      `UPDATE managed_bots
         SET status = @status, last_error = @last_error, updated_at = @now
       WHERE id = @id
       RETURNING *`,
    );
    this.setModeStmt = db.prepare(
      `UPDATE managed_bots
         SET mode = @mode, updated_at = @now
       WHERE id = @id
       RETURNING *`,
    );

    this.countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM managed_bots');
    this.countByStatusStmt = db.prepare('SELECT COUNT(*) AS n FROM managed_bots WHERE status = ?');
    this.countByOwnerStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM managed_bots WHERE owner_user_id = ?',
    );
  }

  insert(input: {
    owner_user_id: number;
    telegram_bot_id: string;
    username: string;
    display_name: string | null;
    encrypted_token: string;
    token_nonce: string;
    token_auth_tag: string;
    mode: BotMode;
  }): ManagedBotRow {
    return this.insertStmt.get({ ...input, now: nowIso() }) as unknown as ManagedBotRow;
  }

  findById(id: number): ManagedBotRow | undefined {
    return this.findByIdStmt.get(id) as unknown as ManagedBotRow | undefined;
  }

  findByUsername(username: string): ManagedBotRow | undefined {
    return this.findByUsernameStmt.get(username) as unknown as ManagedBotRow | undefined;
  }

  findByTelegramBotId(telegramBotId: string): ManagedBotRow | undefined {
    return this.findByTelegramBotIdStmt.get(telegramBotId) as unknown as ManagedBotRow | undefined;
  }

  listByOwner(ownerUserId: number): ManagedBotRow[] {
    return this.listByOwnerStmt.all(ownerUserId) as unknown as ManagedBotRow[];
  }

  listActive(): ManagedBotRow[] {
    return this.listActiveStmt.all() as unknown as ManagedBotRow[];
  }

  listAll(opts?: { limit?: number; offset?: number }): ManagedBotRow[] {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    return this.listAllStmt.all(limit, offset) as unknown as ManagedBotRow[];
  }

  setStatus(
    id: number,
    status: BotStatus,
    last_error: string | null = null,
  ): ManagedBotRow | undefined {
    return this.setStatusStmt.get({
      id,
      status,
      last_error,
      now: nowIso(),
    }) as unknown as ManagedBotRow | undefined;
  }

  setMode(id: number, mode: BotMode): ManagedBotRow | undefined {
    return this.setModeStmt.get({
      id,
      mode,
      now: nowIso(),
    }) as unknown as ManagedBotRow | undefined;
  }

  countAll(): number {
    const row = this.countAllStmt.get() as { n: number };
    return row.n;
  }

  countByStatus(status: BotStatus): number {
    const row = this.countByStatusStmt.get(status) as { n: number };
    return row.n;
  }

  countByOwner(ownerUserId: number): number {
    const row = this.countByOwnerStmt.get(ownerUserId) as { n: number };
    return row.n;
  }
}
