import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VaultLink Mini App — Vite config.
// Mobile-first dev server bound to 0.0.0.0 so a tunnel (ngrok/cloudflared)
// can expose the dev URL to Telegram on a real device. The proxy folds the
// Mini App API onto the same origin so the tunnel only needs to expose 5173.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    allowedHosts: ['.ngrok-free.app', '.ngrok.io', '.trycloudflare.com', 'localhost'],
    proxy: {
      // 127.0.0.1 (not localhost) — Node's localhost resolves to ::1 first on
      // Windows, but the backend binds 0.0.0.0 (IPv4 only) → ECONNREFUSED.
      '/api': { target: 'http://127.0.0.1:8081', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:8081', changeOrigin: false },
    },
  },
  build: { sourcemap: true, target: 'es2022' },
});
