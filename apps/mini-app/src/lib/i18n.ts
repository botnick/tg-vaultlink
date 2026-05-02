/**
 * VaultLink Mini App — i18n hook re-export.
 *
 * The actual context + provider live in `providers/I18nProvider.tsx`.
 * This module re-exports the consumer hook so call sites can stay
 * decoupled from where the provider is mounted (and the import paths
 * read like product code, not infrastructure: `import { useT } from
 * '@/lib/i18n'`).
 */

export { useT, useLocale } from '../providers/I18nProvider.js';
