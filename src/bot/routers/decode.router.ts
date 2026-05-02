/**
 * Decode router — plain-text share-code lookups.
 *
 * Strict-prefix UX: the user must type the FULL `botname:CODE` form (or paste
 * a Telegram deep link). Bare `CODE` strings are rejected — that disambiguates
 * cross-bot lookups and keeps "I sent CODE" copy-paste mistakes from silently
 * resolving to the wrong bot's namespace.
 *
 * Batch UX: a single message may carry MANY share-code lines. Every line that
 * parses as a `botname:CODE` (optionally with a trailing `:password`) is
 * delivered in input order, with a small spacing delay so we stay inside the
 * Telegram per-chat rate window. The reply summarises hits and failures
 * once at the end.
 *
 * Single-line messages skip the batch chrome: one delivery, one reply, the
 * existing UX preserved.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware.js';
import { parseShareCode } from '../../utils/codeParser.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { deliverFile } from './_delivery.js';
import { escapeHtml } from '../../utils/safeText.js';

interface PreparedDecode {
  rawCode: string;
  password: string | null;
  /** Canonical `botname:CODE` form for prompts and audit messages. */
  shareCode: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Pull a `(code, password?)` pair out of one line. Returns `null` when the
 * line does not parse as a `botname:CODE` (deep links also accepted). The
 * STRICT_PREFIX policy is enforced here: a bare code without a bot prefix
 * never resolves.
 */
function prepareDecode(line: string): PreparedDecode | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  // Try parsing whole input first — covers deep links and `<bot>:<code>`.
  const direct = parseShareCode(trimmed);
  if (direct && direct.botUsername !== null) {
    return {
      rawCode: trimmed,
      password: null,
      shareCode: `${direct.botUsername}:${direct.code}`,
    };
  }

  // Try splitting on the LAST colon so passwords containing `:` survive
  // accidentally — the prefix must still parse as a `<bot>:<code>` reference.
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > 0 && lastColon < trimmed.length - 1) {
    const prefix = trimmed.slice(0, lastColon);
    const password = trimmed.slice(lastColon + 1);
    const parsed = parseShareCode(prefix);
    if (parsed && parsed.botUsername !== null) {
      return {
        rawCode: prefix,
        password,
        shareCode: `${parsed.botUsername}:${parsed.code}`,
      };
    }
  }

  return null;
}

/**
 * Split a multi-line user message into share-code candidates. Empty lines and
 * non-code lines are skipped silently so users can paste codes mixed with
 * arbitrary text without each unmatched line counting against them.
 */
function prepareBatch(text: string): {
  decodes: PreparedDecode[];
  /** True when the user typed at least ONE line that looked code-like
   * (had a colon or matched the bare-code shape) but failed strict parsing.
   * We use this to surface the "prefix required" hint instead of generic
   * help when the user clearly tried to send a code. */
  hadCodeLikeReject: boolean;
} {
  const lines = text
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const decodes: PreparedDecode[] = [];
  let hadCodeLikeReject = false;

  for (const line of lines) {
    const decoded = prepareDecode(line);
    if (decoded) {
      decodes.push(decoded);
      continue;
    }
    // Track lines that LOOKED like share-code attempts (a bare code, or a
    // colon-bearing string) so we can give the user a better hint.
    const flexibleParse = parseShareCode(line);
    if (flexibleParse) {
      hadCodeLikeReject = true;
    }
  }

  return { decodes, hadCodeLikeReject };
}

/** Inter-delivery spacing — keeps the per-chat 1 msg/sec budget. */
const BATCH_DELAY_MS = 700;

