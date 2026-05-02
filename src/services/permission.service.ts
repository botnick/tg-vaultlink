/**
 * VaultLink Bot — central authorization service.
 *
 * The single source of truth for "may user X perform action Y on bot/file Z".
 * Every router, command handler, and downstream service routes through here
 * instead of inlining its own role checks; this keeps the policy surface in
 * one auditable place and makes it trivial to evolve the matrix without
 * hunting through call sites.
 *
 * The service is a pure decision engine — it does not enqueue audit log
 * entries, throw, or mutate state. Callers receive a structured
 * {@link PermissionDecision} with an optional `reason` they can map onto
 * a localized response.
 */

import type { Config } from '../config/env.js';
import type {
  ManagedBotRow,
  UserRow,
  FileRow,
  BotPermissionType,
} from '../types/index.js';
import type { PermissionRepository } from '../repositories/permission.repository.js';
import type { UserService } from './user.service.js';

export interface PermissionDecision {
  allowed: boolean;
  reason?: 'banned' | 'feature_disabled' | 'mode_restricted' | 'denied' | 'not_owner';
}

const ALLOW: PermissionDecision = { allowed: true };

function deny(reason: NonNullable<PermissionDecision['reason']>): PermissionDecision {
  return { allowed: false, reason };
}

export class PermissionService {
  private readonly repo: PermissionRepository;
  private readonly userService: UserService;
  // Held for forward-compat (feature toggles may reference config in future
  // policy revisions); referenced once below to satisfy "noUnusedLocals" while
  // keeping the constructor surface stable.
  private readonly config: Config;

  constructor(repo: PermissionRepository, userService: UserService, config: Config) {
    this.repo = repo;
    this.userService = userService;
    this.config = config;
    // Touch the field so strict unused-property checks treat it as used.
    void this.config;
  }

  /** Is the user a system admin (super_admin role OR ADMIN_IDS bootstrap)? */
  isAdmin(user: UserRow): boolean {
    return this.userService.isAdmin(user);
  }

  /** Can the user upload a file via this bot? */
  canUpload(user: UserRow, bot: ManagedBotRow): PermissionDecision {
    if (this.isBanned(user)) return deny('banned');
    if (this.isAdmin(user)) return ALLOW;

    const isOwner = bot.owner_user_id === user.id;

    switch (bot.mode) {
      case 'main_public':
        // Main public bot: anyone (non-banned) can upload.
        return ALLOW;

      case 'personal_public': {
        if (isOwner) return ALLOW;
        if (this.has(bot.id, user.id, 'deny') || this.has(bot.id, user.id, 'deny_upload')) {
          return deny('denied');
        }
        if (this.has(bot.id, user.id, 'allow_upload')) return ALLOW;
        // Personal-public bots are publicly *downloadable* but uploads are
        // gated to the owner + explicitly-permitted users.
        return deny('mode_restricted');
      }

      case 'personal_private': {
        if (isOwner) return ALLOW;
        if (this.has(bot.id, user.id, 'deny') || this.has(bot.id, user.id, 'deny_upload')) {
          return deny('denied');
        }
        if (this.has(bot.id, user.id, 'allow_upload')) return ALLOW;
        return deny('mode_restricted');
      }
    }
  }

  /**
   * Can the user download a file via this bot?
   *
   * State checks (locked / deleted / expired) live in {@link FileService} —
   * this method only enforces the bot-mode/role matrix. The `file` argument
   * is accepted for forward-compat (per-file ACLs) but is currently unused.
   */
  canDownload(user: UserRow, bot: ManagedBotRow, _file: FileRow): PermissionDecision {
    if (this.isBanned(user)) return deny('banned');
    if (this.isAdmin(user)) return ALLOW;

    const isOwner = bot.owner_user_id === user.id;

    switch (bot.mode) {
      case 'main_public':
      case 'personal_public': {
        if (isOwner) return ALLOW;
        if (this.has(bot.id, user.id, 'deny')) return deny('denied');
        return ALLOW;
      }

      case 'personal_private': {
        if (isOwner) return ALLOW;
        if (this.has(bot.id, user.id, 'deny')) return deny('denied');
        if (this.has(bot.id, user.id, 'allow') || this.has(bot.id, user.id, 'allow_upload')) {
          return ALLOW;
        }
        return deny('mode_restricted');
      }
    }
  }

  /** Can the user manage (delete/lock/password/expiry) this file? */
  canManageFile(user: UserRow, file: FileRow): PermissionDecision {
    if (this.isBanned(user)) return deny('banned');
    if (this.isAdmin(user)) return ALLOW;
    if (file.owner_user_id === user.id) return ALLOW;
    return deny('not_owner');
  }

  /** Can the user manage a bot (set mode, allow/deny others, remove)? */
  canManageBot(user: UserRow, bot: ManagedBotRow): PermissionDecision {
    if (this.isBanned(user)) return deny('banned');
    if (this.isAdmin(user)) return ALLOW;
    if (bot.owner_user_id === user.id) return ALLOW;
    return deny('not_owner');
  }

  private isBanned(user: UserRow): boolean {
    return user.is_banned === 1;
  }

  private has(botId: number, userId: number, perm: BotPermissionType): boolean {
    return this.repo.has(botId, userId, perm);
  }
}
