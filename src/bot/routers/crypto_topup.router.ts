/**
 * Crypto top-up router — user-facing flow.
 *
 * Wave 9.3 redesign: 2-stage picker (network → token) followed by an
 * amount picker, then a "waiting for payment" view. The system watches
 * the chain for the unique-amount transfer in the background and credits
 * the user automatically — no tx-hash entry needed for the happy path.
 * The legacy "paste hash" flow stays available behind a "Need help?"
 * disclosure for RPC-outage / wrong-amount edge cases.
 *
 * Callbacks:
 *   credit:crypto                       — open network picker
 *   credit:crypto:net:<network>         — pick a network → token picker
 *   credit:crypto:chain:<chainId>       — token picked → amount picker
 *   credit:crypto:amt:<chain>:<amount>  — amount picked → create invoice
 *   credit:crypto:inv:<id>              — re-render invoice (auto-refresh)
 *   credit:crypto:cancel:<id>           — user cancels still-pending invoice
 *   credit:crypto:adv:<id>              — reveal advanced "Need help?" panel
 *   credit:crypto:hash:<id>             — start the paste-tx-hash escape hatch
 *
 * The actual hash submission happens via a text reply: when the user is
 * in the "awaiting tx hash" state we listen for the next text message.
 * State is held in a small in-memory map keyed by user.id; if the bot
 * restarts the user can just hit the button again.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { escapeHtml } from '../../utils/safeText.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import {
  CRYPTO_CHAIN_NETWORK,
  CRYPTO_CHAIN_TOKEN,
  CRYPTO_PICKER_CHAIN_IDS,
} from '../../types/index.js';
import type {
  CryptoChainConfig,
  CryptoChainId,
  CryptoInvoiceRow,
  CryptoNetwork,
  CryptoToken,
} from '../../types/index.js';

/**
 * Suggested amounts per token. Drives the inline keyboard preset row.
 * `native` is only here to satisfy the type — legacy 'ton-native' isn't
 * shown in the picker.
 */
const AMOUNT_PRESETS: Record<CryptoToken, readonly string[]> = {
  USDT: ['10', '25', '50', '100', '250', '500'],
  USDC: ['10', '25', '50', '100', '250', '500'],
  native: ['1', '5', '10'],
};

const NETWORK_LABEL_KEY: Record<CryptoNetwork, string> = {
  trx: 'credits.crypto.network.trx',
  bsc: 'credits.crypto.network.bsc',
  eth: 'credits.crypto.network.eth',
  ton: 'credits.crypto.network.ton',
};

const NETWORK_GLYPH: Record<CryptoNetwork, string> = {
  trx: '◇',
  bsc: '◆',
  eth: 'Ξ',
  ton: '✦',
};

/** Order networks deterministically in the picker. */
const NETWORK_ORDER: readonly CryptoNetwork[] = ['trx', 'bsc', 'eth', 'ton'];

interface PendingHashState {
  invoiceId: number;
  chain: CryptoChainId;
  /** When the prompt was issued — discard after 5 minutes. */
  issuedAt: number;
}

const pendingHash = new Map<number, PendingHashState>();
const PENDING_HASH_TTL_MS = 5 * 60 * 1000;

function clearStalePending(): void {
  const cutoff = Date.now() - PENDING_HASH_TTL_MS;
  for (const [k, v] of pendingHash) {
    if (v.issuedAt < cutoff) pendingHash.delete(k);
  }
}

function backToTopupKeyboard(ctx: AppContext): InlineKeyboard {
  return new InlineKeyboard().text(ctx.t('credits.button.back'), 'credit:topup');
}

/** Select picker-visible enabled chains restricted to a network. */
function tokensForNetwork(
  ctx: AppContext,
  network: CryptoNetwork,
): CryptoChainConfig[] {
  return ctx.services.crypto
    .listEnabledChains()
    .filter((c) => CRYPTO_CHAIN_NETWORK[c.id] === network)
    .filter((c) => (CRYPTO_PICKER_CHAIN_IDS as readonly string[]).includes(c.id));
}

