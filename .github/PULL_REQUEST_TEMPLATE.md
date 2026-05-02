## Summary

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Docs
- [ ] CI / build

## Update discipline checklist

- [ ] `package.json` version bumped (if release-worthy)
- [ ] `CHANGELOG.md` entry added under `[Unreleased]`
- [ ] `README.md` updated if commands, env vars, or features changed
- [ ] `.env.example` matches `src/config/env.ts` exactly (both directions)
- [ ] Both locale files (`th.json` and `en.json`) updated for any new user-visible string
- [ ] `Dockerfile` / `docker-compose.yml` updated if base image or runtime config changed
- [ ] Tests added or updated
- [ ] No hardcoded values introduced (limits / URLs / locale text / feature flags trace back to env, settings table, or locales)

## Test plan

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Manual smoke test (describe steps below)

```

```
