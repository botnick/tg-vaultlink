/**
 * VaultLink Bot — process entry point.
 *
 * Hands off to {@link startApp}. Last-resort errors (config invalid, db
 * cannot open, etc.) are written to stderr and the process exits with a
 * non-zero code; the regular logger may not be available at that point.
 */

import { startApp } from './app.js';

startApp().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error:', err);
  process.exit(1);
});
