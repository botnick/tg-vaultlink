/**
 * VaultLink Bot — broadcast service.
 *
 * Domain layer for the announcement system. Handles permissions
 * (founder system-wide, bot owners on their own bot), validation
 * (text length, button shape, audience JSON, schedule sanity), state
 * transitions (draft → scheduled / sending / cancelled), audit, and the
 * audience-preview round-trip the composer page uses.
 *
 * The actual fan-out lives in `BroadcastWorker` — this service flips the
 * status to `sending` and lets the worker pick it up on its next tick.
 * Keeping the dispatch loop out of the request path means the Mini App
 * `POST .../send` returns in milliseconds even for a 5 000-recipient
 * broadcast.
 */

import type { Config } from '../config/env.js';
import type {
  BroadcastAudience,
  BroadcastButton,
  BroadcastParseMode,
  BroadcastRow,
  BroadcastStatus,
  ManagedBotRow,
  UserRow,
} from '../types/index.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { AuditService } from './audit.service.js';
import type { PermissionService } from './permission.service.js';
import type {
  BroadcastRepository,
  InsertBroadcastInput,
  UpdateBroadcastDraftInput,
} from '../repositories/broadcast.repository.js';
import { parseAudience } from '../repositories/broadcast.repository.js';
import type { BotRepository } from '../repositories/bot.repository.js';

/** Maximum number of inline button rows / buttons per row. Telegram's
 * own limit is higher, but past these values the message becomes unusable
 * on small screens and we'd rather fail fast at compose time. */
const MAX_BUTTON_ROWS = 8;
const MAX_BUTTONS_PER_ROW = 4;
const MAX_BUTTON_TEXT_LEN = 64;
/** Telegram's hard caption / message limits (4096 chars / 1024 chars). */
const MAX_TEXT_LEN = 4000;
const MAX_CAPTION_LEN = 1000;

/** Audience preview returned by the composer's "preview" button. */
export interface AudiencePreview {
  count: number;
  sample: Array<{
    id: number;
    telegram_user_id: string;
    username: string | null;
    first_name: string | null;
  }>;
}

/** Default audience used when the composer doesn't pass one — broadcast
 * goes to every active, non-banned, non-unsubscribed user of the chosen
 * bot, regardless of locale or role. */
export function defaultAudience(): BroadcastAudience {
  return {
    locale: 'all',
    role: 'all',
    exclude_banned: true,
    exclude_unsubscribed: true,
    registered_within_days: null,
    user_ids: [],
  };
}

/** Service-level draft input — strict shape, ready to insert. */
export interface CreateDraftInput {
  bot_id: number;
  text: string;
  parse_mode?: BroadcastParseMode | null;
  media_type?: string | null;
  media_file_id?: string | null;
  buttons?: BroadcastButton[][] | null;
  disable_web_page_preview?: boolean;
  protect_content?: boolean;
  silent?: boolean;
  audience?: BroadcastAudience;
}

/** Patch applied via {@link BroadcastService.updateDraft}. */
export type UpdateDraftPatch = UpdateBroadcastDraftInput;

export class BroadcastService {
  constructor(
    private readonly repo: BroadcastRepository,
    private readonly bots: BotRepository,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
     
    private readonly _config: Config,
  ) {}

  /* ---------------------------------------------------------------------- *
   * Authorization
   * ---------------------------------------------------------------------- */

  /**
   * Verify the caller may act on this bot's broadcasts. Founders may act on
   * any bot; everyone else must be the bot's owner. Throws PERMISSION_DENIED.
   */
  private assertCanUseBot(actor: UserRow, bot: ManagedBotRow): void {
    if (this.permission.isFounder(actor)) return;
    if (bot.owner_user_id === actor.id) return;
    throw new AppError(
      ErrorCode.PERMISSION_DENIED,
      'You do not own this bot.',
      { expose: true },
    );
  }

  /**
   * Resolve + permission-check the bot for a given broadcast row. Used by
   * every read/write that names a broadcast id.
   */
  private resolveBotFor(row: BroadcastRow, actor: UserRow): ManagedBotRow {
    const bot = this.bots.findById(row.bot_id);
    if (!bot) {
      throw new AppError(ErrorCode.BOT_NOT_FOUND, `bot ${row.bot_id} not found`, {
        meta: { bot_id: row.bot_id },
      });
    }
    this.assertCanUseBot(actor, bot);
    return bot;
  }

