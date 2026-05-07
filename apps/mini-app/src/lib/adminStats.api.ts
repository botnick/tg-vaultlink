/**
 * Mini App admin-dashboard stats client.
 *
 * Sub-stat endpoints split from the base `/admin/stats` so the dashboard
 * can render counters quickly while richer aggregates (timeseries, group
 * breakdowns) load in parallel.
 */

import { apiGet } from './api.js';

export interface AdminStatsResponse {
  users: number;
  bots: number;
  files: number;
  activeFiles: number;
  downloads: number;
  pendingReports: number;
  bannedUsers: number;
  superAdmins: number;
  spendLockedUsers: number;
  pendingCryptoInvoices: number;
}

export interface AdminCreditsBreakdown {
  reasons: Record<
    string,
    { lifetime: number; last24h: number; last7d: number; count: number }
  >;
}

export interface AdminPaymentsStats {
  topup: {
    lifetimeCredits: number;
    lifetimeCount: number;
    last7dCredits: number;
    last7dCount: number;
  };
  refunds: {
    lifetimeCreditsClawedBack: number;
    lifetimeCount: number;
    last7dCreditsClawedBack: number;
    last7dCount: number;
  };
  series: ReadonlyArray<{ day: string; credits: number; count: number }>;
}

export interface AdminCryptoStats {
  grouped: ReadonlyArray<{ chain: string; status: string; n: number }>;
  last7dConfirmedCredits: number;
  pending: number;
  expired: number;
  failed: number;
  confirmed: number;
}

export interface AdminRecentActivity {
  items: ReadonlyArray<{
    id: number;
    action: string;
    target_type: string | null;
    target_id: string | null;
    actor_user_id: number | null;
    actor: { username: string | null; first_name: string | null } | null;
    created_at: string;
  }>;
}

export const adminStatsApi = {
  /** Top-level dashboard counters (extended to include health tiles). */
  base: () => apiGet<AdminStatsResponse>('/admin/stats'),
  /** Aggregates by `credit_transactions.reason`. */
  credits: () => apiGet<AdminCreditsBreakdown>('/admin/stats/credits'),
  /** Stars top-up funnel + 7-day timeseries. */
  payments: () => apiGet<AdminPaymentsStats>('/admin/stats/payments'),
  /** Crypto invoice mix + last-7d confirmed credits. */
  crypto: () => apiGet<AdminCryptoStats>('/admin/stats/crypto'),
  /** Last 20 audit log rows for the recent-activity card. */
  recent: (limit = 20) =>
    apiGet<AdminRecentActivity>(`/admin/stats/recent?limit=${limit}`),
};
