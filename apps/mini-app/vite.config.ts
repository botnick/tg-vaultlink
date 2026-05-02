import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VaultLink Mini App — Vite config.
// Mobile-first dev server bound to 0.0.0.0 so a tunnel (ngrok/cloudflared)
// can expose the dev URL to Telegram on a real device.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
  build: { sourcemap: true, target: 'es2022' },
});
