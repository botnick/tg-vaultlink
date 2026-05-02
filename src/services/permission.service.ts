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
  CollectionRow,
  BotPermissionType,
} from '../types/index.js';
import type { PermissionRepository } from '../repositories/permission.repository.js';
import type { BotRepository } from '../repositories/bot.repository.js';
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
  private readonly config: Config;
  private readonly bots: BotRepository;

  constructor(
    repo: PermissionRepository,
    userService: UserService,
    config: Config,
    bots: BotRepository,
  ) {
    this.repo = repo;
    this.userService = userService;
    this.config = config;
    this.bots = bots;
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
      case 'personal_public': {
        // Public mode (main bot AND any personal_public bot): anyone who
        // isn't explicitly denied can upload. The bot owner can still
        // ban specific abusers via `/deny <user_id>` or `/deny_upload`.
        if (isOwner) return ALLOW;
        if (this.has(bot.id, user.id, 'deny') || this.has(bot.id, user.id, 'deny_upload')) {
          return deny('denied');
        }
        return ALLOW;
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

  /**
   * Can the user moderate (lock/unlock/delete) THIS file?
   *
   * Strictly more permissive than {@link canManageFile}: a bot owner can
   * moderate any file on their bot even if someone else uploaded it. This
   * gives the bot owner per-bot admin powers without leaking system-wide
   * admin actions (ban, broadcast, cross-bot moderation).
   *
   * The bot lookup is done HERE — the caller passes the file row and we
   * resolve `bot.owner_user_id` ourselves so a forged file_id can't
   * sidestep the check.
   */
  canModerateFile(user: UserRow, file: FileRow): PermissionDecision {
    if (this.isBanned(user)) return deny('banned');
    if (this.isAdmin(user)) return ALLOW;
    if (file.owner_user_id === user.id) return ALLOW;
    const bot = this.bots.findById(file.bot_id);
    if (bot && bot.owner_user_id === user.id) return ALLOW;
    return deny('not_owner');
  }

  /** Same policy as {@link canModerateFile}, scoped to a Collection row. */
  canModerateCollection(user: UserRow, collection: CollectionRow): PermissionDecision {
    if (this.isBanned(user)) return deny('banned');
    if (this.isAdmin(user)) return ALLOW;
    if (collection.owner_user_id === user.id) return ALLOW;
    const bot = this.bots.findById(collection.bot_id);
    if (bot && bot.owner_user_id === user.id) return ALLOW;
    return deny('not_owner');
  }

  /**
   * Coarse "is this user a moderator of anything?" gate. True for system
   * admins and for any user who currently owns at least one managed bot.
   *
   * This is the right check for the `/admin` menu entry point and for the
   * top-level moderator middleware: actual per-action authorization still
   * happens via {@link canModerateFile} / {@link canModerateCollection}
   * inside the handler.
   */
  isModerator(user: UserRow): boolean {
    if (this.isBanned(user)) return false;
    if (this.isAdmin(user)) return true;
    return this.bots.countByOwner(user.id) > 0;
  }

  private isBanned(user: UserRow): boolean {
    return user.is_banned === 1;
  }

  private has(botId: number, userId: number, perm: BotPermissionType): boolean {
    return this.repo.has(botId, userId, perm);
  }
}
