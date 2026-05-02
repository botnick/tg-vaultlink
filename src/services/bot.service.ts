/**
 * VaultLink Bot — managed (child) bot service.
 *
 * Owns the lifecycle of owner-supplied Telegram bots: validating a freshly
 * pasted token, calling Telegram's `getMe` to confirm it's live, encrypting
 * the secret at rest, and exposing controlled mutations (status, mode,
 * removal) to the rest of the system. The Telegram round-trip is injected
 * via {@link GetMeFn} so this service stays unit-testable without a network
 * dependency; the production wiring is provided by Wave 4.
 *
 * Token plaintext only ever exists transiently inside `addBot` and
 * `decryptToken`; nothing in the audit log or error paths echoes it back.
 */

import type { Config } from '../config/env.js';
import type { ManagedBotRow, UserRow, BotMode } from '../types/index.js';
import type { BotRepository } from '../repositories/bot.repository.js';
import type { AuditService } from './audit.service.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import {
  isValidTelegramToken,
  parseTelegramBotId,
  maskToken,
} from '../utils/telegramToken.js';
import { encryptToken, decryptToken } from './tokenCrypto.service.js';
import { TELEGRAM_BOT_USERNAME_REGEX } from '../config/constants.js';

export interface AddBotInput {
  owner: UserRow;
  rawToken: string;
  mode: 'personal_public' | 'personal_private';
}

/** Subset of Telegram's `getMe` response used by the registration flow. */
export interface BotInfo {
  /** Telegram numeric `bot_id`, stringified. */
  id: string;
  /** Bot username with the leading `@` stripped. */
  username: string;
  firstName: string;
  canJoinGroups?: boolean;
  canReadAllGroupMessages?: boolean;
  supportsInlineQueries?: boolean;
}

/**
 * Pluggable Telegram callback. Wave 4 provides the real implementation that
 * speaks to the Bot API; tests inject a fake. Implementations must throw on
 * any kind of failure (network, 401, malformed body) — the caller treats any
 * thrown value as "token is bad".
 */
export type GetMeFn = (token: string, apiBaseUrl: string) => Promise<BotInfo>;

export class BotService {
  private readonly bots: BotRepository;
  private readonly audit: AuditService;
  private readonly config: Config;
  private readonly getMe: GetMeFn;

  constructor(
    bots: BotRepository,
    audit: AuditService,
    config: Config,
    getMeFn: GetMeFn,
  ) {
    this.bots = bots;
    this.audit = audit;
    this.config = config;
    this.getMe = getMeFn;
  }

  /**
   * Register a new managed bot.
   *
   *   1. Validate token shape.
   *   2. Confirm the token isn't already on file.
   *   3. Hand it to Telegram (`getMe`) to confirm liveness + harvest username.
   *   4. Re-check uniqueness on the username (rare race).
   *   5. Encrypt + insert.
   *   6. Audit the action.
   */
  async addBot(input: AddBotInput): Promise<ManagedBotRow> {
    const token = input.rawToken.trim();
    if (!isValidTelegramToken(token)) {
      throw new AppError(ErrorCode.BOT_TOKEN_INVALID, 'invalid telegram bot token', {
        expose: true,
      });
    }

    const telegramBotId = parseTelegramBotId(token);

    const existing = this.bots.findByTelegramBotId(telegramBotId);
    if (existing) {
      throw new AppError(
        ErrorCode.BOT_ALREADY_EXISTS,
        'this bot is already registered',
        { expose: true },
      );
    }

    let info: BotInfo;
    try {
      info = await this.getMe(token, this.config.TELEGRAM_API_BASE_URL);
    } catch (cause) {
      throw new AppError(
        ErrorCode.BOT_TOKEN_INVALID,
        'invalid telegram bot token',
        { expose: true, cause },
      );
    }

    const username = (info.username ?? '').replace(/^@/, '');
    if (!TELEGRAM_BOT_USERNAME_REGEX.test(username)) {
      throw new AppError(
        ErrorCode.BOT_TOKEN_INVALID,
        'bot username must end with "bot"',
        { expose: true },
      );
    }
    const usernameLower = username.toLowerCase();

    const byUsername = this.bots.findByUsername(usernameLower);
    if (byUsername) {
      throw new AppError(
        ErrorCode.BOT_ALREADY_EXISTS,
        'this bot is already registered',
        { expose: true },
      );
    }

    const encrypted = encryptToken(token, this.config.TOKEN_ENCRYPTION_KEY);

    const row = this.bots.insert({
      owner_user_id: input.owner.id,
      telegram_bot_id: telegramBotId,
      username: usernameLower,
      display_name: info.firstName ?? null,
      encrypted_token: encrypted.encrypted,
      token_nonce: encrypted.nonce,
      token_auth_tag: encrypted.authTag,
      mode: input.mode,
    });

    this.audit.log('bot.added', {
      actorUserId: input.owner.id,
      targetType: 'bot',
      targetId: String(row.id),
      metadata: {
        telegram_bot_id: telegramBotId,
        username: usernameLower,
        mode: input.mode,
        // Masked just in case this entry is ever surfaced verbatim.
        token: maskToken(token),
      },
    });

    return row;
  }

