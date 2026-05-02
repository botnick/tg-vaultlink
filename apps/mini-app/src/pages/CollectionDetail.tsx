/**
 * VaultLink Mini App — single collection management.
 *
 * Mirrors `FileDetail` for password / expiry / delete actions, and
 * adds collection-specific affordances:
 *   - rename + edit description (title-and-description dialog)
 *   - toggle visibility (public ↔ private)
 *   - reorder items (up/down arrows post a new ordered_ids array)
 *   - remove individual items
 *   - paginate the items section ("Load more")
 *
 * Every mutation invalidates the detail cache + the list cache so the
 * back-navigation lands on a fresh, up-to-date list.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonCard } from '../components/SkeletonCard.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { CopyButton } from '../components/CopyButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LockIcon,
  TrashIcon,
  UnlockIcon,
  fileTypeIcon,
} from '../components/icons.js';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatBytes, formatDate, relativeDays } from '../lib/format.js';
import { hapticImpact, hapticNotify, showAlert } from '../lib/telegram.js';
import type {
  CollectionDetail as CollectionDetailDto,
  CollectionItemSummary,
  FileType,
} from '../types/api.js';

const PAGE_SIZE = 20;
const BOT_USERNAME = (import.meta.env.VITE_BOT_USERNAME ?? '').replace(/^@/, '');

function buildDeepLink(code: string): string {
  if (!BOT_USERNAME) return code;
  return `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(code)}`;
}

type DialogKind =
  | 'delete'
  | 'password'
  | 'expiry'
  | 'metadata'
  | 'remove-item'
  | null;

interface DetailEnvelope {
  collection?: CollectionDetailDto;
}

/** The detail endpoint wraps the row under `collection`; older shapes may
 *  return the row directly. Accept both so the UI never blanks on a
 *  transient backend variation. */
function unwrapDetail(raw: unknown): CollectionDetailDto | null {
  if (raw === null || typeof raw !== 'object') return null;
  const env = raw as DetailEnvelope;
  if (env.collection && typeof env.collection === 'object') return env.collection;
  return raw as CollectionDetailDto;
}

function itemTypeLabel(type: FileType, t: (k: string) => string): string {
  // Falls back to the raw discriminator if no localized string exists.
  return t(`files.types.${type}`) === `files.types.${type}` ? type : t(`files.types.${type}`);
}

interface MetadataDialogProps {
  open: boolean;
  initialTitle: string;
  initialDescription: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: (title: string, description: string) => void;
}

/**
 * Two-input bottom sheet for renaming a collection. We could not reuse
 * `<ConfirmDialog>` here because that component is single-input by
 * design; collection metadata needs both title and description in one
 * round-trip to keep the UX simple.
 */
