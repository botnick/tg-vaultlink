/**
 * VaultLink Mini App — root component.
 *
 * Order of providers:
 *   QueryClientProvider  → server cache for the whole tree
 *     ThemeProvider      → reads Telegram themeParams, sets CSS vars
 *       AuthProvider     → calls /me, owns the outside-Telegram guard
 *         AppShell       → resolves locale + i18n, then the router
 *
 * Splitting `AppShell` out lets us keep the locale derived from `/me`
 * without pulling auth state up through the i18n provider.
 */

import { useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ThemeProvider } from './providers/ThemeProvider.js';
import { AuthProvider, useAuth } from './providers/AuthProvider.js';
import { I18nProvider, coerceLocale } from './providers/I18nProvider.js';
import { OutsideTelegramScreen } from './components/OutsideTelegramScreen.js';
import { Home } from './pages/Home.js';
import { MyFiles } from './pages/MyFiles.js';
import { FileDetailPage } from './pages/FileDetail.js';
import { MyBots } from './pages/MyBots.js';
import { BotDetailPage } from './pages/BotDetail.js';
import { MyCollections } from './pages/MyCollections.js';
import { CollectionDetail as CollectionDetailPage } from './pages/CollectionDetail.js';
import { Settings } from './pages/Settings.js';
import { Credits } from './pages/Credits.js';
import { CryptoTopup } from './pages/CryptoTopup.js';
import { AdminCredits } from './pages/AdminCredits.js';
import { AdminCrypto } from './pages/AdminCrypto.js';
import { AdminDashboard } from './pages/AdminDashboard.js';
import { AdminFiles } from './pages/AdminFiles.js';
import { AdminUsers } from './pages/AdminUsers.js';
import { Reports } from './pages/Reports.js';
import { MyReports } from './pages/MyReports.js';
import { AuditLogs } from './pages/AuditLogs.js';
import { Broadcasts } from './pages/Broadcasts.js';
import { BroadcastComposer } from './pages/BroadcastComposer.js';
import { BroadcastDetail } from './pages/BroadcastDetail.js';
import { NotFound } from './pages/NotFound.js';
import { expandWebApp, hideBackButton, readyWebApp } from './lib/telegram.js';
import { SkeletonList } from './components/SkeletonCard.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

/** Forces the back-button to clear when navigating to a top-level route. */
function BackButtonReset(): null {
  const location = useLocation();
  useEffect(() => {
    const isDetail =
      /^\/files\/[^/]+/.test(location.pathname) ||
      /^\/bots\/[^/]+/.test(location.pathname) ||
      /^\/collections\/[^/]+/.test(location.pathname);
    if (!isDetail) hideBackButton();
  }, [location.pathname]);
  return null;
}

function RequireAdmin({ children }: { children: JSX.Element }): JSX.Element {
  const { isAdmin, loading } = useAuth();
  if (loading) return <SkeletonList rows={3} />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

function AppShell(): JSX.Element {
  const { user, loading, error } = useAuth();

  // Outside-Telegram guard: render the dedicated screen and bail out
  // before any of the protected routes mount.
  if (error === 'no_telegram') {
    return (
      <I18nProvider initialLocale="th">
        <OutsideTelegramScreen />
      </I18nProvider>
    );
  }

  if (loading) {
    return (
      <I18nProvider initialLocale="th">
        <div className="min-h-screen bg-tg-bg p-4">
          <SkeletonList rows={3} />
        </div>
      </I18nProvider>
    );
  }

  const initialLocale = coerceLocale(user?.locale, 'th');

  return (
    <I18nProvider initialLocale={initialLocale}>
      <BrowserRouter>
        <BackButtonReset />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/files" element={<MyFiles />} />
          <Route path="/files/:id" element={<FileDetailPage />} />
          <Route path="/bots" element={<MyBots />} />
          <Route path="/bots/:id" element={<BotDetailPage />} />
          <Route path="/collections" element={<MyCollections />} />
          <Route path="/collections/:id" element={<CollectionDetailPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/credits" element={<Credits />} />
          <Route path="/credits/crypto" element={<CryptoTopup />} />
          <Route path="/my-reports" element={<MyReports />} />
          <Route
            path="/admin/credits"
            element={
              <RequireAdmin>
                <AdminCredits />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/crypto"
            element={
              <RequireAdmin>
                <AdminCrypto />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminDashboard />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/reports"
            element={
              <RequireAdmin>
                <Reports />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/audit"
            element={
              <RequireAdmin>
                <AuditLogs />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/files"
            element={
              <RequireAdmin>
                <AdminFiles />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/users"
            element={
              <RequireAdmin>
                <AdminUsers />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/broadcasts"
            element={
              <RequireAdmin>
                <Broadcasts />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/broadcasts/new"
            element={
              <RequireAdmin>
                <BroadcastComposer />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/broadcasts/:id"
            element={
              <RequireAdmin>
                <BroadcastDetail />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/broadcasts/:id/edit"
            element={
              <RequireAdmin>
                <BroadcastComposer />
              </RequireAdmin>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </I18nProvider>
  );
}

export function App(): JSX.Element {
  // Tell Telegram we're ready — expands the WebApp and clears the
  // host-rendered loading shimmer.
  const readyOnce = useMemo(() => {
    let done = false;
    return (): void => {
      if (done) return;
      done = true;
      try {
        readyWebApp();
        expandWebApp();
      } catch {
        /* outside Telegram — no-op */
      }
    };
  }, []);
  useEffect(readyOnce, [readyOnce]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <AppShell />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
