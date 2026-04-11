import { appendFileSync } from 'node:fs';
import { LOG_FILE_PATH } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(
  mode: 'mcp' | 'cli',
  options?: { minLevel?: LogLevel; logToFile?: boolean }
): Logger {
  const minLevel = options?.minLevel ?? 'info';
  const logToFile = options?.logToFile ?? false;

  // MCP mode: write to stderr (stdout is JSON-RPC transport)
  // CLI mode: write to stdout
  const write =
    mode === 'mcp'
      ? (s: string) => process.stderr.write(s + '\n')
      : (s: string) => process.stdout.write(s + '\n');

  function log(
    level: LogLevel,
    msg: string,
    meta?: Record<string, unknown>
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const timestamp = new Date().toISOString();
    const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
    const line = `[${timestamp}] ${level.toUpperCase()} ${msg}${metaStr}`;

    write(line);

    if (logToFile) {
      try {
        appendFileSync(LOG_FILE_PATH, line + '\n');
      } catch {
        // Best effort file logging
      }
    }
  }

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };
}
