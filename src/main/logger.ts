import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal file logger with redaction.
 * Never logs cookies, tokens, session keys or authorization headers.
 */
const REDACT_PATTERNS: RegExp[] = [
  /(sessionKey|session_key|sk-ant-[A-Za-z0-9-_]+)[^\s;,]*/gi,
  /(cookie|set-cookie|authorization|bearer|token|secret|password)\s*[:=]\s*[^\s;,]+/gi,
  /(__cf_bm|cf_clearance|__Secure-[^=]+|_ga[^=]*)=[^;\s]+/gi,
];

const MAX_LOG_BYTES = 1_000_000;

let logFile: string | null = null;

export function initLogger(userDataDir: string): void {
  try {
    const dir = join(userDataDir, 'logs');
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, 'app.log');
    rotateIfNeeded();
  } catch {
    logFile = null;
  }
}

function rotateIfNeeded(): void {
  if (!logFile) return;
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`);
  } catch {
    /* file may not exist yet */
  }
}

export function redact(input: string): string {
  let out = input;
  for (const re of REDACT_PATTERNS) out = out.replace(re, '$1=[REDACTED]');
  return out;
}

function write(level: 'INFO' | 'WARN' | 'ERROR', msg: string, extra?: unknown): void {
  const detail = extra === undefined ? '' : ' ' + safeStringify(extra);
  const line = `${new Date().toISOString()} [${level}] ${redact(msg + detail)}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch {
      /* ignore */
    }
  }
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => write('INFO', msg, extra),
  warn: (msg: string, extra?: unknown) => write('WARN', msg, extra),
  error: (msg: string, extra?: unknown) => write('ERROR', msg, extra),
};
