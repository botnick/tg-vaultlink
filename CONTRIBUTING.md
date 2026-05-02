# Contributing to VaultLink Bot

Thanks for considering a contribution. Bug reports, feature requests, and pull requests are all welcome — small, focused PRs land fastest. By participating you agree to abide by the project's [Code of Conduct](./CODE_OF_CONDUCT.md).

## Setting up the dev environment

```powershell
git clone https://github.com/botnick/tg-vaultlink.git
cd tg-vaultlink

pnpm install
pnpm --dir apps/mini-app install

Copy-Item .env.example .env
pnpm generate:key   # paste output into TOKEN_ENCRYPTION_KEY in .env
# fill MAIN_BOT_TOKEN and ADMIN_IDS in .env

pnpm db:migrate
pnpm dev                       # runs the bot under tsx watch
pnpm --dir apps/mini-app dev   # runs the Mini App frontend on Vite
```

If you're working on the Mini App, also copy `apps/mini-app/.env.example` to `apps/mini-app/.env` and fill in the bot username plus the local API base URL (defaults to `http://localhost:8081/api/v1`).

## Branching

- **`main` is protected.** All work happens on feature branches.
- Branch names follow `<type>/<short-slug>`, for example `feat/collection-reorder`, `fix/throttler-deadlock`, or `docs/env-table`.
- Use [Conventional Commit](https://www.conventionalcommits.org/) style for commit messages. Examples: `feat(bot): add /reorder for collections`, `fix(miniapp): tighten initData freshness window`.

## Commit and PR style

- Keep PRs small and focused. Split unrelated changes into separate PRs.
- Include relevant tests. New behaviour without tests is rarely accepted.
- Describe the **why**, not just the what. Reference an issue if there is one.
- Rebase, don't merge, when bringing in `main`. We squash on merge.

## Update discipline

The same checklist appears in `.github/PULL_REQUEST_TEMPLATE.md`. CI will fail or reviewers will block on missing items:

- [ ] `package.json` version bumped (when release-worthy)
- [ ] `CHANGELOG.md` entry added under `[Unreleased]`
- [ ] `README.md` updated if commands, env vars, or features changed
- [ ] `.env.example` matches `src/config/env.ts` exactly (both directions — every key in one is in the other)
- [ ] Both locale files (`src/locales/th.json` and `src/locales/en.json`) updated for any new user-visible string
- [ ] `Dockerfile` and `docker-compose.yml` updated if base image or runtime config changed
- [ ] Tests added or updated
- [ ] No hardcoded values introduced — every new tunable traces back to env, the `settings` table, or locale JSON

## Quality gates

Run these locally before pushing; CI runs the same set:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm docker:build                 # sanity-check the image build
pnpm --dir apps/mini-app typecheck
```

`pnpm test` runs the vitest suite; `pnpm test:watch` is handy during development.

## Code style

- **Prettier** + **ESLint flat config**. Run `pnpm format` to auto-fix.
- TypeScript is configured with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Don't fight these flags — they exist on purpose.
- The project uses **ESM with NodeNext** module resolution. Local imports must include the `.js` extension even when importing a `.ts` file (TypeScript rewrites this at build time).
- Avoid `any` and `as any`. If you genuinely need an escape hatch, leave a comment explaining why.
- Prefer pure functions; keep side effects at the edges (routers, services, repositories).

## Where to add things

| Kind of change | Where it lives |
| --- | --- |
| Pure helper logic | `src/utils/` |
| Domain logic with collaborators | `src/services/` |
| SQL access (one repo per table family) | `src/repositories/` |
| New SQL table or column | a new file under `src/db/migrations/` |
| New bot command or wizard step | `src/bot/routers/` |
| New Mini App API route | `src/miniapp/routes/` |
| User-visible text | **both** `src/locales/th.json` and `src/locales/en.json` |
| New env variable | add to `src/config/env.ts`, mirror in `.env.example`, cover in `tests/env.test.ts` |
| Mini App frontend | `apps/mini-app/` (see its own README) |

## Releasing

Releases are tag-driven. Once `[Unreleased]` is ready in `CHANGELOG.md`:

1. Bump `version` in `package.json`.
2. Promote the `[Unreleased]` section to a versioned heading in `CHANGELOG.md` with today's date.
3. Commit and push to `main`.
4. Tag: `git tag v<version>` and `git push --tags`.

The `release.yml` workflow takes it from there: lint, typecheck, test, build, multi-arch Docker push to GHCR, tarball, and GitHub Release with notes pulled from `CHANGELOG.md`.

## Questions

Open a discussion or issue at <https://github.com/botnick/tg-vaultlink>. For security concerns, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.
