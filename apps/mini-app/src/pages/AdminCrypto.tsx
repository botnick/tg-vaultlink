/**
 * VaultLink Mini App — Crypto admin page.
 *
 * Two sections:
 *
 *   1. Chain configuration (per chain): toggle, address, conf threshold,
 *      rate, min/max amount, api-key rotation.
 *
 *   2. Invoice queue: table of recent invoices with per-row actions —
 *      recheck (any admin), attach hash / force-apply / extend (founder).
 *      Use case: a user paid late or the auto-poller missed; the operator
 *      can rescue the payment from this screen.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ErrorState } from '../components/ErrorState.js';
import { useT } from '../lib/i18n.js';
import { qk } from '../lib/queryKeys.js';
import {
  adminCryptoApi,
  cryptoApi,
  type AdminCryptoInvoice,
  type CryptoChainItem,
} from '../lib/credits.api.js';
import { useAuth } from '../providers/AuthProvider.js';
import { hapticNotify } from '../lib/telegram.js';
import { ApiError } from '../types/api.js';

export function AdminCrypto(): JSX.Element {
  const t = useT();

  return (
    <Layout title={t('admin_crypto.title')} back={() => history.back()}>
      <div className="space-y-4">
        <ChainsSection t={t} />
        <InvoicesSection t={t} />
      </div>
    </Layout>
  );
}

/* ----------------------------------------------------------- chains --- */

