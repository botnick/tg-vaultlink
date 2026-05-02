/**
 * VaultLink Bot — abuse report service.
 *
 * Lets users flag a file for moderator review and auto-locks files that
 * accumulate enough pending reports to cross the configured threshold. The
 * service does not enforce per-reporter rate limits itself — that lives in
 * {@link RateLimitService} — but it does collapse newlines + cap the reason
 * length so a malformed report cannot stretch the moderator UI.
 */

import type { Config } from '../config/env.js';
import type { ReportRow, FileRow, UserRow, ReportStatus } from '../types/index.js';
import type { ReportRepository } from '../repositories/report.repository.js';
import type { FileRepository } from '../repositories/file.repository.js';
import type { AuditService } from './audit.service.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { sanitizeOneLine } from '../utils/safeText.js';
import { REPORT_REASON_MAX_LENGTH } from '../config/constants.js';

export interface ReportInput {
  reporter: UserRow;
  file: FileRow;
  reason: string;
}

export interface ReportSubmitResult {
  report: ReportRow;
  /** `true` when this submission tipped the file into auto-locked status. */
  autoLocked: boolean;
}

export class ReportService {
  private readonly reports: ReportRepository;
  private readonly files: FileRepository;
  private readonly audit: AuditService;
  private readonly config: Config;

  constructor(
    reports: ReportRepository,
    files: FileRepository,
    audit: AuditService,
    config: Config,
  ) {
    this.reports = reports;
    this.files = files;
    this.audit = audit;
    this.config = config;
  }

  /**
   * File a report. Returns the persisted row plus a flag indicating whether
   * the underlying file was auto-locked as a result of this submission.
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

    const report = this.reports.insert({
      file_id: input.file.id,
      reporter_user_id: input.reporter.id,
      reason,
    });

    this.audit.log('report.submitted', {
      actorUserId: input.reporter.id,
      targetType: 'file',
      targetId: String(input.file.id),
      metadata: { report_id: report.id },
    });

    let autoLocked = false;
    if (input.file.is_locked === 0) {
      const pending = this.reports.countPendingForFile(input.file.id);
      if (pending >= this.config.AUTO_LOCK_REPORT_THRESHOLD) {
        const locked = this.files.setLocked(input.file.id, true);
        if (locked) {
          autoLocked = true;
          this.audit.log('file.auto_locked', {
            targetType: 'file',
            targetId: String(input.file.id),
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
}