export function registerDecodeRouter(composer: Composer<AppContext>): void {
  composer.on('message:text', rateLimitMiddleware('download'), async (ctx, next) => {
    const text = ctx.message.text;
    // Commands are handled by their respective routers.
    if (text.startsWith('/')) {
      return next();
    }

    const { decodes, hadCodeLikeReject } = prepareBatch(text);

    if (decodes.length === 0) {
      // The user sent something — was any of it a bare code missing the
      // `botname:` prefix?
      if (hadCodeLikeReject) {
        await ctx.reply(ctx.t('decode.prefix_required'), { parse_mode: 'HTML' });
      } else {
        await ctx.reply(ctx.t('decode.prompt'), { parse_mode: 'HTML' });
      }
      return;
    }

    if (decodes.length === 1) {
      const only = decodes[0];
      if (only) await processOne(ctx, only);
      return;
    }

    // Cap the batch so a paste of thousands of lines doesn't pin the worker.
    const cap = Math.max(1, ctx.config.MAX_BULK_SEND_ITEMS);
    const batch = decodes.slice(0, cap);
    await ctx.reply(ctx.t('decode.batch_starting', { count: batch.length }));

    let ok = 0;
    let failed = 0;
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (!item) continue;
      const success = await processOne(ctx, item, /*silentSuccess=*/ false);
      if (success) ok++;
      else failed++;
      if (i < batch.length - 1) await sleep(BATCH_DELAY_MS);
    }

    const failedSuffix =
      failed > 0 ? ctx.t('decode.batch_failed_suffix', { failed }) : '';
    await ctx.reply(
      ctx.t('decode.batch_summary', { ok, total: batch.length, failedSuffix }),
    );
  });
}

/**
 * Resolve and deliver a single share code. Returns `true` on successful
 * delivery, `false` on any handled failure (locked / expired / not found /
 * password required / permission denied). Unhandled errors propagate.
 */
async function processOne(
  ctx: AppContext,
  prepared: PreparedDecode,
  silentSuccess = false,
): Promise<boolean> {
  void silentSuccess;
  const resolved = await ctx.services.share.resolveShareCode({
    rawCode: prepared.rawCode,
    contextBot: ctx.bot,
  });

  if (resolved && resolved.type === 'collection') {
    try {
      await ctx.services.share.ensureAccessible({
        collection: resolved.collection,
        password: prepared.password,
      });
    } catch (err) {
      return await handleAccessError(ctx, prepared, err);
    }
    const { sendCollectionPreview } = await import('./collection.router.js');
    await sendCollectionPreview(ctx, resolved.collection);
    return true;
  }

  if (resolved && resolved.type === 'single_file') {
    try {
      const decoded = await ctx.services.file.decode({
        user: ctx.user,
        rawCode: prepared.rawCode,
        contextBot: ctx.bot,
        password: prepared.password,
      });
      const decision = ctx.services.permission.canDownload(
        ctx.user,
        decoded.bot,
        decoded.file,
      );
      if (!decision.allowed) {
        await ctx.reply(
          ctx.t('decode.batch_item_error', {
            shareCode: escapeHtml(prepared.shareCode),
            reason: ctx.t('decode.permission_denied'),
          }),
          { parse_mode: 'HTML' },
        );
        return false;
      }
      await deliverFile(ctx, decoded.file);
      return true;
    } catch (err) {
      return await handleAccessError(ctx, prepared, err);
    }
  }

  // No match.
  await ctx.reply(
    ctx.t('decode.batch_item_error', {
      shareCode: escapeHtml(prepared.shareCode),
      reason: ctx.t('decode.not_found'),
    }),
    { parse_mode: 'HTML' },
  );
  return false;
}

/**
 * Map an AppError raised during accessibility/decoding to a per-item user
 * reply and return `false`. Re-throws unhandled errors so the global error
 * boundary still sees them.
 */
async function handleAccessError(
  ctx: AppContext,
  prepared: PreparedDecode,
  err: unknown,
): Promise<boolean> {
  if (!(err instanceof AppError)) throw err;

  let reasonKey: string | null = null;
  switch (err.code) {
    case ErrorCode.PASSWORD_REQUIRED:
      await ctx.reply(
        ctx.t('decode.password_required', { shareCode: escapeHtml(prepared.shareCode) }),
        { parse_mode: 'HTML' },
      );
      return false;
    case ErrorCode.PASSWORD_INCORRECT:
      reasonKey = 'decode.password_incorrect';
      break;
    case ErrorCode.FILE_LOCKED:
      reasonKey = 'decode.locked';
      break;
    case ErrorCode.FILE_EXPIRED:
      reasonKey = 'decode.expired';
      break;
    case ErrorCode.FILE_NOT_AVAILABLE:
      reasonKey = 'decode.not_found';
      break;
    default:
      throw err;
  }

  await ctx.reply(
    ctx.t('decode.batch_item_error', {
      shareCode: escapeHtml(prepared.shareCode),
      reason: ctx.t(reasonKey),
    }),
    { parse_mode: 'HTML' },
  );
  return false;
}