function ChainsSection({
  t,
}: {
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const chainsQuery = useQuery({
    queryKey: qk.crypto.chains,
    queryFn: () => cryptoApi.chains(),
    staleTime: 15_000,
  });

  if (chainsQuery.isLoading) return <SkeletonList rows={3} />;
  if (chainsQuery.isError || !chainsQuery.data) {
    return (
      <ErrorState
        message={String(chainsQuery.error)}
        onRetry={() => chainsQuery.refetch()}
      />
    );
  }
  const items = chainsQuery.data.items;

  return (
    <Card padding="md" className="fade-up">
      <p className="text-xs uppercase tracking-wider text-tg-hint">
        {t('admin_crypto.section.chains')}
      </p>
      <div className="mt-3 space-y-4">
        {items.map((c) => (
          <ChainEditor key={c.id} chain={c} t={t} />
        ))}
      </div>
    </Card>
  );
}

function ChainEditor({
  chain,
  t,
}: {
  chain: CryptoChainItem;
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const { isFounder } = useAuth();
  const qc = useQueryClient();
  const [address, setAddress] = useState(chain.address ?? '');
  const [conf, setConf] = useState(String(chain.confirmations));
  const [rate, setRate] = useState(String(chain.rate));
  const [minA, setMinA] = useState(chain.minAmount);
  const [maxA, setMaxA] = useState(chain.maxAmount);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Keep local state in sync if the upstream chain config changes.
  useEffect(() => {
    setAddress(chain.address ?? '');
    setConf(String(chain.confirmations));
    setRate(String(chain.rate));
    setMinA(chain.minAmount);
    setMaxA(chain.maxAmount);
  }, [chain]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: Parameters<typeof adminCryptoApi.patchChain>[1] = {};
      if (address !== (chain.address ?? '')) payload.address = address;
      const c = Number.parseInt(conf, 10);
      if (Number.isInteger(c) && c >= 1 && c !== chain.confirmations) payload.confirmations = c;
      const r = Number.parseInt(rate, 10);
      if (Number.isInteger(r) && r >= 1 && r !== chain.rate) payload.rate = r;
      if (minA !== chain.minAmount) payload.min_amount = minA;
      if (maxA !== chain.maxAmount) payload.max_amount = maxA;
      if (Object.keys(payload).length === 0) {
        return Promise.resolve({});
      }
      return adminCryptoApi.patchChain(chain.id, payload);
    },
    onSuccess: () => {
      hapticNotify('success');
      setError(null);
      qc.invalidateQueries({ queryKey: qk.crypto.chains });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : String(err));
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (next: boolean) => {
      // When enabling, opportunistically include the locally-typed
      // address so the user doesn't have to click "Save" first then
      // toggle separately. The backend rejects enable-with-no-address
      // with INVALID_INPUT, so this UX shortcut is the difference
      // between "one click works" and "click → 400 → save → click".
      const payload: Parameters<typeof adminCryptoApi.patchChain>[1] = {
        enabled: next,
      };
      if (next && address.length > 0 && address !== (chain.address ?? '')) {
        payload.address = address;
      }
      return adminCryptoApi.patchChain(chain.id, payload);
    },
    onSuccess: () => {
      hapticNotify('success');
      setError(null);
      qc.invalidateQueries({ queryKey: qk.crypto.chains });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : String(err));
    },
  });

  const [removeOpen, setRemoveOpen] = useState(false);
  const apiKeyMutation = useMutation({
    mutationFn: (next: string) => adminCryptoApi.setApiKey(chain.id, next),
    onSuccess: () => {
      hapticNotify('success');
      setApiKey('');
      setRemoveOpen(false);
      qc.invalidateQueries({ queryKey: qk.crypto.chains });
    },
  });

  return (
    <div className="rounded-2xl border border-black/5 p-3 dark:border-white/10">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-tg-text">{chain.label}</p>
          <p className="text-xs text-tg-subtitle-text">{chain.id}</p>
        </div>
        <Button
          size="sm"
          variant={chain.enabled ? 'destructive' : 'primary'}
          disabled={
            !isFounder ||
            toggleMutation.isPending ||
            // Block enable when there's no address saved AND nothing typed.
            (!chain.enabled && address.length === 0)
          }
          onClick={() => toggleMutation.mutate(!chain.enabled)}
        >
          {chain.enabled
            ? t('admin_crypto.chain.toggle_off')
            : t('admin_crypto.chain.toggle_on')}
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        <Field
          label={t('admin_crypto.chain.address')}
          value={address}
          onChange={setAddress}
          disabled={!isFounder}
        />
        <div className="grid grid-cols-2 gap-2">
          <Field
            label={t('admin_crypto.chain.confirmations')}
            value={conf}
            onChange={setConf}
            disabled={!isFounder}
          />
          <Field
            label={t('admin_crypto.chain.rate')}
            value={rate}
            onChange={setRate}
            disabled={!isFounder}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label={t('admin_crypto.chain.min_amount')}
            value={minA}
            onChange={setMinA}
            disabled={!isFounder}
          />
          <Field
            label={t('admin_crypto.chain.max_amount')}
            value={maxA}
            onChange={setMaxA}
            disabled={!isFounder}
          />
        </div>
        {error && <p className="text-xs text-tg-destructive-text">{error}</p>}
        <Button
          size="sm"
          variant="secondary"
          disabled={!isFounder || saveMutation.isPending}
          loading={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {t('admin_crypto.chain.save')}
        </Button>
      </div>

      <ApiKeySection
        chain={chain}
        t={t}
        isFounder={isFounder}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        saving={apiKeyMutation.isPending}
        onSave={() => apiKeyMutation.mutate(apiKey)}
        removeOpen={removeOpen}
        onRequestRemove={() => setRemoveOpen(true)}
        onCancelRemove={() => setRemoveOpen(false)}
        onConfirmRemove={() => apiKeyMutation.mutate('')}
      />
    </div>
  );
}

/* --------------------------------------------------- chain api key UI --- */

/**
 * RPC-provider API key block — only rendered for chains whose adapter
 * actually reads the `api_key` setting (TRON via TronGrid, TON via
 * TONcenter). EVM chains use the env-configured RPC URL directly so the
 * field is irrelevant for them and would only confuse the operator.
 */
