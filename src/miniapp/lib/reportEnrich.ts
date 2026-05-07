/**
 * VaultLink Mini App — report enrichment helpers.
 *
 * Reports are polymorphic (`target_type` ∈ {file, collection}) and the raw
 * row only carries an opaque `target_id`. Every API response that surfaces a
 * report row to the moderator UI or the reporter's own history needs to
 * resolve that id back into something a human can recognize: the file's name
 * and share code, the owner's @username, the bot it belongs to, etc.
 *
 * This module owns those lookups in one place so:
 *   - the admin queue endpoint, the per-target context endpoint, and the
 *     reporter's "My reports" all return the same shape;
 *   - per-row lookups can share a request-scoped cache to avoid N+1 queries
 *     when a single page lists 20 reports against the same file/owner/bot.
 *
 * The helpers accept an `AppRepos` directly rather than threading services,
 * because all three lookups are pure repository reads with no audit side
 * effects. Cache keys are the numeric ids; misses are stored as `null` so a
 * second lookup of an already-deleted row stays free.
 */

import type { AppRepos } from '../types.js';
import type {
  ReportRow,
  FileRow,
  CollectionRow,
  ManagedBotRow,
  UserRow,
} from '../../types/index.js';
import {
  formatShareCode,
  formatSingleFileShareCode,
} from '../../utils/shareCodeFormat.js';

/** Lightweight maps shared across the items in one paginated batch. */
export interface ReportEnrichCache {
  files: Map<number, FileRow | null>;
  collections: Map<number, CollectionRow | null>;
  users: Map<number, UserRow | null>;
  bots: Map<number, ManagedBotRow | null>;
}

export function createReportEnrichCache(): ReportEnrichCache {
  return {
    files: new Map(),
    collections: new Map(),
    users: new Map(),
    bots: new Map(),
  };
}

function getFile(repos: AppRepos, cache: ReportEnrichCache, id: number): FileRow | null {
  if (cache.files.has(id)) return cache.files.get(id) ?? null;
  const row = repos.files.findById(id) ?? null;
  cache.files.set(id, row);
  return row;
}

function getCollection(
  repos: AppRepos,
  cache: ReportEnrichCache,
  id: number,
): CollectionRow | null {
  if (cache.collections.has(id)) return cache.collections.get(id) ?? null;
  const row = repos.collections.findById(id) ?? null;
  cache.collections.set(id, row);
  return row;
}

function getUser(repos: AppRepos, cache: ReportEnrichCache, id: number): UserRow | null {
  if (cache.users.has(id)) return cache.users.get(id) ?? null;
  const row = repos.users.findById(id) ?? null;
  cache.users.set(id, row);
  return row;
}

function getBot(repos: AppRepos, cache: ReportEnrichCache, id: number): ManagedBotRow | null {
  if (cache.bots.has(id)) return cache.bots.get(id) ?? null;
  const row = repos.bots.findById(id) ?? null;
  cache.bots.set(id, row);
  return row;
}

/* -------------------------------------------------------------------------- *
 * DTO shapes — kept narrow so we never leak `password_hash` etc.
 * -------------------------------------------------------------------------- */

export interface ReportUserChip {
  id: number;
  telegram_user_id: string;
  username: string | null;
  first_name: string | null;
}

export interface ReportTargetSummary {
  kind: 'file' | 'collection';
  id: number;
  code: string;
  /** `botname:CODE…` form — the same string the user pastes back into a bot. */
  share_code: string;
  /** File-only fields, `null` for collections. */
  file_type: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  /** Collection-only fields, `null` for files. */
  title: string | null;
  total_items: number | null;
  /** Both kinds — true when the target is currently locked. */
  is_locked: boolean;
  is_deleted: boolean;
  /** Owner / bot context, both nullable for orphaned rows. */
  owner: ReportUserChip | null;
  bot: { id: number; username: string } | null;
}

export function userToChip(row: UserRow | null): ReportUserChip | null {
  if (!row) return null;
  return {
    id: row.id,
    telegram_user_id: row.telegram_user_id,
    username: row.username,
    first_name: row.first_name,
  };
}

/**
 * Build the canonical share-code display string for a report's target. Falls
 * back to the bare base code if the owning bot vanished — the same defensive
 * branch every other share-code formatter takes.
 */
export function shareCodeForTarget(
  repos: AppRepos,
  cache: ReportEnrichCache,
  report: ReportRow,
): string {
  if (report.target_type === 'file') {
    const file = getFile(repos, cache, report.target_id);
    if (!file) return '';
    const bot = getBot(repos, cache, file.bot_id);
    if (!bot) return file.code;
    return formatSingleFileShareCode(bot.username, file.code, file.file_type);
  }
  const collection = getCollection(repos, cache, report.target_id);
  if (!collection) return '';
  const bot = getBot(repos, cache, collection.bot_id);
  if (!bot) return collection.code;
  const counts = repos.collections.countItemsByType(collection.id);
  return formatShareCode(bot.username, collection.code, counts);
}

/**
 * Resolve the polymorphic target into a single summary object. Returns
 * `null` only when the target row itself is missing — orphan reports flow
 * through the moderator queue with a placeholder card.
 */
export function buildReportTargetSummary(
  repos: AppRepos,
  report: ReportRow,
  cache: ReportEnrichCache = createReportEnrichCache(),
): ReportTargetSummary | null {
  if (report.target_type === 'file') {
    const file = getFile(repos, cache, report.target_id);
    if (!file) return null;
    const bot = getBot(repos, cache, file.bot_id);
    const owner = userToChip(getUser(repos, cache, file.owner_user_id));
    return {
      kind: 'file',
      id: file.id,
      code: file.code,
      share_code: bot ? formatSingleFileShareCode(bot.username, file.code, file.file_type) : file.code,
      file_type: file.file_type,
      file_name: file.file_name,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      title: null,
      total_items: null,
      is_locked: file.is_locked === 1,
      is_deleted: file.is_deleted === 1,
      owner,
      bot: bot ? { id: bot.id, username: bot.username } : null,
    };
  }

  const collection = getCollection(repos, cache, report.target_id);
  if (!collection) return null;
  const bot = getBot(repos, cache, collection.bot_id);
  const owner = userToChip(getUser(repos, cache, collection.owner_user_id));
  const counts = repos.collections.countItemsByType(collection.id);
  return {
    kind: 'collection',
    id: collection.id,
    code: collection.code,
    share_code: bot
      ? formatShareCode(bot.username, collection.code, counts)
      : collection.code,
    file_type: null,
    file_name: null,
    mime_type: null,
    size_bytes: null,
    title: collection.title,
    total_items: collection.total_items,
    is_locked: collection.is_locked === 1,
    is_deleted: collection.is_deleted === 1,
    owner,
    bot: bot ? { id: bot.id, username: bot.username } : null,
  };
}

export function buildReporterChip(
  repos: AppRepos,
  reporterUserId: number | null,
  cache: ReportEnrichCache = createReportEnrichCache(),
): ReportUserChip | null {
  if (reporterUserId === null) return null;
  return userToChip(getUser(repos, cache, reporterUserId));
}