/** Distinct networks that have at least one picker-visible enabled chain. */
function availableNetworks(ctx: AppContext): CryptoNetwork[] {
  const seen = new Set<CryptoNetwork>();
  for (const c of ctx.services.crypto.listEnabledChains()) {
    if (!(CRYPTO_PICKER_CHAIN_IDS as readonly string[]).includes(c.id)) continue;
    seen.add(CRYPTO_CHAIN_NETWORK[c.id]);
  }
  return NETWORK_ORDER.filter((n) => seen.has(n));
}

function renderInvoice(ctx: AppContext, invoice: CryptoInvoiceRow): string {
  const lines: string[] = [];
  const token = CRYPTO_CHAIN_TOKEN[invoice.chain];
  const networkKey = NETWORK_LABEL_KEY[CRYPTO_CHAIN_NETWORK[invoice.chain]];
  lines.push(ctx.t('credits.crypto.invoice.title'));
  lines.push('');
  // The exact amount is the primary attribution signal — call it out boldly.
  lines.push(
    ctx.t('credits.crypto.invoice.amount_exact', {
      amount: escapeHtml(invoice.amount_unit),
      token,
    }),
  );
  lines.push(
    ctx.t('credits.crypto.invoice.network_line', {
      network: ctx.t(networkKey),
    }),
  );
  lines.push(ctx.t('credits.crypto.invoice.credits', { credits: invoice.credits_to_grant }));
  lines.push('');
  lines.push(ctx.t('credits.crypto.invoice.address'));
  lines.push(`<code>${escapeHtml(invoice.pay_to_address)}</code>`);
  if (invoice.memo) {
    lines.push('');
    lines.push(ctx.t('credits.crypto.invoice.memo'));
    lines.push(`<code>${escapeHtml(invoice.memo)}</code>`);
    lines.push(ctx.t('credits.crypto.invoice.memo_warning'));
  } else {
    lines.push('');
    lines.push(ctx.t('credits.crypto.invoice.amount_strict'));
  }
  lines.push('');
  const expMin = Math.max(
    0,
    Math.round((new Date(invoice.expires_at).getTime() - Date.now()) / 60_000),
  );
  if (invoice.status === 'confirmed') {
    lines.push(
      ctx.t('credits.crypto.status.confirmed', { credits: invoice.credits_to_grant }),
    );
  } else if (invoice.status === 'expired') {
    lines.push(
      invoice.failure_reason === 'user_cancelled'
        ? ctx.t('credits.crypto.status.cancelled')
        : ctx.t('credits.crypto.invoice.expired'),
    );
  } else if (invoice.status === 'failed') {
    lines.push(
      ctx.t('credits.crypto.status.failed', {
        reason: escapeHtml(invoice.failure_reason ?? ''),
      }),
    );
  } else if (invoice.status === 'submitted' || invoice.status === 'confirming') {
    lines.push(
      ctx.t('credits.crypto.status.detecting', {
        conf: invoice.confirmations,
        required: invoice.required_confirmations,
      }),
    );
  } else {
    lines.push(ctx.t('credits.crypto.status.waiting'));
    lines.push(ctx.t('credits.crypto.invoice.expires', { minutes: expMin }));
  }
  if (invoice.tx_hash) {
    lines.push('');
    lines.push(
      ctx.t('credits.crypto.invoice.tx_hash_line', {
        hash: escapeHtml(invoice.tx_hash),
      }),
    );
  }
  return lines.join('\n');
}

