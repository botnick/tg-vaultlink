/**
 * VaultLink Bot — pino logger factory.
 *
 * One logger per process. In development the output is piped through
 * `pino-pretty` for a human-readable stream; in production the logger emits
 * structured JSON straight to stdout so it can be ingested verbatim by any
 * log shipper. Redaction paths come from {@link REDACT_PATHS} and apply in
 * both modes.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';
import { getConfig } from '../config/env.js';
import { REDACT_PATHS } from './redact.js';

/** Build a fresh pino logger from the current configuration. */
export function createLogger(): Logger {
  const config = getConfig();
  const isDev = config.NODE_ENV !== 'production';

  const baseOptions: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { app: config.APP_NAME, env: config.NODE_ENV },
    redact: {
      paths: [...REDACT_PATHS],
      censor: '<redacted>',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (isDev) {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(baseOptions);
}

let cached: Logger | undefined;

/** Lazily build and memoize the process-wide logger. */
export function getLogger(): Logger {
  if (!cached) cached = createLogger();
  return cached;
}

/** Test-only: drop the cached logger so the next access rebuilds it. */
export function resetLoggerForTests(): void {
  cached = undefined;
}
