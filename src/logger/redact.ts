/**
 * VaultLink Bot — logger redaction policy.
 *
 * Paths listed here are scrubbed by pino before any log line leaves the
 * process. The list intentionally covers both runtime field names (camelCase)
 * and persistence column names (snake_case) so that logging a raw DB row never
 * leaks a secret. Glob form (`*.token`) catches the same key when it appears
 * one level deep inside an arbitrary parent.
 */

export const REDACT_PATHS: readonly string[] = [
  'token',
  'tokens',
  '*.token',
  'encryptedToken',
  'encrypted_token',
  '*.encrypted_token',
  'MAIN_BOT_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
  'password',
  '*.password',
  'password_hash',
  '*.password_hash',
  'authorization',
  'cookie',
  'set-cookie',
];

/**
 * Render a secret-like string for log/debug surfaces without exposing it. The
 * input is never returned verbatim: short values are fully masked, longer ones
 * keep the first 3 and last 2 characters so operators can spot mismatches.
 */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return '<empty>';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}
