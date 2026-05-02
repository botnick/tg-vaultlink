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

| Variable                 | Purpose                        | Default                        |
| ------------------------ | ------------------------------ | ------------------------------ |
| `VITE_API_BASE_URL`      | Hono backend base URL          | `http://localhost:8081/api/v1` |
| `VITE_BOT_USERNAME`      | Telegram bot username (no `@`) | —                              |
| `VITE_FONT_PROVIDER_URL` | Font CSS provider              | `https://fonts.googleapis.com` |
| `VITE_APP_VERSION`       | Shown on Settings → About      | `dev`                          |

## Telegram-only

The app guards against being opened outside Telegram. If `window.Telegram.WebApp` is missing or `initData` is empty, an "open in Telegram" guard screen renders with a deep-link CTA.

To preview locally on a real device:

1. Tunnel the dev server (`cloudflared tunnel --url http://localhost:5173` or similar).
2. In **@BotFather** → **Edit Bot** → **Edit Web App URL**, paste the tunnel URL.
3. Open the bot's menu and tap the Mini App entry.

The Mini App URL is also consumed by the bot via the backend's `MINI_APP_URL` env var (used to render the inline-keyboard button on `/start`).

## Theming

All colors come from CSS custom properties (`--tg-bg`, `--tg-text`, `--tg-button`, …) populated from `Telegram.WebApp.themeParams`. Components reference Tailwind utilities like `bg-tg-bg`, `text-tg-text`, `bg-tg-button` — never hardcoded hex.

## Locales

Thai uses **IBM Plex Sans Thai**, English uses **Roboto**, both loaded via `VITE_FONT_PROVIDER_URL`. The locale is read from `/me`, can be changed in Settings, and propagates via `<html data-locale>`.