  /**
   * Decrypt the stored token so the child-bot manager can start a grammY
   * instance. Records a redacted audit entry — the plaintext is never
   * persisted or echoed.
   */
  decryptToken(bot: ManagedBotRow): string {
    const plain = decryptToken(
      {
        encrypted: bot.encrypted_token,
        nonce: bot.token_nonce,
        authTag: bot.token_auth_tag,
      },
      this.config.TOKEN_ENCRYPTION_KEY,
    );
    this.audit.log('bot.token_decrypted', {
      targetType: 'bot',
      targetId: String(bot.id),
      metadata: { telegram_bot_id: bot.telegram_bot_id },
    });
    return plain;
  }

  /** Mark a bot as failed to start. Status flips to `error` + last_error. */
  markErrored(bot: ManagedBotRow, sanitizedError: string): ManagedBotRow {
    const updated = this.bots.setStatus(bot.id, 'error', sanitizedError);
    if (!updated) {
      throw new AppError(ErrorCode.BOT_NOT_FOUND, 'bot disappeared during update');
    }
    this.audit.log('bot.errored', {
      targetType: 'bot',
      targetId: String(bot.id),
      metadata: { last_error: sanitizedError },
    });
    return updated;
  }

  /** Soft-remove a bot. Status flips to `removed`; row stays for history. */
  remove(bot: ManagedBotRow, actor: UserRow): ManagedBotRow {
    const updated = this.bots.setStatus(bot.id, 'removed', null);
    if (!updated) {
      throw new AppError(ErrorCode.BOT_NOT_FOUND, 'bot disappeared during update');
    }
    this.audit.log('bot.removed', {
      actorUserId: actor.id,
      targetType: 'bot',
      targetId: String(bot.id),
    });
    return updated;
  }

  /** Switch a managed bot between `personal_public` and `personal_private`. */
  setMode(bot: ManagedBotRow, mode: BotMode, actor: UserRow): ManagedBotRow {
    if (mode !== 'personal_public' && mode !== 'personal_private') {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'mode must be personal_public or personal_private',
        { expose: true },
      );
    }
    const updated = this.bots.setMode(bot.id, mode);
    if (!updated) {
      throw new AppError(ErrorCode.BOT_NOT_FOUND, 'bot disappeared during update');
    }
    this.audit.log('bot.mode_changed', {
      actorUserId: actor.id,
      targetType: 'bot',
      targetId: String(bot.id),
      metadata: { mode },
    });
    return updated;
  }

  listForOwner(owner: UserRow): ManagedBotRow[] {
    return this.bots.listByOwner(owner.id);
  }

  listActive(): ManagedBotRow[] {
    return this.bots.listActive();
  }
}