function MetadataDialog(props: MetadataDialogProps): JSX.Element | null {
  const { open, initialTitle, initialDescription, loading, onCancel, onConfirm } = props;
  const t = useT();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setDescription(initialDescription);
    }
  }, [open, initialTitle, initialDescription]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    const id = window.setTimeout(() => titleRef.current?.focus(), 80);
    return () => {
      window.removeEventListener('keydown', handler);
      window.clearTimeout(id);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const submit = (): void => {
    if (loading) return;
    onConfirm(title, description);
  };

  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') submit();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="metadata-dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div className="sheet-up w-full max-w-md rounded-t-3xl bg-tg-bg p-5 pb-[calc(1.25rem+var(--safe-bottom))] shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-tg-hint/40" aria-hidden="true" />
        <h3 id="metadata-dialog-title" className="text-base font-semibold text-tg-text">
          {t('collection_detail.metadata_dialog_title')}
        </h3>
        <label className="mt-4 block">
          <span className="text-xs uppercase tracking-wide text-tg-hint">
            {t('collection_detail.metadata_dialog_title_label')}
          </span>
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={onTitleKey}
            className="mt-1 w-full rounded-2xl border border-black/10 bg-tg-secondary-bg px-3 py-2.5 text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
          />
        </label>
        <label className="mt-3 block">
          <span className="text-xs uppercase tracking-wide text-tg-hint">
            {t('collection_detail.metadata_dialog_description_label')}
          </span>
          <textarea
            value={description}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full resize-none rounded-2xl border border-black/10 bg-tg-secondary-bg px-3 py-2.5 text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
          />
        </label>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" block onClick={onCancel} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" block loading={loading} onClick={submit}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CollectionDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const collectionId = id ?? '';
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [pendingItem, setPendingItem] = useState<CollectionItemSummary | null>(null);
  const [reorderingId, setReorderingId] = useState<number | null>(null);
  const [extraItems, setExtraItems] = useState<CollectionItemSummary[]>([]);
  const [extraPage, setExtraPage] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: qk.collections.detail(collectionId),
    queryFn: () => apiGet<unknown>(`/collections/${collectionId}`),
    enabled: collectionId.length > 0,
  });

  const collection = useMemo(
    () => (detailQuery.data ? unwrapDetail(detailQuery.data) : null),
    [detailQuery.data],
  );

  // Reset the "load more" buffer whenever the collection identity changes
  // (defensive: user could deep-link from one detail to another via back/forward).
  useEffect(() => {
    setExtraItems([]);
    setExtraPage(0);
  }, [collectionId]);

  const flashToast = (msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  const surfaceError = async (err: unknown): Promise<void> => {
    hapticNotify('error');
    const msg =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : t('common.error_description');
    await showAlert(msg);
  };

  const invalidateDetail = (): void => {
    qc.invalidateQueries({ queryKey: qk.collections.detail(collectionId) });
    qc.invalidateQueries({ queryKey: qk.collections.all });
  };

  const setDetailCache = (next: CollectionDetailDto | null | undefined): void => {
    if (!next) {
      invalidateDetail();
      return;
    }
    qc.setQueryData(qk.collections.detail(collectionId), { collection: next });
    qc.invalidateQueries({ queryKey: qk.collections.all });
  };

  // ---------------------------------------------------------------- mutations

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete<unknown>(`/collections/${collectionId}`),
    onSuccess: () => {
      hapticNotify('success');
      qc.invalidateQueries({ queryKey: qk.collections.all });
      navigate('/collections', { replace: true });
    },
    onError: (err) => void surfaceError(err),
  });

  const metadataMutation = useMutation({
    mutationFn: (vars: { title: string | null; description: string | null }) =>
      apiPatch<CollectionDetailDto | { collection: CollectionDetailDto }>(
        `/collections/${collectionId}`,
        vars,
      ),
    onSuccess: (data) => {
      hapticNotify('success');
      setDetailCache(unwrapDetail(data));
      flashToast(t('common.save'));
    },
    onError: (err) => void surfaceError(err),
  });

  const passwordSetMutation = useMutation({
    mutationFn: (password: string) =>
      apiPost<CollectionDetailDto | { collection: CollectionDetailDto }>(
        `/collections/${collectionId}/password`,
        { password },
      ),
    onSuccess: (data) => {
      hapticNotify('success');
      setDetailCache(unwrapDetail(data));
      flashToast(t('file_detail.password_set'));
    },
    onError: (err) => void surfaceError(err),
  });

  const passwordRemoveMutation = useMutation({
    mutationFn: () =>
      apiDelete<CollectionDetailDto | { collection: CollectionDetailDto }>(
        `/collections/${collectionId}/password`,
      ),
    onSuccess: (data) => {
      hapticNotify('success');
      setDetailCache(unwrapDetail(data));
      flashToast(t('file_detail.password_removed'));
    },
    onError: (err) => void surfaceError(err),
  });

  const expiryMutation = useMutation({
    mutationFn: (days: number | null) =>
      apiPost<CollectionDetailDto | { collection: CollectionDetailDto }>(
        `/collections/${collectionId}/expiry`,
        { days },
      ),
    onSuccess: (data) => {
      hapticNotify('success');
      setDetailCache(unwrapDetail(data));
      flashToast(t('file_detail.expiry_updated'));
    },
    onError: (err) => void surfaceError(err),
  });

  const visibilityMutation = useMutation({
    mutationFn: (visibility: 'public' | 'private') =>
      apiPost<CollectionDetailDto | { collection: CollectionDetailDto }>(
        `/collections/${collectionId}/visibility`,
        { visibility },
      ),
    onSuccess: (data) => {
      hapticNotify('success');
      setDetailCache(unwrapDetail(data));
    },
    onError: (err) => void surfaceError(err),
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: number[]) =>
      apiPost<unknown>(`/collections/${collectionId}/items/reorder`, {
        ordered_ids: orderedIds,
      }),
    onSuccess: () => {
      hapticImpact('light');
      invalidateDetail();
      // Drop the local "load more" buffer; the freshly-refetched detail
      // will pull the canonical first page back into view.
      setExtraItems([]);
      setExtraPage(0);
    },
    onError: (err) => void surfaceError(err),
    onSettled: () => setReorderingId(null),
  });

  const removeItemMutation = useMutation({
    mutationFn: (itemId: number) =>
      apiDelete<unknown>(`/collections/${collectionId}/items/${itemId}`),
    onSuccess: (_data, itemId) => {
      hapticNotify('success');
      // Optimistically remove from the load-more buffer; the canonical
      // refetch will replace it.
      setExtraItems((prev) => prev.filter((i) => i.id !== itemId));
      invalidateDetail();
      flashToast(t('collection_detail.remove_item'));
    },
    onError: (err) => void surfaceError(err),
    onSettled: () => {
      setPendingItem(null);
      setDialog(null);
    },
  });

  // Pulls the next page of items on demand. Run as a plain async helper
  // rather than a query because the trigger is a button press, not a
  // dependency change.
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async (): Promise<void> => {
    if (!collection) return;
    const nextPage = extraPage + 1;
    setLoadingMore(true);
    try {
      const res = await apiGet<{ items: CollectionItemSummary[]; total: number }>(
        `/collections/${collectionId}/items?limit=${PAGE_SIZE}&offset=${nextPage * PAGE_SIZE}`,
      );
      setExtraItems((prev) => [...prev, ...res.items]);
      setExtraPage(nextPage);
    } catch (err) {
      await surfaceError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const back = (): void => navigate(-1);

  // ---------------------------------------------------------------- derived view state

  const allItems: CollectionItemSummary[] = useMemo(() => {
    if (!collection) return [];
    return [...collection.items, ...extraItems];
  }, [collection, extraItems]);

  const totalItems = collection?.total_items ?? allItems.length;
  const canLoadMore = totalItems > allItems.length;

  const moveItem = (item: CollectionItemSummary, direction: -1 | 1): void => {
    const ordered = allItems.map((i) => i.id);
    const index = ordered.indexOf(item.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    // `noUncheckedIndexedAccess` widens index access to `T | undefined`,
    // so a destructuring swap trips the typechecker. Pull both ids into
    // locals first — we already bounds-checked above.
    const a = ordered[index] as number;
    const b = ordered[target] as number;
    ordered[index] = b;
    ordered[target] = a;
    setReorderingId(item.id);
    reorderMutation.mutate(ordered);
  };

  const countsEntries = collection
    ? (Object.entries(collection.counts_by_type) as [FileType, number][]).filter(
        ([, n]) => n > 0,
      )
    : [];

  return (
    <Layout title={t('collection_detail.title')} back={back} hideNav>
      {detailQuery.isLoading ? (
        <div className="space-y-3">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={2} />
        </div>
      ) : detailQuery.isError || !collection ? (
        <ErrorState
          {...(detailQuery.error instanceof Error ? { message: detailQuery.error.message } : {})}
          onRetry={() => detailQuery.refetch()}
        />
      ) : (
        <div className="space-y-4">
          <Card padding="md" className="fade-up">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-tg-secondary-bg text-tg-link">
                {fileTypeIcon('document', 26)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-base font-semibold text-tg-text">
                    {collection.title?.trim()
                      ? collection.title
                      : t('collections.untitled')}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      hapticImpact('light');
                      setDialog('metadata');
                    }}
                    className="press-scale shrink-0 rounded-full bg-tg-secondary-bg px-3 py-1 text-xs font-medium text-tg-link"
                  >
                    {t('collection_detail.edit_metadata')}
                  </button>
                </div>
                <p className="mt-1 text-sm text-tg-subtitle-text">
                  {collection.description?.trim()
                    ? collection.description
                    : t('collection_detail.description_placeholder')}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {collection.has_password ? (
                    <StatusBadge tone="info" icon={<LockIcon size={12} />}>
                      {t('collections.has_password')}
                    </StatusBadge>
                  ) : null}
                  {collection.is_locked ? (
                    <StatusBadge tone="danger">{t('collections.locked')}</StatusBadge>
                  ) : null}
                  <StatusBadge tone="neutral">
                    {collection.visibility === 'public'
                      ? t('collections.public')
                      : t('collections.private')}
                  </StatusBadge>
                  <StatusBadge tone="neutral">
                    {collection.expires_at
                      ? `${t('files.expires_at')} · ${relativeDays(collection.expires_at, locale)}`
                      : t('files.no_expiry')}
                  </StatusBadge>
                  <StatusBadge tone="neutral">
                    {totalItems} {t('collections.items_count')}
                  </StatusBadge>
                </div>
              </div>
            </div>
          </Card>

          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">
              {t('file_detail.share_code')}
            </p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <code className="truncate font-mono text-sm text-tg-text">{collection.code}</code>
              <CopyButton value={collection.code} label={t('collection_detail.copy_code')} />
            </div>
            <div className="mt-4">
              <p className="text-xs uppercase tracking-wider text-tg-hint">
                {t('file_detail.deep_link')}
              </p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <code className="truncate font-mono text-xs text-tg-link">
                  {buildDeepLink(collection.code)}
                </code>
                <CopyButton
                  value={buildDeepLink(collection.code)}
                  label={t('collection_detail.copy_link')}
                />
              </div>
            </div>
            {collection.expires_at ? (
              <p className="mt-4 text-xs text-tg-subtitle-text">
                {t('files.expires_at')}: {formatDate(collection.expires_at, locale)}
              </p>
            ) : null}
          </Card>

          {countsEntries.length > 0 ? (
            <Card padding="md" className="fade-up">
              <p className="text-xs uppercase tracking-wider text-tg-hint">
                {t('collection_detail.counts_by_type')}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {countsEntries.map(([type, count]) => (
                  <StatusBadge key={type} tone="neutral">
                    {itemTypeLabel(type, t)} · {count}
                  </StatusBadge>
                ))}
              </div>
            </Card>
          ) : null}

          <Card padding="md" className="fade-up">
            <div className="grid grid-cols-1 gap-2">
              {collection.has_password ? (
                <Button
                  variant="secondary"
                  block
                  leftIcon={<UnlockIcon size={18} />}
                  loading={passwordRemoveMutation.isPending}
                  onClick={() => passwordRemoveMutation.mutate()}
                >
                  {t('collection_detail.remove_password')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  block
                  leftIcon={<LockIcon size={18} />}
                  onClick={() => setDialog('password')}
                >
                  {t('collection_detail.set_password')}
                </Button>
              )}
              <Button variant="secondary" block onClick={() => setDialog('expiry')}>
                {t('collection_detail.set_expiry')}
              </Button>
              <Button
                variant="secondary"
                block
                loading={visibilityMutation.isPending}
                onClick={() =>
                  visibilityMutation.mutate(
                    collection.visibility === 'public' ? 'private' : 'public',
                  )
                }
              >
                {t('collection_detail.toggle_visibility')} ·{' '}
                {collection.visibility === 'public'
                  ? t('collection_detail.visibility_private')
                  : t('collection_detail.visibility_public')}
              </Button>
              <Button
                variant="destructive"
                block
                leftIcon={<TrashIcon size={18} />}
                onClick={() => setDialog('delete')}
              >
                {t('collection_detail.delete')}
              </Button>
            </div>
          </Card>

          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">
              {t('collection_detail.items_section')}
            </p>
            {allItems.length === 0 ? (
              <p className="mt-3 text-sm text-tg-subtitle-text">
                {t('collection_detail.no_items')}
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {allItems.map((item, idx) => {
                  const label = item.file_name?.trim()
                    ? item.file_name
                    : `${itemTypeLabel(item.file_type, t)} item`;
                  const isFirst = idx === 0;
                  const isLast = idx === allItems.length - 1;
                  const busy = reorderingId === item.id || reorderMutation.isPending;
                  return (
                    <li
                      key={item.id}
                      className="flex items-start gap-3 rounded-2xl bg-tg-secondary-bg p-3"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-tg-section-bg text-tg-link">
                        {fileTypeIcon(item.file_type, 18)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-tg-text">{label}</p>
                        <p className="mt-0.5 truncate text-xs text-tg-subtitle-text">
                          #{idx + 1} · {formatBytes(item.size_bytes)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={t('collection_detail.move_up')}
                          disabled={isFirst || busy}
                          onClick={() => {
                            hapticImpact('light');
                            moveItem(item, -1);
                          }}
                          className="press-scale inline-flex h-8 w-8 items-center justify-center rounded-full bg-tg-section-bg text-tg-link disabled:opacity-40"
                        >
                          <ChevronLeftIcon size={16} style={{ transform: 'rotate(90deg)' }} />
                        </button>
                        <button
                          type="button"
                          aria-label={t('collection_detail.move_down')}
                          disabled={isLast || busy}
                          onClick={() => {
                            hapticImpact('light');
                            moveItem(item, 1);
                          }}
                          className="press-scale inline-flex h-8 w-8 items-center justify-center rounded-full bg-tg-section-bg text-tg-link disabled:opacity-40"
                        >
                          <ChevronRightIcon size={16} style={{ transform: 'rotate(90deg)' }} />
                        </button>
                        <button
                          type="button"
                          aria-label={t('collection_detail.remove_item')}
                          disabled={removeItemMutation.isPending}
                          onClick={() => {
                            hapticImpact('light');
                            setPendingItem(item);
                            setDialog('remove-item');
                          }}
                          className="press-scale inline-flex h-8 w-8 items-center justify-center rounded-full bg-tg-section-bg text-tg-destructive-text disabled:opacity-40"
                        >
                          <TrashIcon size={16} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {canLoadMore ? (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {t('collection_detail.load_more')}
                </Button>
              </div>
            ) : null}
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={dialog === 'delete'}
        title={t('collection_detail.delete_confirm_title')}
        message={t('collection_detail.delete_confirm_message')}
        confirmLabel={t('common.delete')}
        destructive
        loading={deleteMutation.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => deleteMutation.mutate()}
      />
      <ConfirmDialog
        open={dialog === 'password'}
        title={t('collection_detail.password_dialog_title')}
        inputLabel={t('collection_detail.password_dialog_label')}
        inputType="password"
        confirmLabel={t('common.save')}
        loading={passwordSetMutation.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={(value) => {
          if (!value) return;
          passwordSetMutation.mutate(value, {
            onSettled: () => setDialog(null),
          });
        }}
      />
      <ConfirmDialog
        open={dialog === 'expiry'}
        title={t('collection_detail.expiry_dialog_title')}
        inputLabel={t('collection_detail.expiry_dialog_label')}
        inputType="number"
        inputPlaceholder="0"
        confirmLabel={t('common.save')}
        loading={expiryMutation.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={(value) => {
          const raw = (value ?? '').trim();
          if (raw !== '' && !Number.isFinite(Number(raw))) return;
          const days = raw === '' ? null : Math.max(0, Math.floor(Number(raw)));
          expiryMutation.mutate(days, { onSettled: () => setDialog(null) });
        }}
      />
      <ConfirmDialog
        open={dialog === 'remove-item' && pendingItem !== null}
        title={t('collection_detail.remove_item')}
        message={t('collection_detail.remove_item_confirm')}
        confirmLabel={t('common.delete')}
        destructive
        loading={removeItemMutation.isPending}
        onCancel={() => {
          setPendingItem(null);
          setDialog(null);
        }}
        onConfirm={() => {
          if (pendingItem) removeItemMutation.mutate(pendingItem.id);
        }}
      />
      <MetadataDialog
        open={dialog === 'metadata'}
        initialTitle={collection?.title ?? ''}
        initialDescription={collection?.description ?? ''}
        loading={metadataMutation.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={(title, description) => {
          metadataMutation.mutate(
            {
              title: title.trim() === '' ? null : title.trim(),
              description: description.trim() === '' ? null : description.trim(),
            },
            { onSettled: () => setDialog(null) },
          );
        }}
      />

      {toast ? (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center"
          aria-live="polite"
        >
          <div className="fade-up rounded-full bg-tg-section-bg px-4 py-2 text-sm shadow-md">
            {toast}
          </div>
        </div>
      ) : null}
    </Layout>
  );
}
