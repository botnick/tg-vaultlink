# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-02

### Added

- Initial public release of VaultLink Bot.
- Telegram file uploads with share codes and deep links.
- Multi-bot support: add personal public or private bots via `/add_bot` and `/add_bot_open`.
- AES-256-GCM encryption for stored bot tokens.
- Per-user rate limits (upload, download, add_bot, report).
- Password-protected files (argon2id).
- Optional file expiry.
- Report and auto-lock at threshold.
- Admin commands: ban/unban, lock/unlock, delete file, broadcast (feature-flagged).
- Bilingual UX (th default, en).
- SQLite (WAL) storage with foreign keys; migration runner.
- Standalone and Docker runtimes.
- Auto build & release workflow on `v*` tags.

[Unreleased]: https://github.com/botnick/tg-vaultlink/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/botnick/tg-vaultlink/releases/tag/v0.1.0