  /* ---------------------------------------------------------------------- *
   * Validation helpers
   * ---------------------------------------------------------------------- */

  private validateText(text: string, hasMedia: boolean): void {
    const t = text.trim();
    if (t.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Broadcast text is empty.', { expose: true });
    }
    const cap = hasMedia ? MAX_CAPTION_LEN : MAX_TEXT_LEN;
    if (t.length > cap) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `Broadcast text exceeds ${cap} characters.`,
        { expose: true, meta: { length: t.length, cap } },
      );
    }
  }

  private validateButtons(buttons: BroadcastButton[][] | null | undefined): void {
    if (!buttons) return;
    if (buttons.length > MAX_BUTTON_ROWS) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `Inline keyboard exceeds ${MAX_BUTTON_ROWS} rows.`,
        { expose: true, meta: { rows: buttons.length } },
      );
    }
    for (const row of buttons) {
      if (row.length > MAX_BUTTONS_PER_ROW) {
        throw new AppError(
          ErrorCode.INVALID_INPUT,
          `Each row may have at most ${MAX_BUTTONS_PER_ROW} buttons.`,
          { expose: true, meta: { row_size: row.length } },
        );
      }
      for (const btn of row) {
        if (!btn.text || btn.text.trim().length === 0) {
          throw new AppError(ErrorCode.INVALID_INPUT, 'Button text is empty.', { expose: true });
        }
        if (btn.text.length > MAX_BUTTON_TEXT_LEN) {
          throw new AppError(
            ErrorCode.INVALID_INPUT,
            `Button text exceeds ${MAX_BUTTON_TEXT_LEN} characters.`,
            { expose: true, meta: { text: btn.text.slice(0, 32) } },
          );
        }
        // URL must be http(s) or t.me / tg://. Reject anything else so we
        // never become a phishing redirector.
        let url: URL;
        try {
          url = new URL(btn.url);
        } catch {
          throw new AppError(
            ErrorCode.INVALID_INPUT,
            'Button URL is not a valid URL.',
            { expose: true, meta: { url: btn.url.slice(0, 64) } },
          );
        }
        const proto = url.protocol.toLowerCase();
        if (proto !== 'https:' && proto !== 'http:' && proto !== 'tg:') {
          throw new AppError(
            ErrorCode.INVALID_INPUT,
            'Button URL must use https, http, or tg:// scheme.',
            { expose: true, meta: { url: btn.url.slice(0, 64) } },
          );
        }
      }
    }
  }

  /** Audience JSON shape is simple but values come from the network — guard. */
  private validateAudience(a: BroadcastAudience): void {
    if (
      a.user_ids.length > 0 &&
      a.user_ids.some((s) => typeof s !== 'string' || s.trim().length === 0)
    ) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'audience user_ids contains an empty entry', {
        expose: true,
      });
    }
    if (a.registered_within_days !== null && a.registered_within_days < 1) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'registered_within_days must be a positive integer or null',
        { expose: true },
      );
    }
  }

  /* ---------------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------------- */

  createDraft(actor: UserRow, input: CreateDraftInput): BroadcastRow {
    const bot = this.bots.findById(input.bot_id);
    if (!bot) {
      throw new AppError(ErrorCode.BOT_NOT_FOUND, `bot ${input.bot_id} not found`, {
        meta: { bot_id: input.bot_id },
      });
    }
    this.assertCanUseBot(actor, bot);

    const audience = input.audience ?? defaultAudience();
    this.validateAudience(audience);
    const hasMedia = input.media_type !== null && input.media_type !== undefined;
    this.validateText(input.text, hasMedia);
    this.validateButtons(input.buttons ?? null);

    const insert: InsertBroadcastInput = {
      bot_id: bot.id,
      created_by: actor.id,
      text: input.text.trim(),
      parse_mode: input.parse_mode ?? null,
      media_type: input.media_type ?? null,
      media_file_id: input.media_file_id ?? null,
      buttons: input.buttons ?? null,
      disable_web_page_preview: input.disable_web_page_preview ?? false,
      protect_content: input.protect_content ?? false,
      silent: input.silent ?? false,
      audience,
    };
    const row = this.repo.insert(insert);

    this.audit.log('broadcast.create', {
      actorUserId: actor.id,
      targetType: 'broadcast',
      targetId: String(row.id),
      metadata: {
        bot_id: bot.id,
        has_media: hasMedia,
        has_buttons: input.buttons !== null && input.buttons !== undefined,
      },
    });
    return row;
  }

  updateDraft(actor: UserRow, id: number, patch: UpdateDraftPatch): BroadcastRow {
    const existing = this.repo.findById(id);
    if (!existing) {
      throw new AppError(ErrorCode.INVALID_INPUT, `broadcast ${id} not found`, {
        expose: true,
        meta: { id },
      });
    }
    this.resolveBotFor(existing, actor);
    if (existing.status !== 'draft') {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'Only draft broadcasts may be edited.',
        { expose: true, meta: { id, status: existing.status } },
      );
    }
    if (patch.audience !== undefined) this.validateAudience(patch.audience);
    if (patch.text !== undefined) {
      const hasMedia =
        patch.media_type !== undefined ? patch.media_type !== null : existing.media_type !== null;
      this.validateText(patch.text, hasMedia);
    }
    if (patch.buttons !== undefined) this.validateButtons(patch.buttons ?? null);
    return this.repo.updateDraft(id, patch);
  }

  getById(actor: UserRow, id: number): BroadcastRow {
    const row = this.repo.findById(id);
    if (!row) {
      throw new AppError(ErrorCode.INVALID_INPUT, `broadcast ${id} not found`, {
        expose: true,
        meta: { id },
      });
    }
    this.resolveBotFor(row, actor);
    return row;
  }

  /** Listing — founder sees all bots; owners see their own. */
  list(
    actor: UserRow,
    opts: { bot_id?: number | null; status?: BroadcastStatus | null; limit: number; offset: number },
  ): { items: BroadcastRow[]; total: number } {
    const isFounder = this.permission.isFounder(actor);
    if (opts.bot_id !== null && opts.bot_id !== undefined) {
      const bot = this.bots.findById(opts.bot_id);
      if (!bot) {
        throw new AppError(ErrorCode.BOT_NOT_FOUND, `bot ${opts.bot_id} not found`, {
          meta: { bot_id: opts.bot_id },
        });
      }
      this.assertCanUseBot(actor, bot);
      const items = this.repo.list({ ...opts, bot_id: opts.bot_id });
      const total = this.repo.count({ bot_id: opts.bot_id, status: opts.status ?? null });
      return { items, total };
    }
    if (isFounder) {
      const items = this.repo.list({ ...opts, bot_id: null });
      const total = this.repo.count({ bot_id: null, status: opts.status ?? null });
      return { items, total };
    }
    // Non-founder: filter to their owned bots. Done in JS rather than a
    // SQL JOIN because list sizes are small (an operator owns a handful of
    // bots, at most).
    const ownedIds = this.bots
      .listByOwner(actor.id)
      .filter((b) => b.status === 'active')
      .map((b) => b.id);
    if (ownedIds.length === 0) return { items: [], total: 0 };
    const collected: BroadcastRow[] = [];
    let total = 0;
    for (const bid of ownedIds) {
      total += this.repo.count({ bot_id: bid, status: opts.status ?? null });
      const slice = this.repo.list({
        bot_id: bid,
        status: opts.status ?? null,
        limit: opts.limit + opts.offset,
        offset: 0,
      });
      collected.push(...slice);
    }
    collected.sort((a, b) => b.id - a.id);
    return { items: collected.slice(opts.offset, opts.offset + opts.limit), total };
  }

  audiencePreview(actor: UserRow, id: number, sampleSize = 5): AudiencePreview {
    const row = this.getById(actor, id);
    const audience = parseAudience(row.audience_json);
    const count = this.repo.audienceCount(audience);
    const sample = this.repo.audienceSample(audience, sampleSize);
    return { count, sample };
  }

  /**
   * Materialize recipients + flip status to `sending`. The actual send
   * happens on the worker's next tick.
   *
   * `confirmation` must equal the literal string "SEND" — this matches the
   * confirmation dialog in the Mini App composer and prevents an accidental
   * fat-finger from blasting 5 000 users.
   */
  send(actor: UserRow, id: number, confirmation: string): BroadcastRow {
    if (confirmation !== 'SEND') {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'Confirmation phrase missing or incorrect.',
        { expose: true },
      );
    }
    const row = this.getById(actor, id);
    if (row.status !== 'draft' && row.status !== 'scheduled') {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `Broadcast is already ${row.status}.`,
        { expose: true, meta: { id, status: row.status } },
      );
    }
    const audience = parseAudience(row.audience_json);
    const recipientCount = this.repo.materializeRecipients(row.id, audience);
    if (recipientCount === 0) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'Audience is empty — nothing to send.',
        { expose: true, meta: { id } },
      );
    }
    this.repo.setAudienceCount(row.id, recipientCount);
    const flipped = this.repo.tryTransition(row.id, ['draft', 'scheduled'], 'sending');
    if (!flipped) {
      // Concurrent flip — return the latest row.
      return this.repo.findById(row.id) ?? row;
    }
    this.audit.log('broadcast.send', {
      actorUserId: actor.id,
      targetType: 'broadcast',
      targetId: String(row.id),
      metadata: { audience_count: recipientCount },
    });
    return flipped;
  }

  /** Schedule a draft for `scheduled_at`. Times in the past flip straight to `sending`. */
  schedule(actor: UserRow, id: number, scheduledAt: string): BroadcastRow {
    const row = this.getById(actor, id);
    if (row.status !== 'draft' && row.status !== 'scheduled') {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `Broadcast is already ${row.status}.`,
        { expose: true, meta: { id, status: row.status } },
      );
    }
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'scheduled_at is not a valid ISO timestamp', {
        expose: true,
      });
    }
    const iso = when.toISOString();
    const updated = this.repo.setScheduledAt(id, iso);
    if (!updated) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Broadcast cannot be scheduled in this state.', {
        expose: true,
      });
    }
    const flipped = this.repo.tryTransition(id, ['draft', 'scheduled'], 'scheduled') ?? updated;
    this.audit.log('broadcast.schedule', {
      actorUserId: actor.id,
      targetType: 'broadcast',
      targetId: String(id),
      metadata: { scheduled_at: iso },
    });
    return flipped;
  }

  cancel(actor: UserRow, id: number): BroadcastRow {
    const row = this.getById(actor, id);
    if (row.status === 'completed' || row.status === 'cancelled' || row.status === 'failed') {
      return row;
    }
    const flipped = this.repo.tryTransition(id, ['draft', 'scheduled', 'sending'], 'cancelled');
    if (!flipped) {
      return this.repo.findById(id) ?? row;
    }
    if (flipped.status === 'cancelled') {
      this.repo.cancelPending(id);
      this.repo.recomputeCounts(id);
    }
    this.audit.log('broadcast.cancel', {
      actorUserId: actor.id,
      targetType: 'broadcast',
      targetId: String(id),
      metadata: { previous_status: row.status },
    });
    return this.repo.findById(id) ?? flipped;
  }

  deleteDraft(actor: UserRow, id: number): void {
    const row = this.getById(actor, id);
    if (row.status !== 'draft') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Only draft broadcasts may be deleted.', {
        expose: true,
      });
    }
    this.repo.deleteDraft(id);
    this.audit.log('broadcast.delete', {
      actorUserId: actor.id,
      targetType: 'broadcast',
      targetId: String(id),
    });
  }

  /* ---------------------------------------------------------------------- *
   * Recipient queries
   * ---------------------------------------------------------------------- */

  listRecipients(
    actor: UserRow,
    id: number,
    opts: {
      status?: BroadcastRow['status'] extends infer S ? S : never;
      limit: number;
      offset: number;
    },
  ): { items: ReturnType<BroadcastRepository['listRecipients']>; total: number } {
    this.getById(actor, id);
    const items = this.repo.listRecipients({
      broadcast_id: id,
      status: (opts.status as never) ?? null,
      limit: opts.limit,
      offset: opts.offset,
    });
    const total = this.repo.countRecipients({
      broadcast_id: id,
      status: (opts.status as never) ?? null,
    });
    return { items, total };
  }
}
