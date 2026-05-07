/**
 * Mini App — typed clients for the credit + crypto top-up API.
 *
 * Each function calls the matching backend route (see
 * `src/miniapp/routes/credits.routes.ts` and `admin_credits.routes.ts`)
 * via the shared `apiGet/Post/Patch` wrapper.
 */

import { apiGet, apiPatch, apiPost } from './api.js';

/* ------------------------------------------------------------------ types --- */

/**
 * Wave 9.3 — full chain×token matrix mirrored from `src/types/index.ts`.
 * Adding a new chain only requires extending this union (and the picker
 * filters by `network` + `token`). 'ton-native' stays in the union for
 * legacy invoices but the picker hides it via `showInPicker`.
 */
export type CryptoChainId =
  | 'tron-usdt'
  | 'tron-usdc'
  | 'bsc-usdt'
  | 'bsc-usdc'
  | 'eth-usdt'
  | 'eth-usdc'
  | 'ton-usdt-jetton'
  | 'ton-usdc-jetton'
  | 'ton-native';

/** L1/L2 bucket — what network the chain id belongs to. */
export type CryptoNetwork = 'trx' | 'bsc' | 'eth' | 'ton';
/** Token bucket — what stablecoin (or native) the chain carries. */
export type CryptoToken = 'USDT' | 'USDC' | 'native';

export interface CreditsSummary {
  enabled: boolean;
  balance: number;
  lifetime: { gained: number; spent: number };
  signupBonus: number;
  referralEnabled: boolean;
  referralReward: number;
  referralDailyCap: number;
  topupEnabled: boolean;
  packages: ReadonlyArray<{ stars: number; credits: number }>;
  cryptoEnabled: boolean;
  cryptoChainsAvailable: number;
  /**
   * Wave 9.2 — Stars refund defense. ISO timestamp; when in the future,
   * the Mini App shows a "spending temporarily restricted" banner with the
   * unlock countdown.
   */
  spendLockedUntil: string | null;
  refundCount: number;
  totalRefundedStars: number;
}

