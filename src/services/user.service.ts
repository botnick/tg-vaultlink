/**
 * VaultLink Bot — user lifecycle service.
 *
 * Owns the "ensure-or-update" pattern that every Telegram update applies:
 * resolve the local `users` row for the sender, creating it on first contact
 * and refreshing display fields on subsequent visits. The service also hosts
 * the central admin-check so handlers consistently honor both the persisted
 * `super_admin` role and the env-bootstrap `ADMIN_IDS` list.
 */

import type { Config } from '../config/env.js';
import type { UserRow, UserRole } from '../types/index.js';

export interface IUserRepository {
  findByTelegramId(telegramUserId: string): UserRow | undefined;
  findById(id: number): UserRow | undefined;
  insert(input: {
    telegram_user_id: string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    locale: string | null;
    role?: UserRole;
  }): UserRow;
  update(
    id: number,
    fields: Partial<Pick<UserRow, 'username' | 'first_name' | 'last_name' | 'locale' | 'role'>>,
  ): UserRow;
  setBanned(id: number, banned: boolean): UserRow;
}

/** Telegram `User` projection used by {@link UserService.ensureUser}. */
export interface TelegramUserInput {
  telegram_user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
}

export class UserService {
  private readonly repo: IUserRepository;
  private readonly config: Config;

  constructor(repo: IUserRepository, config: Config) {
    this.repo = repo;
    this.config = config;
  }

  /**
   * Resolve the local user for an incoming Telegram update. Creates the row
   * on first contact (locale derived from `language_code` with fallback to
   * `config.DEFAULT_LOCALE`) and patches `username`/`first_name`/`last_name`
   * when Telegram reports a different value than what's stored.
   */
  ensureUser(input: TelegramUserInput): UserRow {
    const existing = this.repo.findByTelegramId(input.telegram_user_id);
    if (!existing) {
      const locale = this.resolveLocale(input.language_code);
      return this.repo.insert({
        telegram_user_id: input.telegram_user_id,
        username: input.username,
        first_name: input.first_name,
        last_name: input.last_name,
        locale,
        role: 'user',
      });
    }

    const patch: Partial<Pick<UserRow, 'username' | 'first_name' | 'last_name'>> = {};
    if (existing.username !== input.username) patch.username = input.username;
    if (existing.first_name !== input.first_name) patch.first_name = input.first_name;
    if (existing.last_name !== input.last_name) patch.last_name = input.last_name;

    if (Object.keys(patch).length === 0) return existing;
    return this.repo.update(existing.id, patch);
  }

  /**
   * `true` when the user is either persistently a `super_admin` or their
   * Telegram id is listed in `ADMIN_IDS` (the bootstrap mechanism used
   * before any DB row exists).
   */
  isAdmin(user: UserRow): boolean {
    if (user.role === 'super_admin') return true;
    return this.config.ADMIN_IDS.includes(user.telegram_user_id);
  }

  /** Toggle the ban flag and return the refreshed row. */
  setBanned(user: UserRow, banned: boolean): UserRow {
    return this.repo.setBanned(user.id, banned);
  }

  private resolveLocale(languageCode: string | null): string {
    if (languageCode === 'th' || languageCode === 'en') return languageCode;
    return this.config.DEFAULT_LOCALE;
  }
}
