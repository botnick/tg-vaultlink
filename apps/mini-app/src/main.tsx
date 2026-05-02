/**
 * VaultLink Mini App — Vite entry.
 *
 * Responsibilities:
 *   1. Inject the font stylesheet from `VITE_FONT_PROVIDER_URL` so we
 *      can swap providers (Google Fonts, self-host, internal CDN)
 *      without touching app code.
 *   2. Mount the React tree.
 *
 * Anything that needs to run synchronously *before* the first paint
 * lives here. Everything else stays inside `<App>`.
 */

import './styles/fonts.css';
import './styles/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

function injectFonts(): void {
  if (typeof document === 'undefined') return;
  const provider = (import.meta.env.VITE_FONT_PROVIDER_URL ?? 'https://fonts.googleapis.com').replace(
    /\/+$/,
    '',
  );
  const href = `${provider}/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&family=Roboto:wght@400;500;700&display=swap`;
  // Avoid duplicate injection on HMR.
  if (document.querySelector(`link[data-vaultlink-fonts="true"]`)) return;

  const preconnect = document.createElement('link');
  preconnect.rel = 'preconnect';
  preconnect.href = provider;
  preconnect.crossOrigin = 'anonymous';
  document.head.appendChild(preconnect);

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.vaultlinkFonts = 'true';
  document.head.appendChild(link);
}

injectFonts();

const container = document.getElementById('root');
if (!container) {
  throw new Error('VaultLink Mini App: #root element missing in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