export interface CreditTxRow {
  id: number;
  user_id: number;
  delta: number;
  reason: string;
  balance_after: number;
  reference_type: string | null;
  reference_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface CreditHistoryPage {
  items: CreditTxRow[];
  next_cursor: number | null;
}

export interface CryptoChainItem {
  id: CryptoChainId;
  /** Wave 9.3 — network bucket for picker grouping (trx/bsc/eth/ton). */
  network: CryptoNetwork;
  /** Wave 9.3 — token bucket (USDT/USDC/native). */
  token: CryptoToken;
  label: string;
  enabled: boolean;
  decimals: number;
  confirmations: number;
  rate: number;
  memoSupported: boolean;
  minAmount: string;
  maxAmount: string;
  address: string | null;
  /** Whether this chain shows in the user-facing picker (legacy = false). */
  showInPicker: boolean;
  /**
   * Whether a custom RPC-provider API key is stored for this chain. Boolean
   * only — the value never crosses the wire. Used by the admin UI to render
   * a "configured / default" badge.
   */
  apiKeySet: boolean;
}

export interface CryptoChainsResponse {
  master_enabled: boolean;
  items: CryptoChainItem[];
}

export interface CryptoInvoice {
  id: number;
  chain: CryptoChainId;
  /** Wave 9.3 — network bucket denormalised for the SPA. */
  network: CryptoNetwork;
  /** Wave 9.3 — token bucket denormalised for the SPA. */
  token: CryptoToken;
  status: string;
  amount_unit: string;
  amount_decimals: number;
  amount_label: string;
  credits_to_grant: number;
  pay_to_address: string;
  memo: string | null;
  /** Wave 9.2 — server-built BIP-21 / ton:// URI; null when unsupported. */
  payment_uri: string | null;
  tx_hash: string | null;
  confirmations: number;
  required_confirmations: number;
  expires_at: string;
  paid_at: string | null;
  applied_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

/* --------------------------------------------------- Wave 9.2 — Stars + admin --- */

export interface StarsInvoiceResponse {
  invoiceLink: string;
  stars: number;
  credits: number;
  packageIndex: number;
}

export interface AdminCreditSettings {
  flags: {
    enabled: boolean;
    referralEnabled: boolean;
    topupEnabled: boolean;
    bypassForOwner: boolean;
    bypassForAdmin: boolean;
  };
  numbers: {
    signupBonus: number;
    costDecode: number;
    costCollectionOpen: number;
    costCollectionSendBase: number;
    costCollectionPerItem: number;
    referralReward: number;
    referralDailyCap: number;
    referralPairLifetimeCap: number;
    referralPairWindowMinutes: number;
    referralPairWindowMax: number;
    referralRedeemerMinAgeMinutes: number;
  };
  fileTypeOverrides: Record<string, number | null>;
  topupPackages: ReadonlyArray<{ stars: number; credits: number }>;
}

export interface AdminCryptoInvoice {
  id: number;
  user_id: number;
  chain: CryptoChainId;
  status: string;
  amount_unit: string;
  amount_decimals: number;
  amount_label: string;
  credits_to_grant: number;
  pay_to_address: string;
  memo: string | null;
  tx_hash: string | null;
  from_address: string | null;
  confirmations: number;
  required_confirmations: number;
  paid_at: string | null;
  applied_at: string | null;
  ledger_tx_id: number | null;
  expires_at: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

/* ----------------------------------------------------------- user APIs --- */

export const creditsApi = {
  summary: () => apiGet<CreditsSummary>('/credits'),
  history: (cursor = 0, limit = 30) =>
    apiGet<CreditHistoryPage>(
      `/credits/history?cursor=${cursor}&limit=${limit}`,
    ),
  /**
   * Wave 9.2 — request a Telegram Stars invoice link the Mini App can hand
   * to `Telegram.WebApp.openInvoice()`. Server resolves the package index
   * server-side (never trusts client values) and reuses the same payload
   * the bot's chat-side `sendInvoice` flow uses.
   */
  createStarsInvoice: (packageIndex: number) =>
    apiPost<StarsInvoiceResponse>('/credits/stars/invoice', { packageIndex }),
};

export const cryptoApi = {
  chains: () => apiGet<CryptoChainsResponse>('/crypto/chains'),
  createInvoice: (input: { chain: CryptoChainId; amount: string }) =>
    apiPost<CryptoInvoice>('/crypto/invoices', input),
  listInvoices: (limit = 20) =>
    apiGet<CryptoInvoice[]>(`/crypto/invoices?limit=${limit}`),
  getInvoice: (id: number) => apiGet<CryptoInvoice>(`/crypto/invoices/${id}`),
  submitTxHash: (id: number, txHash: string) =>
    apiPost<CryptoInvoice>(`/crypto/invoices/${id}/submit`, { tx_hash: txHash }),
  recheck: (id: number) =>
    apiPost<CryptoInvoice>(`/crypto/invoices/${id}/recheck`),
  /**
   * Wave 9.3 — voluntarily cancel a still-pending invoice (no on-chain
   * transfer detected yet) so the per-user concurrent-invoice cap frees a
   * slot. Refused server-side once a payment is attached.
   */
  cancel: (id: number) =>
    apiPost<CryptoInvoice>(`/crypto/invoices/${id}/cancel`),
};

/* ----------------------------------------------------------- admin APIs --- */

export interface AdminTopupRow {
  id: number;
  actor_user_id: number | null;
  user: { telegram_user_id: string; username: string | null } | null;
  credits: number | null;
  stars: number | null;
  payment_charge_id: string | null;
  created_at: string;
  refunded: boolean;
}

export const adminCreditsApi = {
  getSettings: () => apiGet<AdminCreditSettings>('/admin/credits/settings'),
  patchSetting: (input: {
    key: string;
    bool?: boolean;
    number?: number;
    clear?: boolean;
  }) => apiPatch<unknown>('/admin/credits/settings', input),
  grant: (input: {
    telegram_user_id: string;
    delta: number;
    note?: string;
  }) => apiPost<unknown>('/admin/credits/grant', input),
  setBalance: (input: {
    telegram_user_id: string;
    balance: number;
    note?: string;
  }) => apiPost<unknown>('/admin/credits/setbal', input),
  stats: () =>
    apiGet<{ totals: Record<string, number> }>('/admin/credits/stats'),
  /** Wave 9.2 — recent topups with refund state for the admin refund tab. */
  recentTopups: (limit = 50) =>
    apiGet<{ items: AdminTopupRow[] }>(`/admin/credits/topups?limit=${limit}`),
  /** Wave 9.2 — initiate a Stars refund through Telegram. Returns 202. */
  refundStars: (input: {
    telegram_user_id: string;
    payment_charge_id: string;
    note?: string;
  }) =>
    apiPost<{ requested: boolean; payment_charge_id: string }>(
      '/admin/credits/refund',
      input,
    ),
  /** Wave 9.2 — clear an active spend-lock (founder-only). */
  clearLock: (input: {
    telegram_user_id: string;
    write_off?: boolean;
    note?: string;
  }) =>
    apiPost<{
      telegram_user_id: string;
      balance_after: number;
      wrote_off: number;
    }>('/admin/credits/clear-lock', input),
};

export const adminCryptoApi = {
  patchChain: (
    id: CryptoChainId,
    input: {
      enabled?: boolean;
      address?: string;
      confirmations?: number;
      rate?: number;
      min_amount?: string;
      max_amount?: string;
    },
  ) =>
    apiPatch<unknown>(`/admin/crypto/chains/${id}`, input),
  setApiKey: (id: CryptoChainId, apiKey: string) =>
    apiPost<unknown>(`/admin/crypto/chains/${id}/api_key`, { api_key: apiKey }),
  listInvoices: (params: { status?: string; offset?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return apiGet<AdminCryptoInvoice[]>(
      `/admin/crypto/invoices${query ? `?${query}` : ''}`,
    );
  },
  recheck: (id: number) =>
    apiPost<AdminCryptoInvoice>(`/admin/crypto/invoices/${id}/recheck`),
  attach: (id: number, txHash: string, note?: string) =>
    apiPost<AdminCryptoInvoice>(`/admin/crypto/invoices/${id}/attach`, {
      tx_hash: txHash,
      ...(note ? { note } : {}),
    }),
  forceApply: (id: number, note?: string) =>
    apiPost<AdminCryptoInvoice>(
      `/admin/crypto/invoices/${id}/force`,
      note ? { note } : {},
    ),
  extend: (id: number, minutes: number) =>
    apiPost<AdminCryptoInvoice>(`/admin/crypto/invoices/${id}/extend`, { minutes }),
};