function invoiceKeyboard(
  ctx: AppContext,
  invoice: CryptoInvoiceRow,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const inFlight =
    invoice.status === 'pending' ||
    invoice.status === 'submitted' ||
    invoice.status === 'confirming';
  // Wave 9.3 — open this exact invoice in the Mini App. The Mini App reads
  // the `?invoice=<id>` query and jumps straight to the waiting-for-payment
  // panel, so the user can scan the live QR + watch the realtime countdown
  // without re-navigating the picker.
  if (
    inFlight &&
    ctx.config.ENABLE_MINI_APP &&
    ctx.config.MINI_APP_URL.length > 0
  ) {
    const baseUrl = ctx.config.MINI_APP_URL.replace(/\/+$/, '');
    const webAppUrl = `${baseUrl}/credits/crypto?invoice=${invoice.id}`;
    kb.webApp(ctx.t('credits.crypto.button.open_in_mini_app'), webAppUrl).row();
  }
  if (inFlight) {
    kb.text(ctx.t('credits.crypto.button.refresh'), `credit:crypto:inv:${invoice.id}`).row();
    // Cancel always available pre-confirmation — covers the legacy mis-
    // attribution case as well as the simple "I changed my mind" path.
    kb.text(
      ctx.t('credits.crypto.button.cancel'),
      `credit:crypto:cancel:${invoice.id}`,
    ).row();
    // Advanced "Need help? I already paid" — reveal paste-hash flow.
    kb.text(
      ctx.t('credits.crypto.button.advanced'),
      `credit:crypto:adv:${invoice.id}`,
    ).row();
  }
  kb.text(ctx.t('credits.button.back'), 'credit:topup');
  return kb;
}

