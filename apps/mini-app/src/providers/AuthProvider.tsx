/**
 * VaultLink Mini App — AuthProvider.
 *
 * Calls `/me` once on mount and exposes the result to the rest of the
 * tree. If the page is being rendered outside Telegram (no initData),
 * we short-circuit to `error: 'no_telegram'` without ever hitting the
 * network — the OutsideTelegramScreen renders instead of the app shell.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiGet } from '../lib/api.js';
import { isInsideTelegram } from '../lib/telegram.js';
import type { MeResponse, MeUser } from '../types/api.js';

interface AuthState {
  user: MeUser | null;
  isAdmin: boolean;
  /** Strict — true only when the caller is in env ADMIN_IDS. Founders are
   * the only tier that can promote / demote super admins, so the UI uses
   * this flag to gate the role-change buttons. */
  isFounder: boolean;
  loading: boolean;
  /** `'no_telegram'` when initData is missing, otherwise the API's error code. */
  error: string | null;
  refresh: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

interface Props {
  children: ReactNode;
}

export function AuthProvider({ children }: Props): JSX.Element {
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!isInsideTelegram()) {
      setUser(null);
      setLoading(false);
      setError('no_telegram');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<MeResponse>('/me')
      .then((res) => {
        if (cancelled) return;
        // Backend currently returns `MeUser` flat under `data` (see
        // settings.routes.ts). Some deployments may wrap as `{ user }`.
        // Handle both shapes defensively.
        const u = (res as unknown as { user?: MeUser }).user ?? (res as unknown as MeUser);
        setUser(u);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code =
          typeof err === 'object' && err !== null && 'code' in err
            ? String((err as { code: unknown }).code)
            : 'unknown';
        setError(code);
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      isAdmin: user?.is_admin === true,
      isFounder: user?.is_founder === true,
      loading,
      error,
      refresh,
    }),
    [user, loading, error, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
