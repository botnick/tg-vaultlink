/**
 * VaultLink Mini App — crypto top-up flow.
 *
 * Wave 9.3 redesign: full payment-gateway UX. The user picks **network →
 * token → amount**, the server returns an invoice with a unique decimal
 * suffix (e.g. `10.000072 USDT`), and the bot watches the chain in the
 * background until the matching transfer is detected and confirmed. No
 * tx-hash entry is required for the happy path; an "Already paid" escape
 * hatch is hidden behind a disclosure for RPC-outage / wrong-amount edge
 * cases. Auto-polls every 15s while pending; supports cancel-and-retry
 * before any payment is seen.
 *
 * State machine inside one page (avoids React Router state ping-pong):
 *
 *   network    → pick TRX / BSC / ETH / TON
 *   token      → pick USDT or USDC (filtered to enabled chains)
 *   amount     → pick / enter amount, create invoice
 *   invoice    → waiting-for-payment view with QR + copy + cancel
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { CopyButton } from '../components/CopyButton.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ErrorState } from '../components/ErrorState.js';
import { PaymentQR } from '../components/PaymentQR.js';
import { NetworkBadge, TokenIcon } from '../components/NetworkIcon.js';
import { useT } from '../lib/i18n.js';
import { qk } from '../lib/queryKeys.js';
import {
  cryptoApi,
  type CryptoChainId,
  type CryptoChainItem,
  type CryptoInvoice,
  type CryptoNetwork,
  type CryptoToken,
} from '../lib/credits.api.js';
import { hapticNotify } from '../lib/telegram.js';
import { useCountdown } from '../lib/useCountdown.js';
import { ApiError } from '../types/api.js';

/* ------------------------------------------------------------------------- *
 * Static UX metadata
 * ------------------------------------------------------------------------- */

const NETWORK_ORDER: readonly CryptoNetwork[] = ['trx', 'bsc', 'eth', 'ton'];
const TOKEN_ORDER: readonly CryptoToken[] = ['USDT', 'USDC'];

/**
 * Display names follow the @send / Wallet network picker convention —
 * the bold row title is the chain's everyday name and the subtitle is
 * the token-standard short form. Adding a network = one entry per map.
 */
const NETWORK_LABEL: Record<CryptoNetwork, string> = {
  trx: 'Tron',
  bsc: 'BNB Smart Chain',
  eth: 'Ethereum',
  ton: 'TON',
};

const NETWORK_PROTOCOL: Record<CryptoNetwork, string> = {
  trx: 'TRC20',
  bsc: 'BEP20',
  eth: 'ERC20',
  ton: 'TON',
};

/** Full token names — used as picker subtitles (USDT → "Tether", etc.). */
const TOKEN_FULL_NAME: Record<CryptoToken, string> = {
  USDT: 'Tether',
  USDC: 'USD Coin',
  native: 'Toncoin',
};

/**
 * Per-token accent colour for picker cards. Matches the QR ring palette
 * so the user sees the same brand cue throughout the funnel.
 */
const TOKEN_ACCENT: Record<CryptoToken, { bg: string; fg: string; ring: string }> = {
  USDT: { bg: '#26A17B1a', fg: '#26A17B', ring: '#26A17B' },
  USDC: { bg: '#2775CA1a', fg: '#2775CA', ring: '#2775CA' },
  native: { bg: '#7AA2F71a', fg: '#7AA2F7', ring: '#7AA2F7' },
};

const PRESETS_BY_TOKEN: Record<CryptoToken, readonly string[]> = {
  USDT: ['10', '25', '50', '100', '250', '500'],
  USDC: ['10', '25', '50', '100', '250', '500'],
  native: ['1', '5', '10'],
};

type Stage =
  | { kind: 'network' }
  | { kind: 'token'; network: CryptoNetwork }
  | { kind: 'amount'; chain: CryptoChainId }
  | { kind: 'invoice'; invoiceId: number }
  | { kind: 'list' };

/* ------------------------------------------------------------------------- *
 * Outer page
 * ------------------------------------------------------------------------- */