export function registerCryptoTopupRouter(composer: Composer<AppContext>): void {
  // ──────────────────────────────────────────── network picker ──────
  composer.callbackQuery('credit:crypto', async (ctx) => {
    if (!ctx.services.crypto.isEnabled()) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.crypto.disabled') });
      return;
    }
    await ctx.answerCallbackQuery();

    const networks = availableNetworks(ctx);
    if (networks.length === 0) {
      await ctx.reply(ctx.t('credits.crypto.no_chains_enabled'));
      return;
    }

    // Wave 9.3 — count active invoices so the user can find old pending
    // requests when the per-user cap blocks new ones.
    const recent = ctx.services.crypto.listRecentByUser(ctx.user.id, 20);
    const activeCount = recent.filter(
      (r) =>
        r.status === 'pending' || r.status === 'submitted' || r.status === 'confirming',
    ).length;

    const lines = [ctx.t('credits.crypto.network_picker.title'), ''];
    const kb = new InlineKeyboard();
    if (activeCount > 0) {
      kb.text(
        ctx.t('credits.crypto.button.view_open', { n: activeCount }),
        'credit:crypto:list',
      ).row();
    }
    for (const n of networks) {
      lines.push(
        ctx.t('credits.crypto.network_picker.row', {
          glyph: NETWORK_GLYPH[n],
          label: ctx.t(NETWORK_LABEL_KEY[n]),
        }),
      );
      kb.text(
        `${NETWORK_GLYPH[n]}  ${ctx.t(NETWORK_LABEL_KEY[n])}`,
        `credit:crypto:net:${n}`,
      ).row();
    }
    kb.text(ctx.t('credits.button.back'), 'credit:topup');

    try {
      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } catch {
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // ──────────────────────── list active invoices (cancellable) ──────
  // Wave 9.3 — surfaces pending requests so the user can cancel old ones
  // and free a slot under the per-user concurrent cap. Also linked to from
  // the create-failed toast when the cap fires.
  composer.callbackQuery('credit:crypto:list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const recent = ctx.services.crypto.listRecentByUser(ctx.user.id, 20);
    const active = recent.filter(
      (r) =>
        r.status === 'pending' || r.status === 'submitted' || r.status === 'confirming',
    );
    if (active.length === 0) {
      const kb = new InlineKeyboard().text(
        ctx.t('credits.button.back'),
        'credit:crypto',
      );
      await ctx.reply(ctx.t('credits.crypto.open_invoices.empty'), {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
      return;
    }
    const lines = [
      ctx.t('credits.crypto.open_invoices.title', { n: active.length }),
      ctx.t('credits.crypto.open_invoices.subtitle'),
      '',
    ];
    const kb = new InlineKeyboard();
    for (const inv of active) {
      const expMin = Math.max(
        0,
        Math.round((new Date(inv.expires_at).getTime() - Date.now()) / 60_000),
      );
      lines.push(
        ctx.t('credits.crypto.open_invoices.row', {
          id: inv.id,
          amount: escapeHtml(inv.amount_label),
          minutes: expMin,
        }),
      );
      kb.text(
        ctx.t('credits.crypto.open_invoices.open_button', { id: inv.id }),
        `credit:crypto:inv:${inv.id}`,
      );
      // Wave 9.3 — every still-active invoice is cancellable. Pre-9.3
      // legacy invoices can be wrongly attributed (status='submitted' or
      // 'confirming' without a real payment); the user needs to be able
      // to clear those too.
      kb.text(
        ctx.t('credits.crypto.open_invoices.cancel_button', { id: inv.id }),
        `credit:crypto:cancel:${inv.id}`,
      );
      kb.row();
    }
    kb.text(ctx.t('credits.button.back'), 'credit:crypto');
    try {
      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } catch {
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // ──────────────────────────────────────────── token picker ─────────
  composer.callbackQuery(/^credit:crypto:net:(trx|bsc|eth|ton)$/, async (ctx) => {
    const network = ctx.match?.[1] as CryptoNetwork | undefined;
    if (!network) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();

    const items = tokensForNetwork(ctx, network);
    if (items.length === 0) {
      await ctx.reply(ctx.t('credits.crypto.no_tokens_for_network'));
      return;
    }

    const lines = [
      ctx.t('credits.crypto.token_picker.title', {
        network: ctx.t(NETWORK_LABEL_KEY[network]),
      }),
      '',
    ];
    const kb = new InlineKeyboard();
    for (const c of items) {
      lines.push(
        ctx.t('credits.crypto.token_picker.row', {
          label: escapeHtml(c.label),
          rate: c.rate,
        }),
      );
      kb.text(c.label, `credit:crypto:chain:${c.id}`).row();
    }
    kb.text(ctx.t('credits.button.back'), 'credit:crypto');

    try {
      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } catch {
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // ──────────────────────────────────────────── amount picker ───────
  composer.callbackQuery(/^credit:crypto:chain:([a-z0-9-]+)$/, async (ctx) => {
    const chain = ctx.match?.[1] as CryptoChainId | undefined;
    if (!chain || !(CRYPTO_PICKER_CHAIN_IDS as readonly string[]).includes(chain)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const cfg = ctx.services.crypto.chainConfig(chain);
    if (!cfg || !cfg.enabled || cfg.address.length === 0) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.crypto.disabled') });
      return;
    }
    await ctx.answerCallbackQuery();

    const network = CRYPTO_CHAIN_NETWORK[chain];
    const token = CRYPTO_CHAIN_TOKEN[chain];
    const presets = AMOUNT_PRESETS[token];
    const kb = new InlineKeyboard();
    for (const amount of presets) {
      kb.text(
        ctx.t('credits.crypto.amount_button', { amount, label: cfg.label }),
        `credit:crypto:amt:${chain}:${amount}`,
      );
    }
    kb.row().text(ctx.t('credits.button.back'), `credit:crypto:net:${network}`);

    const text = ctx.t('credits.crypto.amount_picker.title', {
      chain: escapeHtml(cfg.label),
      rate: cfg.rate,
      min: cfg.minAmount,
      max: cfg.maxAmount,
    });
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // ─────────────────────────────────── create invoice (preset amount) ──
  composer.callbackQuery(
    /^credit:crypto:amt:([a-z0-9-]+):([\d.]+)$/,
    async (ctx) => {
      const chain = ctx.match?.[1] as CryptoChainId | undefined;
      const amount = ctx.match?.[2];
      if (!chain || !amount) {
        await ctx.answerCallbackQuery();
        return;
      }
      try {
        const invoice = ctx.services.crypto.createInvoice({
          user: ctx.user,
          chain,
          amount,
        });
        await ctx.answerCallbackQuery();
        const text = renderInvoice(ctx, invoice);
        const kb = invoiceKeyboard(ctx, invoice);
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
        } catch {
          await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
        }
      } catch (err) {
        if (err instanceof AppError && err.expose) {
          await ctx.answerCallbackQuery({ text: err.message });
          return;
        }
        if (err instanceof AppError && err.code === ErrorCode.CRYPTO_CHAIN_DISABLED) {
          await ctx.answerCallbackQuery({ text: ctx.t('credits.crypto.disabled') });
          return;
        }
        if (
          err instanceof AppError &&
          err.code === ErrorCode.CRYPTO_TOO_MANY_ACTIVE_INVOICES
        ) {
          await ctx.answerCallbackQuery({
            text: ctx.t('credits.crypto.too_many_active'),
          });
          // Surface the list inline so the user can cancel an old one and
          // immediately retry without re-navigating through the picker.
          const kb = new InlineKeyboard().text(
            ctx.t('credits.crypto.button.view_open_short'),
            'credit:crypto:list',
          );
          await ctx.reply(ctx.t('credits.crypto.too_many_active'), {
            parse_mode: 'HTML',
            reply_markup: kb,
          });
          return;
        }
        if (err instanceof AppError && err.code === ErrorCode.RATE_LIMITED) {
          await ctx.answerCallbackQuery({
            text: ctx.t('credits.crypto.rate_limited'),
          });
          return;
        }
        throw err;
      }
    },
  );

  // ─────────────────────────────── re-check / re-render an invoice ───
  composer.callbackQuery(/^credit:crypto:inv:(\d+)$/, async (ctx) => {
    const id = Number.parseInt(ctx.match?.[1] ?? '0', 10);
    const found = ctx.services.crypto.findInvoice(id);
    if (!found || found.user_id !== ctx.user.id) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.crypto.invoice.not_found') });
      return;
    }

    let invoice = found;
    if (found.tx_hash) {
      try {
        const result = await ctx.services.crypto.recheckInvoice({
          invoiceId: id,
          actorUserId: ctx.user.id,
          actorIsAdmin: false,
        });
        invoice = result.invoice;
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCode.CRYPTO_RPC_ERROR) {
          await ctx.answerCallbackQuery({
            text: ctx.t('credits.crypto.recheck.rpc_error'),
          });
        }
      }
    }
    await ctx.answerCallbackQuery();
    const text = renderInvoice(ctx, invoice);
    const kb = invoiceKeyboard(ctx, invoice);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // ─────────────────────────────────── user cancels their own invoice ──
  composer.callbackQuery(/^credit:crypto:cancel:(\d+)$/, async (ctx) => {
    const id = Number.parseInt(ctx.match?.[1] ?? '0', 10);
    try {
      const cancelled = ctx.services.crypto.cancelInvoice({
        user: ctx.user,
        invoiceId: id,
      });
      await ctx.answerCallbackQuery({
        text: ctx.t('credits.crypto.cancelled_toast'),
      });
      const text = renderInvoice(ctx, cancelled);
      const kb = invoiceKeyboard(ctx, cancelled);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
      } catch {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
      }
    } catch (err) {
      if (err instanceof AppError) {
        await ctx.answerCallbackQuery({ text: err.message });
        return;
      }
      throw err;
    }
  });

  // ─────────────────────────────── reveal advanced "Need help?" panel ──
  composer.callbackQuery(/^credit:crypto:adv:(\d+)$/, async (ctx) => {
    const id = Number.parseInt(ctx.match?.[1] ?? '0', 10);
    const invoice = ctx.services.crypto.findInvoice(id);
    if (!invoice || invoice.user_id !== ctx.user.id) {
      await ctx.answerCallbackQuery({
        text: ctx.t('credits.crypto.invoice.not_found'),
      });
      return;
    }
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text(
        ctx.t('credits.crypto.button.paste_hash'),
        `credit:crypto:hash:${invoice.id}`,
      )
      .row()
      .text(ctx.t('credits.button.back'), `credit:crypto:inv:${invoice.id}`);
    await ctx.reply(ctx.t('credits.crypto.advanced.help'), {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  });

  // ──────────────────────────────────────────── paste-tx-hash prompt ────
  composer.callbackQuery(/^credit:crypto:hash:(\d+)$/, async (ctx) => {
    const id = Number.parseInt(ctx.match?.[1] ?? '0', 10);
    const invoice = ctx.services.crypto.findInvoice(id);
    if (!invoice || invoice.user_id !== ctx.user.id) {
      await ctx.answerCallbackQuery({ text: ctx.t('credits.crypto.invoice.not_found') });
      return;
    }
    await ctx.answerCallbackQuery();
    pendingHash.set(ctx.user.id, {
      invoiceId: invoice.id,
      chain: invoice.chain,
      issuedAt: Date.now(),
    });
    await ctx.reply(ctx.t('credits.crypto.paste_hash.prompt'), { parse_mode: 'HTML' });
  });

  // ────────────────────────────── plain-text submission of tx hash ──────
  composer.on('message:text', async (ctx, next) => {
    clearStalePending();
    const state = pendingHash.get(ctx.user.id);
    if (!state) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/cancel') || text.toLowerCase() === 'cancel') {
      pendingHash.delete(ctx.user.id);
      await ctx.reply(ctx.t('credits.crypto.paste_hash.cancelled'));
      return;
    }
    if (!/^[0-9a-fA-Fx]{32,128}$/.test(text)) {
      await ctx.reply(ctx.t('credits.crypto.paste_hash.bad_format'));
      return;
    }
    pendingHash.delete(ctx.user.id);

    try {
      const { invoice } = await ctx.services.crypto.submitTxHash({
        user: ctx.user,
        invoiceId: state.invoiceId,
        txHash: text,
      });
      const lines: string[] = [];
      if (invoice.status === 'confirmed') {
        lines.push(
          ctx.t('credits.crypto.paste_hash.applied', {
            credits: invoice.credits_to_grant,
            balance: ctx.services.credits.getBalance(ctx.user.id),
          }),
        );
      } else {
        lines.push(
          ctx.t('credits.crypto.paste_hash.confirming', {
            confirmations: invoice.confirmations,
            required: invoice.required_confirmations,
          }),
        );
      }
      const kb = new InlineKeyboard().text(
        ctx.t('credits.crypto.button.refresh'),
        `credit:crypto:inv:${invoice.id}`,
      );
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
    } catch (err) {
      if (err instanceof AppError) {
        const key = (() => {
          switch (err.code) {
            case ErrorCode.CRYPTO_TX_NOT_FOUND:
              return 'credits.crypto.paste_hash.not_found';
            case ErrorCode.CRYPTO_TX_MISMATCH:
              return 'credits.crypto.paste_hash.mismatch';
            case ErrorCode.CRYPTO_TX_DUPLICATE:
              return 'credits.crypto.paste_hash.duplicate';
            case ErrorCode.CRYPTO_INVOICE_EXPIRED:
              return 'credits.crypto.paste_hash.expired';
            case ErrorCode.CRYPTO_INVOICE_ALREADY_APPLIED:
              return 'credits.crypto.paste_hash.already_applied';
            case ErrorCode.CRYPTO_INVOICE_NOT_FOUND:
              return 'credits.crypto.invoice.not_found';
            default:
              return null;
          }
        })();
        if (key) {
          await ctx.reply(ctx.t(key), backToTopupKeyboardOpts(ctx));
          return;
        }
      }
      throw err;
    }
  });
}

function backToTopupKeyboardOpts(ctx: AppContext): {
  parse_mode: 'HTML';
  reply_markup: InlineKeyboard;
} {
  return { parse_mode: 'HTML', reply_markup: backToTopupKeyboard(ctx) };
}
