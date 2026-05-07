/**
 * VaultLink Bot — abuse report service.
 *
 * Lets users flag a file or a collection for moderator review and auto-locks
 * the target once it accumulates enough pending reports to cross the
 * configured threshold. The service does not enforce per-reporter rate
 * limits itself — that lives in {@link RateLimitService} — but it does
 * collapse newlines + cap the reason length so a malformed report cannot
 * stretch the moderator UI.
 *
 * Targets are polymorphic: callers pass either a `FileRow` or a
 * `CollectionRow` and the service routes the auto-lock action to the
 * matching repository.
 */

import type { Config } from '../config/env.js';
import type {
  ReportRow,
  FileRow,
  CollectionRow,
  UserRow,
  ReportStatus,
  ReportTargetType,
  ReportReasonCategory,
} from '../types/index.js';
import type { ReportRepository } from '../repositories/report.repository.js';
import type { FileRepository } from '../repositories/file.repository.js';
import type { CollectionRepository } from '../repositories/collection.repository.js';
import type { AuditService } from './audit.service.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { sanitizeOneLine } from '../utils/safeText.js';
import {
  REPORT_REASON_MAX_LENGTH,
  normalizeReportReasonCategory,
} from '../config/constants.js';

export type ReportTarget =
  | { type: 'file'; file: FileRow }
  | { type: 'collection'; collection: CollectionRow };

export interface ReportInput {
  reporter: UserRow;
  target: ReportTarget;
  reason: string;
  /** Optional category. Unknown/missing values normalize to `'other'`. */
  reason_category?: ReportReasonCategory | string | null;
}

export interface ReportSubmitResult {
  report: ReportRow;
  /** `true` when this submission tipped the underlying target into auto-locked status. */
  autoLocked: boolean;
}

export class ReportService {
  private readonly reports: ReportRepository;
  private readonly files: FileRepository;
  private readonly collections: CollectionRepository;
  private readonly audit: AuditService;
  private readonly config: Config;

  constructor(
    reports: ReportRepository,
    files: FileRepository,
    collections: CollectionRepository,
    audit: AuditService,
    config: Config,
  ) {
    this.reports = reports;
    this.files = files;
    this.collections = collections;
    this.audit = audit;
    this.config = config;
  }

  /**
   * File a report. Returns the persisted row plus a flag indicating whether
   * the underlying target was auto-locked as a result of this submission.
   */
  submit(input: ReportInput): ReportSubmitResult {
    if (!this.config.ENABLE_REPORTS) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'reports are disabled', {
        expose: true,
      });
    }

    const reason = sanitizeOneLine(input.reason, REPORT_REASON_MAX_LENGTH);
    if (reason.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'a reason is required', {
        expose: true,
      });
    }

    // Categories validate at the application layer (no DB CHECK constraint
    // — see migration 010), so the normalizer here is the only gate.
    const reason_category = normalizeReportReasonCategory(input.reason_category);

    const { type: targetType, id: targetId, isLocked } = describeTarget(input.target);

    const report = this.reports.insert({
      target_type: targetType,
      target_id: targetId,
      reporter_user_id: input.reporter.id,
      reason,
      reason_category,
    });

    this.audit.log('report.submitted', {
      actorUserId: input.reporter.id,
      targetType,
      targetId: String(targetId),
      metadata: { report_id: report.id, reason_category },
    });

    let autoLocked = false;
    if (!isLocked) {
      const pending = this.reports.countPendingForTarget(targetType, targetId);
      if (pending >= this.config.AUTO_LOCK_REPORT_THRESHOLD) {
        const locked = this.lockTarget(targetType, targetId);
        if (locked) {
          autoLocked = true;
          this.audit.log(`${targetType}.auto_locked`, {
            targetType,
            targetId: String(targetId),
            metadata: {
              pending_reports: pending,
              threshold: this.config.AUTO_LOCK_REPORT_THRESHOLD,
            },
          });
        }
      }
    }

    return { report, autoLocked };
  }

  listPending(limit: number, offset: number): ReportRow[] {
    return this.reports.listPending(limit, offset);
  }

  /**
   * Pending reports against files OR collections on the given bot ids.
   * Returns `[]` if no ids are supplied. Used by `/admin_reports` to scope a
   * bot owner's inbox to their own bots — the caller is expected to have
   * already resolved the owner's bot list and passed it in.
   */
  listPendingForBots(botIds: number[], limit: number, offset: number): ReportRow[] {
    return this.reports.listPendingForBots(botIds, limit, offset);
  }

  /** Pending-report count scoped to the given bot ids. */
  countPendingForBots(botIds: number[]): number {
    return this.reports.countPendingForBots(botIds);
  }

  /**
   * Update the status of a report (typically `pending` → `reviewed`/
   * `dismissed`). The acting user is captured in the audit log.
   */
  setStatus(report: ReportRow, status: ReportStatus, actor: UserRow): ReportRow {
    const updated = this.reports.setStatus(report.id, status);
    if (!updated) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'report disappeared during update');
    }
    this.audit.log('report.status_changed', {
      actorUserId: actor.id,
      targetType: 'report',
      targetId: String(report.id),
      metadata: { status },
    });
    return updated;
  }

  countPending(): number {
    return this.reports.countByStatus('pending');
  }

  /** Lookup a single report row by id. Returns `undefined` for unknown ids. */
  findById(id: number): ReportRow | undefined {
    return this.reports.findById(id);
  }

  /**
   * Reporter-side history. Status filter is optional; `null` returns every
   * status. Result is newest-first to match the Mini App's My Reports page.
   */
  listByReporter(
    reporter: UserRow,
    status: ReportStatus | null,
    limit: number,
    offset: number,
  ): ReportRow[] {
    return this.reports.listByReporter(reporter.id, status, limit, offset);
  }

  countByReporter(reporter: UserRow, status: ReportStatus | null): number {
    return this.reports.countByReporter(reporter.id, status);
  }

  countOtherForTarget(report: ReportRow): number {
    return this.reports.countOtherForTarget(report.target_type, report.target_id, report.id);
  }

  /**
   * Reporter withdraws their own report. Only allowed while the row is
   * still `pending` — once a moderator has acted on it the audit trail is
   * preserved. Returns `true` if a row was deleted.
   */
  withdraw(report: ReportRow, actor: UserRow): boolean {
    if (report.reporter_user_id !== actor.id) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'not your report', { expose: true });
    }
    if (report.status !== 'pending') {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'only pending reports can be withdrawn',
        { expose: true },
      );
    }
    this.reports.deleteById(report.id);
    this.audit.log('report.withdrawn', {
      actorUserId: actor.id,
      targetType: 'report',
      targetId: String(report.id),
    });
    return true;
  }

  private lockTarget(type: ReportTargetType, id: number): boolean {
    if (type === 'file') {
      return this.files.setLocked(id, true) !== undefined;
    }
    return this.collections.setLocked(id, true) !== undefined;
  }
}

function describeTarget(target: ReportTarget): {
  type: ReportTargetType;
  id: number;
  isLocked: boolean;
} {
  if (target.type === 'file') {
    return { type: 'file', id: target.file.id, isLocked: target.file.is_locked === 1 };
  }
  return {
    type: 'collection',
    id: target.collection.id,
    isLocked: target.collection.is_locked === 1,
  };
}