function ApiKeySection({
  chain,
  t,
  isFounder,
  apiKey,
  onApiKeyChange,
  saving,
  onSave,
  removeOpen,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  chain: CryptoChainItem;
  t: (k: string, p?: Record<string, string | number>) => string;
  isFounder: boolean;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  removeOpen: boolean;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}): JSX.Element | null {
  // Hide for chains whose adapter doesn't consume an api_key — no point
  // showing a control that does nothing. Keep this in sync with the
  // chain.registry buildAdapter functions (only TRON + TON read it).
  if (chain.network !== 'trx' && chain.network !== 'ton') return null;

  const provider = chain.network === 'trx' ? 'TronGrid' : 'TONcenter';
  const helperKey =
    chain.network === 'trx'
      ? 'admin_crypto.chain.api_key.helper.tron'
      : 'admin_crypto.chain.api_key.helper.ton';

  return (
    <div className="mt-4 rounded-xl bg-tg-secondary-bg/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-tg-text">
          {t('admin_crypto.chain.api_key.title', { provider })}
        </p>
        <span
          className={[
            'rounded-full px-2 py-0.5 text-[10px] font-medium',
            chain.apiKeySet
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : 'bg-tg-hint/20 text-tg-subtitle-text',
          ].join(' ')}
        >
          {chain.apiKeySet
            ? t('admin_crypto.chain.api_key.status.set')
            : t('admin_crypto.chain.api_key.status.unset')}
        </span>
      </div>
      <p className="mt-1 text-xs text-tg-subtitle-text">{t(helperKey)}</p>

      <div className="mt-2 space-y-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          disabled={!isFounder || saving}
          placeholder={t('admin_crypto.chain.api_key.placeholder')}
          className="h-10 w-full rounded-xl border border-black/10 bg-tg-bg px-3 font-mono text-sm text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 disabled:opacity-50 dark:border-white/15"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={!isFounder || apiKey.length === 0 || saving}
            loading={saving && apiKey.length > 0}
            onClick={onSave}
          >
            {chain.apiKeySet
              ? t('admin_crypto.chain.api_key.action.replace')
              : t('admin_crypto.chain.api_key.action.save')}
          </Button>
          {chain.apiKeySet && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!isFounder || saving}
              onClick={onRequestRemove}
            >
              {t('admin_crypto.chain.api_key.action.remove')}
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={removeOpen}
        title={t('admin_crypto.chain.api_key.remove.title')}
        message={t('admin_crypto.chain.api_key.remove.message', { provider })}
        confirmLabel={t('admin_crypto.chain.api_key.action.remove')}
        destructive
        loading={saving && apiKey.length === 0}
        onConfirm={onConfirmRemove}
        onCancel={onCancelRemove}
      />
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}): JSX.Element {
  return (
    <label className="block">
      <span className="text-xs text-tg-subtitle-text">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="mt-1 h-10 w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 text-sm text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 disabled:opacity-50 dark:border-white/15"
      />
    </label>
  );
}

/* --------------------------------------------------------- invoices --- */

const INVOICE_STATUSES = ['', 'pending', 'submitted', 'confirming', 'confirmed', 'expired', 'failed'] as const;

