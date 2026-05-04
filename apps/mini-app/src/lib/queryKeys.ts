/**
 * VaultLink Mini App — React Query key factories.
 *
 * Centralizing these makes invalidation safe (everything that touches
 * a file or bot can call `qk.files.all` / `qk.bots.all`) and keeps
 * key shapes consistent so devtools stay readable.
 */

export const qk = {
  me: ['me'] as const,
  settings: ['settings'] as const,

  files: {
    all: ['files'] as const,
    list: (page: number, pageSize: number) => ['files', 'list', page, pageSize] as const,
    detail: (id: number | string) => ['files', 'detail', String(id)] as const,
  },

  bots: {
    all: ['bots'] as const,
    list: (page: number, pageSize: number) => ['bots', 'list', page, pageSize] as const,
    detail: (id: number | string) => ['bots', 'detail', String(id)] as const,
  },

  collections: {
    all: ['collections'] as const,
    list: (page: number, pageSize: number) => ['collections', 'list', page, pageSize] as const,
    detail: (id: number | string) => ['collections', 'detail', String(id)] as const,
    items: (id: number | string, page: number, pageSize: number) =>
      ['collections', 'items', String(id), page, pageSize] as const,
  },

  admin: {
    all: ['admin'] as const,
    stats: ['admin', 'stats'] as const,
    reports: (status: string, page: number, pageSize: number) =>
      ['admin', 'reports', status, page, pageSize] as const,
    audit: (filters: { actorUserId?: string; action?: string }, page: number, pageSize: number) =>
      ['admin', 'audit', filters.actorUserId ?? '', filters.action ?? '', page, pageSize] as const,
    bots: (page: number, pageSize: number) => ['admin', 'bots', page, pageSize] as const,
    files: (page: number, pageSize: number) => ['admin', 'files', page, pageSize] as const,
    users: (q: string, page: number, pageSize: number) =>
      ['admin', 'users', q, page, pageSize] as const,
  },
} as const;
