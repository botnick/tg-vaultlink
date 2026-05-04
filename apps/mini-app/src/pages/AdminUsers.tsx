/**
 * VaultLink Mini App — Admin: every user in the system.
 *
 * Live search across `username`, first/last name, and `telegram_user_id`
 * (debounced ~250 ms so each keystroke isn't a round-trip). Founders see
 * per-row "Promote" / "Demote" buttons that flip `role` via the server-
 * gated `POST /admin/users/:id/role` endpoint. Promoted super admins
 * never see those buttons — defense-in-depth means the API would
 * reject the call anyway.
 *
 * Pills: 🔑 founder (env ADMIN_IDS), 👑 super_admin (DB role),
 * 🚫 banned. Founders cannot be demoted via this UI; they must be
 * removed from `.env ADMIN_IDS` first.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon, UsersIcon } from '../components/icons.js';
import { apiGet, apiPost } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatDate } from '../lib/format.js';
import { hapticNotify } from '../lib/telegram.js';
import { useAuth } from '../providers/AuthProvider.js';
import type { AdminUserRow, PageResponse } from '../types/api.js';

const PAGE_SIZE = 20;

function userHandle(u: AdminUserRow): string {
  if (u.username) return `@${u.username}`;
  return `#${u.id}`;
}

function userName(u: AdminUserRow): string {
  const parts = [u.first_name, u.last_name].filter((s): s is string => Boolean(s?.trim()));
  return parts.join(' ').trim();
}

/** Debounce a string value so a fast typist doesn't fire one query per
 * keystroke. Returns the value unchanged after `delayMs` of stillness. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [out, setOut] = useState<T>(value);
  useEffect(() => {
    const id = window.setTimeout(() => setOut(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return out;
}

export function AdminUsers(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const { isFounder, user: me } = useAuth();
  const qc = useQueryClient();

  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const debouncedQ = useDebounced(searchInput, 250);

  // Reset to page 0 whenever the search query changes — paging into a
  // search result that no longer matches is just stale UI.
  useEffect(() => {
    setPage(0);
  }, [debouncedQ]);

  const query = useQuery({
    queryKey: qk.admin.users(debouncedQ, page, PAGE_SIZE),
    queryFn: () => {
      const sp = new URLSearchParams();
      sp.set('limit', String(PAGE_SIZE));
      sp.set('offset', String(page * PAGE_SIZE));
      if (debouncedQ.trim().length > 0) sp.set('q', debouncedQ.trim());
      return apiGet<PageResponse<AdminUserRow>>(`/admin/users?${sp.toString()}`);
    },
  });

  const setRoleMutation = useMutation({
    mutationFn: async (vars: { userId: number; role: 'super_admin' | 'user' }) => {
      return apiPost(`/admin/users/${vars.userId}/role`, { role: vars.role });
    },
    onSuccess: () => {
      hapticNotify('success');
      // Refresh both the current page and the dashboard stats.
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <Layout title={t('admin.users.title')} back={() => navigate(-1)} hideNav>
      {/* Live search */}
      <div className="relative mb-4">
        <SearchIcon
          size={18}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tg-hint"
        />
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('admin.users.search_placeholder')}
          className="h-11 w-full rounded-2xl border border-black/10 bg-tg-secondary-bg pl-9 pr-3 text-sm text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
        />
      </div>

      {setRoleMutation.isError ? (
        <p className="mb-3 rounded-2xl bg-tg-destructive-text/10 px-3 py-2 text-xs text-tg-destructive-text">
          {setRoleMutation.error instanceof Error
            ? setRoleMutation.error.message
            : t('common.error_title')}
        </p>
      ) : null}

      {query.isLoading ? (
        <SkeletonList rows={5} lines={2} />
      ) : query.isError ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<UsersIcon size={48} />}
          title={t('admin.users.empty.title')}
          description={
            debouncedQ.trim().length > 0
              ? t('admin.users.empty.search', { q: debouncedQ.trim() })
              : t('admin.users.empty.description')
          }
        />
      ) : (
        <ul className="space-y-2 stagger">
          {items.map((u) => {
            const name = userName(u);
            const isSelf = me?.id === u.id;
            const isThisFounder = u.is_founder === true;
            const isSuper = u.role === 'super_admin';
            // Founder-only actions, never on self, never on a founder
            // (they're rooted in env). The API enforces all of this too.
            const canPromote = isFounder && !isSelf && !isSuper && !u.is_banned;
            const canDemote = isFounder && !isSelf && isSuper && !isThisFounder;
            return (
              <li key={u.id} className="animate-fade-up">
                <Card padding="md">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-tg-text">
                        {userHandle(u)}
                        {name ? <span className="text-tg-subtitle-text"> · {name}</span> : null}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-tg-subtitle-text">
                        tg #{u.telegram_user_id}
                      </p>
                      <p className="mt-0.5 text-[11px] text-tg-subtitle-text">
                        {t('admin.users.locale')}: {u.locale ?? '—'} · {t('admin.users.joined')}:{' '}
                        {formatDate(u.created_at, locale)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {isThisFounder ? (
                        <span className="rounded-full bg-gradient-to-r from-brand-amber to-brand-pink px-2 py-0.5 text-[10px] font-semibold text-white">
                          🔑 founder
                        </span>
                      ) : isSuper ? (
                        <span className="rounded-full bg-gradient-to-r from-brand-violet to-brand-fuchsia px-2 py-0.5 text-[10px] font-semibold text-white">
                          👑 super_admin
                        </span>
                      ) : (
                        <span className="rounded-full bg-tg-secondary-bg px-2 py-0.5 text-[10px] font-semibold text-tg-subtitle-text">
                          {u.role}
                        </span>
                      )}
                      {u.is_banned ? (
                        <span className="rounded-full bg-tg-destructive-text/10 px-2 py-0.5 text-[10px] font-semibold text-tg-destructive-text">
                          🚫 {t('admin.users.banned')}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {(canPromote || canDemote) && !setRoleMutation.isPending ? (
                    <div className="mt-3 flex gap-2">
                      {canPromote ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() =>
                            setRoleMutation.mutate({ userId: u.id, role: 'super_admin' })
                          }
                          disabled={setRoleMutation.isPending}
                        >
                          {t('admin.users.promote')}
                        </Button>
                      ) : null}
                      {canDemote ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setRoleMutation.mutate({ userId: u.id, role: 'user' })}
                          disabled={setRoleMutation.isPending}
                        >
                          {t('admin.users.demote')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {!query.isLoading && total > PAGE_SIZE ? (
        <div className="mt-4 flex items-center justify-between">
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            leftIcon={<ChevronLeftIcon size={16} />}
          >
            {t('common.prev')}
          </Button>
          <span className="text-xs text-tg-subtitle-text">
            {page + 1} / {lastPage + 1}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= lastPage}
            onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            rightIcon={<ChevronRightIcon size={16} />}
          >
            {t('common.next')}
          </Button>
        </div>
      ) : null}
    </Layout>
  );
}
