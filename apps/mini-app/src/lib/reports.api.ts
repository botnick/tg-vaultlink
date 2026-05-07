/**
 * VaultLink Mini App — typed wrappers for the report endpoints.
 *
 * One module per resource keeps the page components free of stringly-typed
 * URL constants and centralizes invalidation keys. The shape of each
 * function mirrors the response envelope the backend hands back so React
 * Query can consume the result directly without further unwrapping.
 */

import { apiDelete, apiGet, apiPatch, apiPost } from './api.js';
import type {
  AdminReportsPage,
  MyReportRow,
  PageResponse,
  ReportReasonCategory,
  ReportRow,
  ReportStatus,
  ReportTargetType,
} from '../types/api.js';

/* -------------------------------------------------------------------------- *
 * Reporter — submit + own history.
 * -------------------------------------------------------------------------- */

export function submitReport(input: {
  target_type: ReportTargetType;
  target_id: number;
  reason: string;
  reason_category: ReportReasonCategory;
}): Promise<{
  report: { id: number; status: ReportStatus; reason_category: ReportReasonCategory; created_at: string };
  autoLocked: boolean;
}> {
  return apiPost('/reports', input);
}

export function listMyReports(
  status: ReportStatus | null,
  page: number,
  pageSize: number,
): Promise<PageResponse<MyReportRow>> {
  const params = new URLSearchParams();
  if (status !== null) params.set('status', status);
  params.set('limit', String(pageSize));
  params.set('offset', String(page * pageSize));
  return apiGet(`/reports/mine?${params.toString()}`);
}

export function getMyReportsCount(): Promise<{ pending: number; total: number }> {
  return apiGet('/reports/mine/count');
}

export function withdrawMyReport(id: number): Promise<{ ok: true }> {
  return apiDelete(`/reports/mine/${id}`);
}

/* -------------------------------------------------------------------------- *
 * Admin — moderator queue.
 * -------------------------------------------------------------------------- */

export function listAdminReports(
  status: ReportStatus,
  page: number,
  pageSize: number,
): Promise<AdminReportsPage> {
  const params = new URLSearchParams({
    status,
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  return apiGet(`/admin/reports?${params.toString()}`);
}

export function getAdminReport(id: number): Promise<ReportRow> {
  return apiGet(`/admin/reports/${id}`);
}

export function setReportStatus(id: number, status: 'reviewed' | 'dismissed'): Promise<ReportRow> {
  return apiPatch(`/admin/reports/${id}`, { status });
}

export function bulkSetReportStatus(
  ids: number[],
  status: 'reviewed' | 'dismissed',
): Promise<{ updated: number; skipped: number; status: 'reviewed' | 'dismissed' }> {
  return apiPost('/admin/reports/bulk', { ids, status });
}

export function lockReportTarget(id: number): Promise<ReportRow> {
  return apiPost(`/admin/reports/${id}/lock`);
}

export function unlockReportTarget(id: number): Promise<ReportRow> {
  return apiDelete(`/admin/reports/${id}/lock`);
}

export function deleteReportTarget(id: number): Promise<{ ok: true }> {
  return apiDelete(`/admin/reports/${id}/target`);
}

export function banReportOwner(
  id: number,
  reason: string | null,
): Promise<{ id: number; telegram_user_id: string; is_banned: boolean }> {
  return apiPost(`/admin/reports/${id}/ban-owner`, reason !== null ? { reason } : undefined);
}

export function banReporter(
  id: number,
  reason: string | null,
): Promise<{ id: number; telegram_user_id: string; is_banned: boolean }> {
  return apiPost(`/admin/reports/${id}/ban-reporter`, reason !== null ? { reason } : undefined);
}

export function sendReportPreviewToMe(id: number): Promise<{ ok: true; sent_count: number }> {
  return apiPost(`/admin/reports/${id}/send-to-me`);
}
