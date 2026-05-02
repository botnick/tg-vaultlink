# VaultLink Mini App

Mobile-first Telegram Mini App frontend for VaultLink Bot.

## Stack

- **Vite** + **React 18** + **TypeScript** (strict)
- **Tailwind CSS** themed via Telegram WebApp `themeParams`
- **React Query** for server state
- **React Router** for navigation

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env with your local backend URL + bot username
pnpm dev
```

## Build

```bash
pnpm build
pnpm preview
```

## Environment

| Variable                 | Purpose                                                                 | Default                        |
| ------------------------ | ----------------------------------------------------------------------- | ------------------------------ |
| `VITE_API_BASE_URL`      | Path Hono backend is mounted at — relative so a single tunnel covers it | `/api/v1`                      |
| `VITE_BOT_USERNAME`      | Telegram bot username (no `@`)                                          | —                              |
| `VITE_FONT_PROVIDER_URL` | Font CSS provider                                                       | `https://fonts.googleapis.com` |
| `VITE_APP_VERSION`       | Shown on Settings → About                                               | `dev`                          |

The relative `VITE_API_BASE_URL` works because `vite.config.ts` proxies `/api` and `/healthz` to the bot's HTTP server on `127.0.0.1:8081` in dev. In production behind a reverse proxy, the same proxy rule keeps the API on the same origin as the SPA — no CORS, no mixed content. Vite's `server.allowedHosts` already whitelists `.ngrok-free.app`, `.ngrok.io`, and `.trycloudflare.com`; add your own host there if you tunnel through a different provider.

## Telegram-only

The app guards against being opened outside Telegram. If `window.Telegram.WebApp` is missing or `initData` is empty, an "open in Telegram" guard screen renders with a deep-link CTA.

To preview locally on a real device:

1. Start the bot first (`pnpm dev` from the repo root) so the Mini App API is up on `127.0.0.1:8081`. Make sure `ENABLE_MINI_APP=true` in the root `.env`.
2. In a second terminal, start the frontend: `pnpm dev` from this directory (Vite on `:5173`).
3. Tunnel the dev server: `ngrok http 5173` or `cloudflared tunnel --url http://localhost:5173`. Copy the `https://...` URL.
4. Update the root `.env` so the backend trusts the tunnel:
   ```env
   ENABLE_MINI_APP=true
   MINI_APP_URL=https://<tunnel-host>
   MINI_APP_API_BASE_URL=https://<tunnel-host>
   MINI_APP_ALLOWED_ORIGINS=https://<tunnel-host>
   ```
   Restart the bot (config is read once at boot).
5. In **@BotFather** → `/setmenubutton` (or `/newapp` for a Direct Link Mini App), paste the tunnel URL.
6. Open the bot inside Telegram and tap the menu/web-app entry.

The Mini App URL is also consumed by the bot via the backend's `MINI_APP_URL` env var (used to render inline-keyboard buttons on `/start`, `/dashboard`, etc.).

## Theming

All colors come from CSS custom properties (`--tg-bg`, `--tg-text`, `--tg-button`, …) populated from `Telegram.WebApp.themeParams`. Components reference Tailwind utilities like `bg-tg-bg`, `text-tg-text`, `bg-tg-button` — never hardcoded hex.

## Locales

Thai uses **IBM Plex Sans Thai**, English uses **Roboto**, both loaded via `VITE_FONT_PROVIDER_URL`. The locale is read from `/me`, can be changed in Settings, and propagates via `<html data-locale>`.