function InvoicesSection({
  t,
}: {
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const [status, setStatus] = useState<string>('');
  const invoicesQuery = useQuery({
    queryKey: qk.crypto.adminInvoices(status, 0),
    queryFn: () =>
      adminCryptoApi.listInvoices({ ...(status ? { status } : {}), limit: 50 }),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  return (
    <Card padding="md" className="fade-up">
      <p className="text-xs uppercase tracking-wider text-tg-hint">
        {t('admin_crypto.section.invoices')}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {INVOICE_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={[
              'rounded-full px-3 py-1 text-xs font-medium',
              status === s
                ? 'bg-tg-button text-tg-button-text'
                : 'bg-tg-secondary-bg text-tg-subtitle-text',
            ].join(' ')}
          >
            {s || 'all'}
          </button>
        ))}
      </div>
      {invoicesQuery.isLoading ? (
        <div className="mt-3">
          <SkeletonList rows={3} />
        </div>
      ) : invoicesQuery.isError || !invoicesQuery.data ? (
        <ErrorState
          message={String(invoicesQuery.error)}
          onRetry={() => invoicesQuery.refetch()}
        />
      ) : invoicesQuery.data.length === 0 ? (
        <p className="mt-3 text-sm text-tg-subtitle-text">No invoices.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {invoicesQuery.data.map((inv) => (
            <InvoiceRow key={inv.id} invoice={inv} t={t} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function InvoiceRow({
  invoice,
  t,
}: {
  invoice: AdminCryptoInvoice;
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const { isFounder } = useAuth();
  const qc = useQueryClient();
  const [hashInput, setHashInput] = useState('');
  const [extendInput, setExtendInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'crypto' });

  const recheckMutation = useMutation({
    mutationFn: () => adminCryptoApi.recheck(invoice.id),
    onSuccess: () => {
      hapticNotify('success');
      invalidate();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });
  const attachMutation = useMutation({
    mutationFn: () => adminCryptoApi.attach(invoice.id, hashInput),
    onSuccess: () => {
      hapticNotify('success');
      setHashInput('');
      invalidate();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });
  const forceMutation = useMutation({
    mutationFn: () => adminCryptoApi.forceApply(invoice.id),
    onSuccess: () => {
      hapticNotify('success');
      invalidate();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });
  const extendMutation = useMutation({
    mutationFn: () => {
      const m = Number.parseInt(extendInput, 10);
      if (!Number.isInteger(m) || m < 1) {
        throw new ApiError(0, 'invalid_input', 'minutes must be > 0');
      }
      return adminCryptoApi.extend(invoice.id, m);
    },
    onSuccess: () => {
      hapticNotify('success');
      setExtendInput('');
      invalidate();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <li className="rounded-2xl border border-black/5 p-3 dark:border-white/10">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-tg-text">#{invoice.id}</span>
        <span className="rounded-full bg-tg-secondary-bg px-2 py-0.5 text-tg-subtitle-text">
          {invoice.status}
        </span>
      </div>
      <p className="mt-1 text-sm text-tg-text">
        {invoice.amount_label} → +{invoice.credits_to_grant}
      </p>
      <p className="text-xs text-tg-subtitle-text">
        chain: {invoice.chain} · user: {invoice.user_id} · conf:{' '}
        {invoice.confirmations}/{invoice.required_confirmations}
      </p>
      {invoice.tx_hash && (
        <p className="mt-1 break-all font-mono text-[10px] text-tg-subtitle-text">
          {invoice.tx_hash}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-tg-destructive-text">{error}</p>}

      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="secondary"
          loading={recheckMutation.isPending}
          onClick={() => recheckMutation.mutate()}
        >
          {t('admin_crypto.invoice.action.recheck')}
        </Button>
        {isFounder && (
          <Button
            size="sm"
            variant="ghost"
            loading={forceMutation.isPending}
            disabled={!invoice.tx_hash || invoice.status === 'confirmed'}
            onClick={() => forceMutation.mutate()}
          >
            {t('admin_crypto.invoice.action.force')}
          </Button>
        )}
      </div>

      {isFounder && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <input
              type="text"
              value={hashInput}
              onChange={(e) => setHashInput(e.target.value.trim())}
              placeholder={t('admin_crypto.invoice.attach.placeholder')}
              className="h-9 w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 font-mono text-xs text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 dark:border-white/15"
            />
            <Button
              size="sm"
              variant="ghost"
              className="mt-1"
              loading={attachMutation.isPending}
              disabled={hashInput.length < 32}
              onClick={() => attachMutation.mutate()}
            >
              {t('admin_crypto.invoice.action.attach')}
            </Button>
          </div>
          <div>
            <input
              type="number"
              value={extendInput}
              onChange={(e) => setExtendInput(e.target.value)}
              placeholder={t('admin_crypto.invoice.extend.placeholder')}
              className="h-9 w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 text-xs text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 dark:border-white/15"
            />
            <Button
              size="sm"
              variant="ghost"
              className="mt-1"
              loading={extendMutation.isPending}
              disabled={extendInput.length === 0}
              onClick={() => extendMutation.mutate()}
            >
              {t('admin_crypto.invoice.action.extend')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
