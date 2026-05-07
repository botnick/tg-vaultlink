/**
 * Admin-side crypto top-up router.
 *
 * Founder-only commands to:
 *   - Toggle the master switch + per-chain enable/disable
 *   - Set per-chain receiving address, confirmations, rate, api_key
 *   - List recent invoices (super admin) and inspect one
 *
 * Every mutation flows through `CreditService.setSetting` so the audit log
 * captures the old/new values. Admin can also override numeric tunables
 * via the existing `/admin_credit_set` command (the keys live under
 * `credits.crypto.*`).
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { adminOnlyMiddleware } from '../middlewares/adminOnly.middleware.js';
import { founderOnlyMiddleware } from '../middlewares/founderOnly.middleware.js';
import {
  CRYPTO_SETTING_KEYS,
  chainKey,
} from '../../services/crypto/cryptoTopup.service.js';
import { CRYPTO_CHAIN_IDS, type CryptoChainId } from '../../types/index.js';
import { escapeHtml } from '../../utils/safeText.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

function emoji(on: boolean): string {
  return on ? '🟢' : '🔴';
}

function isValidChain(id: string): id is CryptoChainId {
  return (CRYPTO_CHAIN_IDS as readonly string[]).includes(id);
}

function renderPanel(ctx: AppContext): { text: string; keyboard: InlineKeyboard } {
  const svc = ctx.services.crypto;
  const lines: string[] = [];
  lines.push(ctx.t('admin.crypto.title'));
  lines.push('');
  lines.push(ctx.t('admin.crypto.master', { status: emoji(svc.isEnabled()) }));
  lines.push(ctx.t('admin.crypto.poll_interval', { seconds: svc.pollIntervalSeconds() }));
  lines.push(ctx.t('admin.crypto.invoice_ttl', { minutes: svc.invoiceTtlMinutes() }));
  lines.push(ctx.t('admin.crypto.tolerance_bps', { bps: svc.amountToleranceBps() }));
  lines.push('');
  for (const cfg of svc.listChainConfigs()) {
    lines.push(
      ctx.t('admin.crypto.chain_row', {
        id: cfg.id,
        label: escapeHtml(cfg.label),
        status: emoji(cfg.enabled),
        address: cfg.address.length > 0 ? escapeHtml(cfg.address) : ctx.t('admin.crypto.address_unset'),
        rate: cfg.rate,
        confirmations: cfg.confirmations,
      }),
    );
    lines.push('');
  }
  lines.push(ctx.t('admin.crypto.help_set'));
  lines.push(ctx.t('admin.crypto.help_address'));
  lines.push(ctx.t('admin.crypto.help_chain_toggle'));

  const kb = new InlineKeyboard()
    .text(ctx.t('admin.crypto.button.toggle_master'), 'admin:crypto:toggle:master')
    .row();
  for (const cfg of svc.listChainConfigs()) {
    kb.text(
      ctx.t('admin.crypto.button.toggle_chain', { id: cfg.id }),
      `admin:crypto:toggle:${cfg.id}`,
    ).row();
  }
  kb.text(ctx.t('admin.credits.button.refresh'), 'admin:crypto:refresh');
  return { text: lines.join('\n'), keyboard: kb };
}

export function registerAdminCryptoRouter(composer: Composer<AppContext>): void {
  const superAdmin = adminOnlyMiddleware();
  const founder = founderOnlyMiddleware();

  composer.command('admin_crypto', superAdmin, async (ctx) => {
    const { text, keyboard } = renderPanel(ctx);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  composer.callbackQuery('admin:crypto:refresh', superAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, keyboard } = renderPanel(ctx);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  });

  composer.callbackQuery('admin:crypto:toggle:master', founder, async (ctx) => {
    const cur = ctx.services.crypto.isEnabled();
    ctx.services.credits.setSetting(
      CRYPTO_SETTING_KEYS.enabled,
      { kind: 'bool', value: !cur },
      ctx.user.id,
    );
    await ctx.answerCallbackQuery({
      text: ctx.t('admin.crypto.toggled', { what: 'master', value: !cur ? 'on' : 'off' }),
    });
    const { text, keyboard } = renderPanel(ctx);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch {
      // ignore
    }
  });

  composer.callbackQuery(
    /^admin:crypto:toggle:(tron-usdt|ton-native|ton-usdt-jetton)$/,
    founder,
    async (ctx) => {
      const id = ctx.match?.[1];
      if (!id || !isValidChain(id)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const cfg = ctx.services.crypto.chainConfig(id);
      if (!cfg) {
        await ctx.answerCallbackQuery();
        return;
      }
      const next = !cfg.enabled;
      // Refuse to enable without an address — saves a mistake at runtime.
      if (next && cfg.address.length === 0) {
        await ctx.answerCallbackQuery({
          text: ctx.t('admin.crypto.set_address_first', { id }),
          show_alert: true,
        });
        return;
      }
      ctx.services.credits.setSetting(
        chainKey(id, 'enabled'),
        { kind: 'bool', value: next },
        ctx.user.id,
      );
      await ctx.answerCallbackQuery({
        text: ctx.t('admin.crypto.toggled', { what: id, value: next ? 'on' : 'off' }),
      });
      const { text, keyboard } = renderPanel(ctx);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch {
        // ignore
      }
    },
  );

  /* ----------------------------------------- numeric / string setters --- */

  composer.command('admin_crypto_address', founder, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const chain = args[0];
    const address = args[1];
    if (!chain || !address) {
      await ctx.reply(ctx.t('admin.crypto.address.usage'), { parse_mode: 'HTML' });
      return;
    }
    if (!isValidChain(chain)) {
      await ctx.reply(ctx.t('admin.crypto.address.unknown_chain', { chain: escapeHtml(chain) }), {
        parse_mode: 'HTML',
      });
      return;
    }
    const adapter = ctx.services.crypto.adapterFor(chain);
    if (adapter && !adapter.validateAddress(address)) {
      await ctx.reply(ctx.t('admin.crypto.address.invalid', { chain, address: escapeHtml(address) }), {
        parse_mode: 'HTML',
      });
      return;
    }
    ctx.services.settings.setString(chainKey(chain, 'address'), address);
    ctx.services.audit.log('crypto.address_changed', {
      actorUserId: ctx.user.id,
      targetType: 'setting',
      targetId: chainKey(chain, 'address'),
      metadata: { chain, address },
    });
    await ctx.reply(ctx.t('admin.crypto.address.ok', { chain, address: escapeHtml(address) }), {
      parse_mode: 'HTML',
    });
  });

  composer.command('admin_crypto_apikey', founder, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const chain = args[0];
    const apiKey = args.slice(1).join(' ').trim();
    if (!chain || !apiKey) {
      await ctx.reply(ctx.t('admin.crypto.apikey.usage'), { parse_mode: 'HTML' });
      return;
    }
    if (!isValidChain(chain)) {
      await ctx.reply(ctx.t('admin.crypto.address.unknown_chain', { chain: escapeHtml(chain) }), {
        parse_mode: 'HTML',
      });
      return;
    }
    ctx.services.settings.setString(chainKey(chain, 'api_key'), apiKey);
    ctx.services.audit.log('crypto.apikey_changed', {
      actorUserId: ctx.user.id,
      targetType: 'setting',
      targetId: chainKey(chain, 'api_key'),
      metadata: { chain },
    });
    await ctx.reply(ctx.t('admin.crypto.apikey.ok', { chain }));
  });

  /* -------------------------------------------------- invoice inspect --- */

  // ─────────────────────────────────────── invoice rescue / recheck ───
  composer.command('admin_crypto_invoice_recheck', superAdmin, async (ctx) => {
    const id = Number.parseInt((ctx.match ?? '').toString().trim(), 10);
    if (!Number.isInteger(id) || id < 1) {
      await ctx.reply(ctx.t('admin.crypto.recheck.usage'), { parse_mode: 'HTML' });
      return;
    }
    try {
      const { invoice, verification } = await ctx.services.crypto.recheckInvoice({
        invoiceId: id,
        actorUserId: ctx.user.id,
        actorIsAdmin: true,
      });
      await ctx.reply(
        ctx.t('admin.crypto.recheck.ok', {
          id,
          status: invoice.status,
          confirmations: invoice.confirmations,
          required: invoice.required_confirmations,
          state: verification?.state ?? 'no_tx',
        }),
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      if (err instanceof AppError) {
        await ctx.reply(`❌ ${err.code}: ${err.message}`);
        return;
      }
      throw err;
    }
  });

  composer.command('admin_crypto_invoice_force', founder, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const id = Number.parseInt(args[0] ?? '', 10);
    const note = args.slice(1).join(' ').trim();
    if (!Number.isInteger(id) || id < 1) {
      await ctx.reply(ctx.t('admin.crypto.force.usage'), { parse_mode: 'HTML' });
      return;
    }
    try {
      const inv = await ctx.services.crypto.forceApplyInvoice({
        invoiceId: id,
        actorUserId: ctx.user.id,
        ...(note.length > 0 ? { note } : {}),
      });
      await ctx.reply(
        ctx.t('admin.crypto.force.ok', {
          id,
          credits: inv.credits_to_grant,
          status: inv.status,
        }),
      );
    } catch (err) {
      if (err instanceof AppError) {
        await ctx.reply(`❌ ${err.code}: ${err.message}`);
        return;
      }
      throw err;
    }
  });

  composer.command('admin_crypto_invoice_attach', founder, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const id = Number.parseInt(args[0] ?? '', 10);
    const txHash = args[1];
    const note = args.slice(2).join(' ').trim();
    if (!Number.isInteger(id) || id < 1 || !txHash) {
      await ctx.reply(ctx.t('admin.crypto.attach.usage'), { parse_mode: 'HTML' });
      return;
    }
    try {
      const { invoice, verification } = await ctx.services.crypto.adminAttachHash({
        invoiceId: id,
        txHash,
        actorUserId: ctx.user.id,
        ...(note.length > 0 ? { note } : {}),
      });
      await ctx.reply(
        ctx.t('admin.crypto.attach.ok', {
          id,
          status: invoice.status,
          confirmations: invoice.confirmations,
          required: invoice.required_confirmations,
          state: verification.state,
        }),
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      if (err instanceof AppError) {
        await ctx.reply(`❌ ${err.code}: ${err.message}`);
        return;
      }
      throw err;
    }
  });

  composer.command('admin_crypto_invoice_extend', founder, async (ctx) => {
    const args = (ctx.match ?? '').toString().trim().split(/\s+/);
    const id = Number.parseInt(args[0] ?? '', 10);
    const minutes = Number.parseInt(args[1] ?? '', 10);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(minutes) || minutes < 1) {
      await ctx.reply(ctx.t('admin.crypto.extend.usage'), { parse_mode: 'HTML' });
      return;
    }
    try {
      const inv = ctx.services.crypto.extendInvoice({
        invoiceId: id,
        actorUserId: ctx.user.id,
        minutes,
      });
      await ctx.reply(
        ctx.t('admin.crypto.extend.ok', {
          id,
          minutes,
          new_expiry: inv.expires_at,
          status: inv.status,
        }),
      );
    } catch (err) {
      if (err instanceof AppError) {
        await ctx.reply(`❌ ${err.code}: ${err.message}`);
        return;
      }
      throw err;
    }
  });

  composer.command('admin_crypto_invoice', superAdmin, async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    const id = Number.parseInt(arg, 10);
    if (!Number.isInteger(id) || id < 1) {
      await ctx.reply(ctx.t('admin.crypto.invoice.usage'), { parse_mode: 'HTML' });
      return;
    }
    const inv = ctx.services.crypto.findInvoice(id);
    if (!inv) {
      await ctx.reply(ctx.t('admin.crypto.invoice.not_found', { id }));
      return;
    }
    const lines = [
      `<b>Invoice #${inv.id}</b>`,
      `chain: <code>${inv.chain}</code>`,
      `user: <code>${inv.user_id}</code>`,
      `amount: ${escapeHtml(inv.amount_label)}`,
      `credits: ${inv.credits_to_grant}`,
      `status: <code>${inv.status}</code>`,
      `address: <code>${escapeHtml(inv.pay_to_address)}</code>`,
      `memo: <code>${escapeHtml(inv.memo ?? '-')}</code>`,
      `tx_hash: <code>${escapeHtml(inv.tx_hash ?? '-')}</code>`,
      `confirmations: ${inv.confirmations}/${inv.required_confirmations}`,
      `created: ${inv.created_at}`,
      `expires: ${inv.expires_at}`,
      `applied: ${inv.applied_at ?? '-'}`,
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // Touch ErrorCode so the lint stays happy if a sub-block doesn't use it.
  void ErrorCode.INTERNAL_ERROR;
  void AppError;
}
