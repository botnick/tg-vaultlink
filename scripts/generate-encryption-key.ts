/**
 * Print a fresh 32-byte AES-256 key, base64-encoded, to stdout. The companion
 * hint goes to stderr so piping the output into a file (e.g.
 * `pnpm generate:key >> .env`) keeps just the key value.
 */

import { randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('base64');
process.stdout.write(`${key}\n`);
process.stderr.write('// Paste this value into TOKEN_ENCRYPTION_KEY in your .env\n');
