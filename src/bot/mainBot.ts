/**
 * VaultLink Bot — main-bot bootstrap.
 *
 * Builds the grammY {@link Bot} for `config.MAIN_BOT_TOKEN`, ensuring a
 * `managed_bots` row exists for it (so the same code paths used for child
 * bots apply uniformly). On first run we look up Telegram's `getMe` to
 * harvest the username/display_name, encrypt the token, and insert the row;
 * on subsequent runs we refresh the cached display_name when it changes.
 *
 * Also exports the default {@link defaultGetMeFn} used by {@link BotService}.
 */

import { Bot } from 'grammy';
import type { AppContext, AppRepos, AppServices } from './context.js';
import type { Config } from '../config/env.js';
import type { ManagedBotRow } from '../types/index.js';
import { createBot } from './createBot.js';
import { encryptToken } from '../services/tokenCrypto.service.js';
import { parseTelegramBotId } from '../utils/telegramToken.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { getLogger } from '../logger/logger.js';
import { PUBLIC_BOT_COMMANDS, ADMIN_BOT_COMMAND } from './commands.js';
import type { ChildBotManager } from './childBotManager.js';
import type { BotInfo, GetMeFn } from '../services/bot.service.js';

export interface BootstrapMainBotDeps {
  config: Config;
  services: AppServices;
  repos: AppRepos;
  /** Optional child manager so bot-management commands can start/stop kids. */
  childManager?: ChildBotManager;
}

export interface BootstrapMainBotResult {
  bot: Bot<AppContext>;
  record: ManagedBotRow;
}

/**
 * Locate or create the `managed_bots` row for the main bot, then build a
 * grammY instance ready to start.
 */
export async function bootstrapMainBot(
  deps: BootstrapMainBotDeps,
): Promise<BootstrapMainBotResult> {
  const { config, services, repos } = deps;
  const log = getLogger();

  const token = config.MAIN_BOT_TOKEN;
  const telegramBotId = parseTelegramBotId(token);

  // First, fetch live identity from Telegram.
  const info = await defaultGetMeFn(token, config.TELEGRAM_API_BASE_URL);
  const username = info.username.replace(/^@/, '').toLowerCase();
  const displayName = info.firstName || null;

  // Resolve owner: first admin in ADMIN_IDS gets seeded as super_admin, then
  // becomes the main bot's `owner_user_id`.
  const firstAdminId = config.ADMIN_IDS[0];
  if (!firstAdminId) {
    throw new AppError(ErrorCode.CONFIG_INVALID, 'ADMIN_IDS must list at least one Telegram user ID');
  }

  let ownerRow = repos.users.findByTelegramId(firstAdminId);
  if (!ownerRow) {
    ownerRow = repos.users.insert({
      telegram_user_id: firstAdminId,
      username: null,
      first_name: null,
      last_name: null,
      locale: config.DEFAULT_LOCALE,
      role: 'super_admin',
    });
  } else if (ownerRow.role !== 'super_admin') {
    ownerRow = repos.users.update(ownerRow.id, { role: 'super_admin' });
  }

  // Locate or insert the managed_bots row.
  let record = repos.bots.findByTelegramBotId(telegramBotId);
  if (!record) {
    const enc = encryptToken(token, config.TOKEN_ENCRYPTION_KEY);
    record = repos.bots.insert({
      owner_user_id: ownerRow.id,
      telegram_bot_id: telegramBotId,
      username,
      display_name: displayName,
      encrypted_token: enc.encrypted,
      token_nonce: enc.nonce,
      token_auth_tag: enc.authTag,
      mode: 'main_public',
    });
    services.audit.log('bot.main_registered', {
      actorUserId: ownerRow.id,
      targetType: 'bot',
      targetId: String(record.id),
      metadata: { telegram_bot_id: telegramBotId, username },
    });
    log.info({ username, telegram_bot_id: telegramBotId }, 'main bot registered');
  } else if (record.mode !== 'main_public') {
    // Defensive: if the same token was previously registered as a personal
    // bot (e.g. ops migrated tokens), force the mode back.
    record = repos.bots.setMode(record.id, 'main_public') ?? record;
  }

  const grammyBot = createBot({
    token,
    bot: record,
    services,
    repos,
    config,
    ...(deps.childManager !== undefined ? { childManager: deps.childManager } : {}),
  });

  // Best-effort menu registration. Ignore failures so the bot still starts.
  try {
    await grammyBot.api.setMyCommands([...PUBLIC_BOT_COMMANDS]);
  } catch (err) {
    log.warn({ err }, 'failed to setMyCommands on main bot');
  }

  // Per-admin scope so /admin only appears in the menu for known operators.
  // Telegram rejects scope=chat for users who never opened a private chat
  // with the bot, so we silently skip those failures.
  const adminCommands = [...PUBLIC_BOT_COMMANDS, ADMIN_BOT_COMMAND];
  for (const adminId of config.ADMIN_IDS) {
    try {
      await grammyBot.api.setMyCommands(adminCommands, {
        scope: { type: 'chat', chat_id: Number(adminId) },
      });
    } catch (err) {
      log.warn({ err, adminId }, 'failed to setMyCommands for admin scope');
    }
  }

  return { bot: grammyBot, record };
}

/**
 * Default Telegram `getMe` implementation used by {@link BotService.addBot}.
 * Calls `<TELEGRAM_API_BASE_URL>/bot<token>/getMe` and projects the response
 * onto our minimal {@link BotInfo} shape.
 */
export const defaultGetMeFn: GetMeFn = async (token, apiBaseUrl) => {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/bot${token}/getMe`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new AppError(
      ErrorCode.BOT_TOKEN_INVALID,
      `getMe failed with status ${res.status}`,
      { meta: { status: res.status } },
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new AppError(ErrorCode.BOT_TOKEN_INVALID, 'getMe returned non-JSON', { cause });
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !(body as { ok?: unknown }).ok ||
    typeof (body as { result?: unknown }).result !== 'object' ||
    (body as { result?: unknown }).result === null
  ) {
    throw new AppError(ErrorCode.BOT_TOKEN_INVALID, 'getMe response missing result');
  }
  const result = (body as { result: Record<string, unknown> }).result;
  const id = result.id;
  const username = result.username;
  const firstName = result.first_name;
  if (typeof id !== 'number' || typeof username !== 'string' || typeof firstName !== 'string') {
    throw new AppError(ErrorCode.BOT_TOKEN_INVALID, 'getMe response missing required fields');
  }
  const out: BotInfo = {
    id: String(id),
    username,
    firstName,
  };
  if (typeof result.can_join_groups === 'boolean') out.canJoinGroups = result.can_join_groups;
  if (typeof result.can_read_all_group_messages === 'boolean') {
    out.canReadAllGroupMessages = result.can_read_all_group_messages;
  }
  if (typeof result.supports_inline_queries === 'boolean') {
    out.supportsInlineQueries = result.supports_inline_queries;
  }
  return out;
};