export function CryptoTopup(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  // Wave 9.3 — `?invoice=<id>` deep-link from the bot's "Open in Mini App"
  // button lands the user straight on the waiting-for-payment panel for
  // the invoice they just created in chat. The query param is read once
  // on first render; subsequent stage transitions are driven by user
  // interaction, so re-navigating doesn't fight the URL.
  const [searchParams] = useSearchParams();
  const initialStage = useMemo<Stage>(() => {
    const raw = searchParams.get('invoice');
    if (raw) {
      const id = Number.parseInt(raw, 10);
      if (Number.isInteger(id) && id > 0) {
        return { kind: 'invoice', invoiceId: id };
      }
    }
    return { kind: 'network' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [stage, setStage] = useState<Stage>(initialStage);

  if (stage.kind === 'invoice') {
    return (
      <InvoicePanel
        invoiceId={stage.invoiceId}
        onBack={() => setStage({ kind: 'network' })}
        t={t}
      />
    );
  }
  if (stage.kind === 'list') {
    return (
      <ActiveInvoicesPanel
        onOpen={(id) => setStage({ kind: 'invoice', invoiceId: id })}
        onBack={() => setStage({ kind: 'network' })}
        t={t}
      />
    );
  }
  if (stage.kind === 'amount') {
    return (
      <AmountPicker
        chain={stage.chain}
        onCancel={() =>
          setStage({
            kind: 'token',
            network: networkForChain(stage.chain),
          })
        }
        onCreated={(inv) => setStage({ kind: 'invoice', invoiceId: inv.id })}
        onTooMany={() => setStage({ kind: 'list' })}
        t={t}
      />
    );
  }
  if (stage.kind === 'token') {
    return (
      <TokenPicker
        network={stage.network}
        onPick={(chain) => setStage({ kind: 'amount', chain })}
        onBack={() => setStage({ kind: 'network' })}
        t={t}
      />
    );
  }
  return (
    <NetworkPicker
      onPick={(network) => setStage({ kind: 'token', network })}
      onOpenList={() => setStage({ kind: 'list' })}
      onBack={() => navigate('/credits')}
      t={t}
    />
  );
}

function networkForChain(id: CryptoChainId): CryptoNetwork {
  if (id.startsWith('tron-')) return 'trx';
  if (id.startsWith('bsc-')) return 'bsc';
  if (id.startsWith('eth-')) return 'eth';
  return 'ton';
}

/* ------------------------------------------------------------------------- *
 * Stage 1 — pick the network
 * ------------------------------------------------------------------------- */

function NetworkPicker({
  onPick,
  onOpenList,
  onBack,
  t,
}: {
  onPick: (network: CryptoNetwork) => void;
  onOpenList: () => void;
  onBack: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const chainsQuery = useQuery({
    queryKey: qk.crypto.chains,
    queryFn: () => cryptoApi.chains(),
    staleTime: 30_000,
  });

  // Open invoices count — drives the "Active invoices (N)" shortcut so the
  // user can find and cancel old pending requests when the per-user cap
  // blocks them from creating a new one.
  const invoicesQuery = useQuery({
    queryKey: qk.crypto.invoices,
    queryFn: () => cryptoApi.listInvoices(20),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
  const activeCount = useMemo(() => {
    const rows = invoicesQuery.data ?? [];
    return rows.filter(
      (r) =>
        r.status === 'pending' || r.status === 'submitted' || r.status === 'confirming',
    ).length;
  }, [invoicesQuery.data]);

  // Derive the set of networks that actually have at least one enabled,
  // picker-visible chain. Hides networks the operator hasn't configured.
  const networks = useMemo(() => {
    if (!chainsQuery.data?.master_enabled) return [] as CryptoNetwork[];
    const have = new Set<CryptoNetwork>();
    for (const c of chainsQuery.data.items) {
      if (c.enabled && c.showInPicker) have.add(c.network);
    }
    return NETWORK_ORDER.filter((n) => have.has(n));
  }, [chainsQuery.data]);

  return (
    <Layout title={t('crypto.title')} back={onBack}>
      {chainsQuery.isLoading ? (
        <SkeletonList rows={3} />
      ) : chainsQuery.isError ? (
        <ErrorState
          message={String(chainsQuery.error)}
          onRetry={() => chainsQuery.refetch()}
        />
      ) : !chainsQuery.data?.master_enabled ? (
        <Card padding="md" className="fade-up">
          <p className="text-sm text-tg-text">{t('crypto.disabled')}</p>
        </Card>
      ) : networks.length === 0 ? (
        <Card padding="md" className="fade-up">
          <p className="text-sm text-tg-text">{t('crypto.no_chains')}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {/* Wave 9.3 — open-invoices shortcut. The cap (3 active/user) blocks
              new top-ups when this counter is at the limit; this banner lets
              the user find and cancel old pending requests directly. */}
          {activeCount > 0 && (
            <Card
              padding="md"
              interactive
              className="fade-up"
              onClick={onOpenList}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-tg-link/10 text-base text-tg-link"
                  >
                    📋
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-tg-text">
                      {t('crypto.open_invoices.title', { n: activeCount })}
                    </p>
                    <p className="mt-0.5 text-xs text-tg-subtitle-text">
                      {t('crypto.open_invoices.subtitle')}
                    </p>
                  </div>
                </div>
                <span aria-hidden className="text-tg-hint">
                  ›
                </span>
              </div>
            </Card>
          )}
          <p className="text-xs uppercase tracking-wider text-tg-hint">
            {t('crypto.choose_network')}
          </p>
          {/* Wallet-style grouped list: one card, internal dividers, circular
              brand logos. Adding/removing a network only touches the
              `networks` array via the registry — no extra UI plumbing. */}
          <Card padding="none" className="fade-up overflow-hidden">
            <ul className="divide-y divide-black/5 dark:divide-white/10">
              {networks.map((n) => (
                <li key={n}>
                  <button
                    type="button"
                    onClick={() => onPick(n)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-black/5 dark:active:bg-white/5"
                  >
                    <NetworkBadge network={n} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-semibold text-tg-text">
                        {NETWORK_LABEL[n]}
                      </p>
                      <p className="mt-0.5 text-sm text-tg-subtitle-text">
                        {NETWORK_PROTOCOL[n]}
                      </p>
                    </div>
                    <span aria-hidden className="text-lg text-tg-hint">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </Layout>
  );
}

/* ------------------------------------------------------------------------- *
 * Stage 2 — pick the token (USDT vs USDC) on the chosen network
 * ------------------------------------------------------------------------- */

function TokenPicker({
  network,
  onPick,
  onBack,
  t,
}: {
  network: CryptoNetwork;
  onPick: (chain: CryptoChainId) => void;
  onBack: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const chainsQuery = useQuery({
    queryKey: qk.crypto.chains,
    queryFn: () => cryptoApi.chains(),
    staleTime: 30_000,
  });

  const items = useMemo(() => {
    const all = chainsQuery.data?.items ?? [];
    return TOKEN_ORDER.flatMap<CryptoChainItem>((tok) => {
      const c = all.find(
        (x) => x.network === network && x.token === tok && x.enabled && x.showInPicker,
      );
      return c ? [c] : [];
    });
  }, [chainsQuery.data, network]);

  return (
    <Layout title={t('crypto.title')} back={onBack}>
      <div className="space-y-3">
        <p className="text-xs uppercase tracking-wider text-tg-hint">
          {t('crypto.choose_token', { network: NETWORK_LABEL[network] })}
        </p>
        {items.length === 0 ? (
          <Card padding="md" className="fade-up">
            <p className="text-sm text-tg-text">{t('crypto.no_tokens_for_network')}</p>
          </Card>
        ) : (
          <Card padding="none" className="fade-up overflow-hidden">
            <ul className="divide-y divide-black/5 dark:divide-white/10">
              {items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPick(c.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-black/5 dark:active:bg-white/5"
                  >
                    <TokenIcon token={c.token} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-semibold text-tg-text">
                        {c.token === 'native' ? 'TON' : c.token}
                      </p>
                      <p className="mt-0.5 text-sm text-tg-subtitle-text">
                        {TOKEN_FULL_NAME[c.token]} · {t('crypto.rate', { rate: c.rate })}
                      </p>
                    </div>
                    <span aria-hidden className="text-lg text-tg-hint">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </Layout>
  );
}

/* ------------------------------------------------------------------------- *
 * Stage 3 — pick / enter amount and create invoice
 * ------------------------------------------------------------------------- */

function AmountPicker({
  chain,
  onCancel,
  onCreated,
  onTooMany,
  t,
}: {
  chain: CryptoChainId;
  onCancel: () => void;
  onCreated: (inv: CryptoInvoice) => void;
  onTooMany: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tooMany, setTooMany] = useState(false);
  // Token bucket → preset list. Defaults to USDT presets if mapping is unclear.
  const tokenKey: CryptoToken = chain.endsWith('-usdc')
    ? 'USDC'
    : chain.endsWith('-usdt') || chain.endsWith('-jetton')
      ? 'USDT'
      : 'native';
  const presets = PRESETS_BY_TOKEN[tokenKey];

  const createMutation = useMutation({
    mutationFn: (amount: string) => cryptoApi.createInvoice({ chain, amount }),
    onSuccess: (inv) => {
      hapticNotify('success');
      onCreated(inv);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message);
        // Wave 9.3 — when the per-user concurrent cap fires, expose a
        // direct shortcut to the active-invoices list so the user can
        // cancel an old one to free a slot.
        if (err.code === 'CRYPTO_TOO_MANY_ACTIVE_INVOICES') setTooMany(true);
      } else {
        setError(String(err));
      }
    },
  });

  // Look up the chain's rate so the preset buttons can show "{amount} →
  // {credits} credits" and make value obvious before tapping.
  const chainsQuery = useQuery({
    queryKey: qk.crypto.chains,
    queryFn: () => cryptoApi.chains(),
    staleTime: 30_000,
  });
  const chainCfg = chainsQuery.data?.items.find((c) => c.id === chain);
  const rate = chainCfg?.rate ?? 100;
  const accent = TOKEN_ACCENT[tokenKey] ?? TOKEN_ACCENT.native;
  const customCredits = useMemo(() => {
    const n = Number.parseFloat(custom);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n * rate);
  }, [custom, rate]);

  const network = networkForChain(chain);

  return (
    <Layout title={t('crypto.title')} back={onCancel}>
      <div className="space-y-4">
        {/* Chain banner — tells the user EXACTLY what network/token they're
            paying on so there's no confusion about which wallet to send from. */}
        <Card padding="md" className="fade-up">
          <div className="flex items-center gap-3">
            <NetworkBadge network={network} size={44} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-tg-text">
                {chainCfg?.label ?? tokenKey}
              </p>
              <p className="mt-0.5 text-xs text-tg-subtitle-text">
                {NETWORK_LABEL[network]} · 1 {tokenKey === 'native' ? '' : tokenKey} ={' '}
                {rate} credits
              </p>
            </div>
            <TokenIcon token={tokenKey} size={32} />
          </div>
        </Card>

        <Card padding="md" className="fade-up">
          <p className="text-xs uppercase tracking-wider text-tg-hint">
            {t('crypto.choose_amount')}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {presets.map((amt) => {
              const credits = Math.floor(Number.parseFloat(amt) * rate);
              return (
                <button
                  key={amt}
                  type="button"
                  onClick={() => createMutation.mutate(amt)}
                  disabled={createMutation.isPending}
                  className="flex flex-col items-start gap-0.5 rounded-2xl border bg-tg-secondary-bg px-4 py-3 text-left transition active:scale-[0.98] disabled:opacity-60"
                  style={{ borderColor: `${accent.ring}40` }}
                >
                  <span className="text-base font-semibold text-tg-text">
                    {amt} {tokenKey === 'native' ? '' : tokenKey}
                  </span>
                  <span className="text-[11px]" style={{ color: accent.fg }}>
                    +{credits.toLocaleString()} credits
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        <Card padding="md" className="fade-up">
          <label className="text-xs uppercase tracking-wider text-tg-hint">
            {t('crypto.amount_input')}
          </label>
          <div className="relative mt-2">
            <input
              type="text"
              inputMode="decimal"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                setError(null);
                setTooMany(false);
              }}
              className="h-12 w-full rounded-2xl border border-black/10 bg-tg-secondary-bg px-4 pr-20 text-base text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 dark:border-white/15"
              placeholder="10.00"
            />
            {tokenKey !== 'native' && (
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs font-medium text-tg-subtitle-text">
                {tokenKey}
              </span>
            )}
          </div>
          {customCredits > 0 && (
            <p
              className="mt-2 text-xs font-medium"
              style={{ color: accent.fg }}
            >
              +{customCredits.toLocaleString()} credits
            </p>
          )}
          {error && (
            <p className="mt-2 text-xs text-tg-destructive-text">{error}</p>
          )}
          {tooMany && (
            <Button
              variant="secondary"
              block
              className="mt-2"
              onClick={onTooMany}
            >
              {t('crypto.open_invoices.view_button')}
            </Button>
          )}
          <Button
            block
            className="mt-3"
            disabled={custom.length === 0 || createMutation.isPending}
            loading={createMutation.isPending}
            onClick={() => createMutation.mutate(custom)}
          >
            {t('crypto.create_invoice')}
          </Button>
        </Card>
      </div>
    </Layout>
  );
}

/* ------------------------------------------------------------------------- *
 * Stage 4 — waiting-for-payment view
 * ------------------------------------------------------------------------- */

function InvoicePanel({
  invoiceId,
  onBack,
  t,
}: {
  invoiceId: number;
  onBack: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const qc = useQueryClient();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [hash, setHash] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const invoiceQuery = useQuery({
    queryKey: qk.crypto.invoice(invoiceId),
    queryFn: () => cryptoApi.getInvoice(invoiceId),
    refetchInterval: (q) => {
      // Auto-poll while the invoice is in flight; stop when terminal.
      const data = (q.state.data ?? null) as CryptoInvoice | null;
      if (!data) return false;
      if (
        data.status === 'submitted' ||
        data.status === 'confirming' ||
        data.status === 'pending'
      ) {
        return 15_000;
      }
      return false;
    },
  });

  const recheckMutation = useMutation({
    mutationFn: () => cryptoApi.recheck(invoiceId),
    onSuccess: (inv) => {
      qc.setQueryData(qk.crypto.invoice(invoiceId), inv);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cryptoApi.cancel(invoiceId),
    onSuccess: (inv) => {
      hapticNotify('success');
      qc.setQueryData(qk.crypto.invoice(invoiceId), inv);
    },
  });

  const submitMutation = useMutation({
    mutationFn: (txHash: string) => cryptoApi.submitTxHash(invoiceId, txHash),
    onSuccess: (inv) => {
      hapticNotify(inv.status === 'confirmed' ? 'success' : 'warning');
      qc.setQueryData(qk.crypto.invoice(invoiceId), inv);
      setHash('');
    },
    onError: (err) => {
      setSubmitError(err instanceof ApiError ? err.message : String(err));
    },
  });

  const inv = invoiceQuery.data;
  // Wave 9.3 — live-updating mm:ss countdown so the user sees the
  // deadline tick down in real time, not a stale "X min" snapshot from
  // when the panel mounted.
  const countdown = useCountdown(inv?.expires_at ?? null);

  if (invoiceQuery.isLoading) {
    return (
      <Layout title={t('crypto.invoice.title')} back={onBack}>
        <SkeletonList rows={4} />
      </Layout>
    );
  }
  if (!inv) {
    return (
      <Layout title={t('crypto.invoice.title')} back={onBack}>
        <ErrorState
          message={String(invoiceQuery.error ?? 'unknown')}
          onRetry={() => invoiceQuery.refetch()}
        />
      </Layout>
    );
  }

  const expired =
    inv.status === 'expired' ||
    (inv.status === 'pending' && countdown.expired);
  const cancelled = inv.failure_reason === 'user_cancelled';
  const terminal =
    inv.status === 'confirmed' || inv.status === 'expired' || inv.status === 'failed';
  const inFlight =
    inv.status === 'pending' ||
    inv.status === 'submitted' ||
    inv.status === 'confirming';

  // Status banner — single source of truth for the user-visible state.
  const statusBanner = (() => {
    if (inv.status === 'confirmed') {
      return {
        label: t('crypto.status.confirmed', { credits: inv.credits_to_grant }),
        tone: 'success' as const,
      };
    }
    if (cancelled) {
      return { label: t('crypto.status.cancelled'), tone: 'muted' as const };
    }
    if (expired) {
      return { label: t('crypto.invoice.expired'), tone: 'destructive' as const };
    }
    if (inv.status === 'failed') {
      return {
        label: inv.failure_reason ?? t('crypto.status.failed'),
        tone: 'destructive' as const,
      };
    }
    if (inv.status === 'submitted' || inv.status === 'confirming') {
      return {
        label: t('crypto.status.detecting', {
          conf: inv.confirmations,
          required: inv.required_confirmations,
        }),
        tone: 'info' as const,
      };
    }
    return { label: t('crypto.status.waiting'), tone: 'info' as const };
  })();

  return (
    <Layout title={t('crypto.invoice.title')} back={onBack}>
      <div className="space-y-4">
        {/* Hero amount card — TAP-TO-COPY because exact amount is the
            primary attribution signal for full-auto detection. */}
        <Card
          padding="lg"
          variant="gradient"
          accentGlow="cyan"
          className="fade-up text-white"
        >
          <p className="text-xs uppercase tracking-wider opacity-80">
            {t('crypto.invoice.amount_exact')}
          </p>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <p className="text-3xl font-bold tabular-nums leading-tight">
              {inv.amount_unit}
            </p>
            <CopyButton value={inv.amount_unit} />
          </div>
          <p className="mt-1 text-sm opacity-90">{inv.amount_label}</p>
          <p className="mt-3 text-sm opacity-90">+{inv.credits_to_grant} credits</p>
          {inFlight && (
            <div
              className="mt-4 flex items-center justify-between rounded-2xl px-3 py-2"
              style={{ background: 'rgba(255,255,255,0.16)' }}
            >
              <span className="text-xs uppercase tracking-wider opacity-80">
                {t('crypto.invoice.expires_label')}
              </span>
              <span
                className="font-mono text-2xl font-bold tabular-nums"
                style={{
                  color: countdown.totalMs < 5 * 60_000 ? '#FFD7D7' : '#FFFFFF',
                }}
              >
                {countdown.mmss}
              </span>
            </div>
          )}
        </Card>

        {/* QR + address — shown only while still actionable. */}
        {inFlight && (
          <Card padding="md" className="fade-up">
            <div className="my-2 flex justify-center">
              <PaymentQR
                data={inv.payment_uri ?? inv.pay_to_address}
                caption={t('crypto.invoice.qr_caption')}
                network={inv.network}
                token={inv.token}
                pulse
              />
            </div>

            <p className="mt-4 text-xs uppercase tracking-wider text-tg-hint">
              {t('crypto.invoice.send_to')}
            </p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <code className="select-all break-all text-sm text-tg-text">
                {inv.pay_to_address}
              </code>
              <CopyButton value={inv.pay_to_address} />
            </div>
            {inv.memo ? (
              <>
                <p className="mt-4 text-xs uppercase tracking-wider text-tg-hint">
                  {t('crypto.invoice.memo')}
                </p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <code className="select-all text-sm text-tg-text">{inv.memo}</code>
                  <CopyButton value={inv.memo} />
                </div>
                <p className="mt-2 text-xs text-tg-subtitle-text">
                  {t('crypto.invoice.memo_warning')}
                </p>
              </>
            ) : (
              <p className="mt-3 text-xs text-tg-subtitle-text">
                {t('crypto.invoice.amount_strict')}
              </p>
            )}

            {/* Disclosure — what does this QR encode? Privacy-conscious users
                can verify before scanning. */}
            <details className="mt-4 text-xs text-tg-subtitle-text">
              <summary className="cursor-pointer select-none">
                {t('crypto.invoice.qr_disclosure')}
              </summary>
              <code className="mt-2 block break-all text-[10px] text-tg-hint">
                {inv.payment_uri ?? inv.pay_to_address}
              </code>
            </details>
          </Card>
        )}

        {/* Status + controls */}
        <Card padding="md" className="fade-up">
          <p
            className={
              statusBanner.tone === 'success'
                ? 'text-sm font-medium text-emerald-500'
                : statusBanner.tone === 'destructive'
                  ? 'text-sm font-medium text-tg-destructive-text'
                  : statusBanner.tone === 'muted'
                    ? 'text-sm font-medium text-tg-subtitle-text'
                    : 'text-sm font-medium text-tg-text'
            }
          >
            {statusBanner.label}
          </p>

          {inv.tx_hash && (
            <div className="mt-3 space-y-1">
              <p className="text-xs text-tg-subtitle-text">
                {t('crypto.invoice.tx_hash')}
              </p>
              <code className="block break-all text-xs text-tg-text">
                {inv.tx_hash}
              </code>
            </div>
          )}

          {inFlight && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={recheckMutation.isPending}
                onClick={() => recheckMutation.mutate()}
              >
                {t('crypto.button.refresh')}
              </Button>
              {/* Cancel allowed any time before credits are issued — covers the
                  legacy case where a stranger's transfer got mis-attributed
                  to this invoice (status flipped to submitted/confirming
                  without the user paying). Server keeps the tx_hash sticky
                  on cancel so the same payment can't be re-credited
                  elsewhere. */}
              {inv.status !== 'confirmed' && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={cancelMutation.isPending}
                  onClick={() => cancelMutation.mutate()}
                >
                  {t('crypto.button.cancel')}
                </Button>
              )}
            </div>
          )}

          {terminal && !cancelled && inv.status !== 'confirmed' && (
            <div className="mt-3">
              <Button variant="primary" onClick={onBack}>
                {t('crypto.button.try_again')}
              </Button>
            </div>
          )}
          {(cancelled || inv.status === 'confirmed') && (
            <div className="mt-3">
              <Button variant="primary" onClick={onBack}>
                {t('crypto.button.done')}
              </Button>
            </div>
          )}
        </Card>

        {/* Advanced fallback — manual tx-hash paste, only when auto-detect
            is impossible (RPC outage, wrong-amount that the worker won't
            match). Hidden behind a disclosure so it never competes with
            the primary auto-detect path. */}
        {inFlight && (
          <Card padding="md" className="fade-up">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left text-xs uppercase tracking-wider text-tg-hint"
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              <span>{t('crypto.advanced.title')}</span>
              <span aria-hidden>{advancedOpen ? '▾' : '▸'}</span>
            </button>
            {advancedOpen && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-tg-subtitle-text">
                  {t('crypto.advanced.help')}
                </p>
                <input
                  type="text"
                  value={hash}
                  onChange={(e) => {
                    setHash(e.target.value.trim());
                    setSubmitError(null);
                  }}
                  placeholder={t('crypto.advanced.placeholder')}
                  className="h-12 w-full rounded-2xl border border-black/10 bg-tg-secondary-bg px-4 font-mono text-xs text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 dark:border-white/15"
                />
                {submitError && (
                  <p className="text-xs text-tg-destructive-text">{submitError}</p>
                )}
                <Button
                  variant="primary"
                  block
                  loading={submitMutation.isPending}
                  disabled={hash.length < 32 || submitMutation.isPending}
                  onClick={() => submitMutation.mutate(hash)}
                >
                  {t('crypto.advanced.submit')}
                </Button>
              </div>
            )}
          </Card>
        )}
      </div>
    </Layout>
  );
}

/* ------------------------------------------------------------------------- *
 * Side-stage — list of currently-active invoices (cancellable)
 *
 * Lets the user find old pending requests and cancel them without having to
 * remember an invoice id. The cancel button only appears for invoices that
 * are still cancellable (status=pending, no tx_hash). Server enforces.
 * ------------------------------------------------------------------------- */

function ActiveInvoicesPanel({
  onOpen,
  onBack,
  t,
}: {
  onOpen: (id: number) => void;
  onBack: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const qc = useQueryClient();
  const invoicesQuery = useQuery({
    queryKey: qk.crypto.invoices,
    queryFn: () => cryptoApi.listInvoices(20),
    staleTime: 0,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) => cryptoApi.cancel(id),
    onSuccess: () => {
      hapticNotify('success');
      qc.invalidateQueries({ queryKey: qk.crypto.invoices });
    },
  });

  const active = useMemo(() => {
    const rows = invoicesQuery.data ?? [];
    return rows.filter(
      (r) =>
        r.status === 'pending' || r.status === 'submitted' || r.status === 'confirming',
    );
  }, [invoicesQuery.data]);

  return (
    <Layout title={t('crypto.open_invoices.title', { n: active.length })} back={onBack}>
      {invoicesQuery.isLoading ? (
        <SkeletonList rows={3} />
      ) : invoicesQuery.isError ? (
        <ErrorState
          message={String(invoicesQuery.error)}
          onRetry={() => invoicesQuery.refetch()}
        />
      ) : active.length === 0 ? (
        <Card padding="md" className="fade-up">
          <p className="text-sm text-tg-text">{t('crypto.open_invoices.empty')}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wider text-tg-hint">
            {t('crypto.open_invoices.subtitle')}
          </p>
          {active.map((inv) => {
            // Wave 9.3 — every still-active invoice can be cancelled. Pre-9.3
            // invoices without unique-suffix amounts can be wrongly attributed
            // to a stranger's transfer (status flips to submitted/confirming
            // even though the user never paid); they need a way to clear those.
            const cancellable = inv.status !== 'confirmed';
            return (
              <ActiveInvoiceRow
                key={inv.id}
                inv={inv}
                cancellable={cancellable}
                cancelMutation={cancelMutation}
                onOpen={onOpen}
                t={t}
              />
            );
          })}
        </div>
      )}
    </Layout>
  );
}

/* -- Helper row component so each card can subscribe to its own countdown -- */

function ActiveInvoiceRow({
  inv,
  cancellable,
  cancelMutation,
  onOpen,
  t,
}: {
  inv: CryptoInvoice;
  cancellable: boolean;
  cancelMutation: ReturnType<typeof useMutation<CryptoInvoice, Error, number>>;
  onOpen: (id: number) => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const countdown = useCountdown(inv.expires_at);
  return (
    <Card padding="md" className="fade-up">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-tg-text">{inv.amount_label}</p>
          <p className="mt-0.5 text-xs text-tg-subtitle-text">
            {inv.token} · {inv.network.toUpperCase()} ·{' '}
            {inv.status === 'pending'
              ? t('crypto.status.waiting_short')
              : t('crypto.status.detecting_short', {
                  conf: inv.confirmations,
                  required: inv.required_confirmations,
                })}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-tg-hint">
            <span>#{inv.id}</span>
            <span>·</span>
            <span
              className="font-mono tabular-nums"
              style={{
                color: countdown.totalMs < 5 * 60_000 ? '#E45252' : undefined,
              }}
            >
              {countdown.mmss}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Button size="sm" variant="secondary" onClick={() => onOpen(inv.id)}>
            {t('crypto.open_invoices.open')}
          </Button>
          {cancellable && (
            <Button
              size="sm"
              variant="ghost"
              loading={
                cancelMutation.isPending && cancelMutation.variables === inv.id
              }
              onClick={() => cancelMutation.mutate(inv.id)}
            >
              {t('crypto.button.cancel')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
