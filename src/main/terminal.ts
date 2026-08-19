/**
 * Claude Code (terminal) integration.
 *
 * Every dashboard account gets its own Claude Code config directory
 * (`~/.claude-accounts/account-N`, used through CLAUDE_CONFIG_DIR) so the CLI can
 * be signed in to three different Claude accounts at the same time without the
 * user logging in/out. The dashboard only ever calls the official `claude auth …`
 * commands; it never reads or copies OAuth tokens.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { AccountId } from '../shared/types';
import { log } from './logger';

export interface TerminalStatus {
  loggedIn: boolean;
  email: string | null;
  subscription: string | null;
}

const IS_WIN = process.platform === 'win32';
const STATUS_TIMEOUT_MS = 20_000;

/** Root for per-account Claude Code config dirs. */
export function accountsRoot(): string {
  return join(homedir(), '.claude-accounts');
}

export function configDir(id: AccountId): string {
  return join(accountsRoot(), `account-${id}`);
}

/** Creates the config dir on first use and seeds it with the user's global settings.json (never credentials). */
export function ensureConfigDir(id: AccountId): string {
  const dir = configDir(id);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    const globalSettings = join(homedir(), '.claude', 'settings.json');
    if (existsSync(globalSettings)) {
      try {
        copyFileSync(globalSettings, join(dir, 'settings.json'));
      } catch (err) {
        log.warn('Could not seed settings.json for terminal account', err);
      }
    }
  }
  return dir;
}

/**
 * Marks the account's Claude Code config as onboarded (and copies harmless UI
 * preferences from the global ~/.claude.json) so the CLI doesn't show the
 * first-run wizard (theme + "select login method") in a config dir that is
 * already signed in. Never touches credentials.
 */
export function markOnboarded(id: AccountId): void {
  const dir = ensureConfigDir(id);
  const file = join(dir, '.claude.json');
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (data['hasCompletedOnboarding'] === true) return;
  const COPY_KEYS = ['theme', 'editorMode', 'preferredNotifChannel', 'autoUpdates', 'verbose', 'shiftEnterKeyBindingInstalled'];
  try {
    const globalFile = join(homedir(), '.claude.json');
    if (existsSync(globalFile)) {
      const g = JSON.parse(readFileSync(globalFile, 'utf8')) as Record<string, unknown>;
      for (const k of COPY_KEYS) if (g[k] !== undefined && data[k] === undefined) data[k] = g[k];
    }
  } catch {
    /* optional */
  }
  data['hasCompletedOnboarding'] = true;
  try {
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    log.warn('Could not mark Claude Code onboarding as completed', err);
  }
}

/* ------------------------------ claude binary ------------------------------ */

let cachedClaude: string | null | undefined;

/** Finds the `claude` CLI on PATH (or the default native-install location). Cached. */
export function findClaude(): string | null {
  if (cachedClaude !== undefined) return cachedClaude;
  const names = IS_WIN ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = [
    ...(process.env['PATH'] ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    ...(IS_WIN ? [join(process.env['APPDATA'] ?? '', 'npm')] : ['/usr/local/bin', '/opt/homebrew/bin']),
  ].filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      if (existsSync(p)) {
        cachedClaude = p;
        return p;
      }
    }
  }
  cachedClaude = null;
  return null;
}

export function resetClaudeCache(): void {
  cachedClaude = undefined;
}

function envFor(id: AccountId, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_CONFIG_DIR: ensureConfigDir(id), ...extra };
}

/** Spawns the CLI. `.cmd` shims need a shell on Windows. */
function spawnClaude(args: string[], env: NodeJS.ProcessEnv): ChildProcess | null {
  const bin = findClaude();
  if (!bin) return null;
  const useShell = IS_WIN && /\.cmd$/i.test(bin);
  return spawn(bin, args, { env, shell: useShell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

/* --------------------------------- status --------------------------------- */

/** `claude auth status` for the account's config dir. Null when the CLI is missing or the call fails. */
export function terminalStatus(id: AccountId): Promise<TerminalStatus | null> {
  return new Promise((resolve) => {
    const child = spawnClaude(['auth', 'status'], envFor(id));
    if (!child) return resolve(null);
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, STATUS_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const m = /\{[\s\S]*\}/.exec(out);
      if (!m) return resolve(null);
      try {
        const j = JSON.parse(m[0]) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
        resolve({
          loggedIn: Boolean(j.loggedIn),
          email: typeof j.email === 'string' ? j.email : null,
          subscription: typeof j.subscriptionType === 'string' ? j.subscriptionType : null,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/* ---------------------------------- login ---------------------------------- */

export interface LoginSession {
  /** Resolves with the OAuth URL printed by the CLI (or null if it never appeared). */
  url: Promise<string | null>;
  /** Paste the authorization code shown on the callback page. */
  submitCode(code: string): void;
  /** Resolves when the CLI exits: true = signed in. */
  done: Promise<boolean>;
  cancel(): void;
}

// eslint-disable-next-line no-control-regex -- the CLI may wrap the URL in an OSC-8 escape
const URL_RE = /https:\/\/[^\s\x1b\x07"'\]]+oauth\/authorize[^\s\x1b\x07"'\]]*/;

/**
 * Starts `claude auth login` non-interactively. The CLI prints the OAuth URL and
 * waits for the authorization code on stdin. BROWSER is pointed at a no-op script
 * so the user's default browser is NOT opened — the caller shows the URL in the
 * account's own browser profile instead.
 */
export function startLogin(id: AccountId, noopBrowserScript: string): LoginSession | null {
  const child = spawnClaude(['auth', 'login', '--claudeai'], envFor(id, { BROWSER: noopBrowserScript }));
  if (!child) return null;

  let resolveUrl!: (u: string | null) => void;
  const url = new Promise<string | null>((r) => (resolveUrl = r));
  let output = '';
  let urlFound = false;
  const onData = (d: Buffer): void => {
    output += d.toString();
    if (!urlFound) {
      // Strip OSC-8 hyperlink escapes, then look for the authorize URL.
      // eslint-disable-next-line no-control-regex -- strips OSC-8 hyperlink escapes
      const clean = output.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\x5c)/g, '');
      const m = URL_RE.exec(clean);
      if (m) {
        urlFound = true;
        resolveUrl(m[0]);
      }
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const done = new Promise<boolean>((resolve) => {
    child.on('error', (err) => {
      log.warn('claude auth login failed to start', err);
      resolveUrl(null);
      resolve(false);
    });
    child.on('close', (code) => {
      resolveUrl(null);
      const ok = code === 0 && !/error|failed/i.test(output.slice(-400));
      if (!ok) log.warn(`claude auth login exited with code ${code}`);
      resolve(ok);
    });
  });

  return {
    url,
    done,
    submitCode: (code: string) => {
      child.stdin?.write(code.trim() + '\n');
    },
    cancel: () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Writes the tiny no-op "browser" used to keep the CLI from opening the default browser. */
export function ensureNoopBrowser(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, IS_WIN ? 'noop-browser.cmd' : 'noop-browser.sh');
  if (!existsSync(file)) {
    writeFileSync(file, IS_WIN ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return file;
}

/* --------------------------------- terminal -------------------------------- */

/**
 * Writes `claude1.cmd`/`claude2.cmd`/`claude3.cmd` launchers (CLAUDE_CONFIG_DIR preset)
 * into `dir`. Returns the launcher path for the account.
 *
 * With `autoSwitchScript` (Windows only) the launcher runs Claude Code through the
 * auto-switch wrapper, which moves the session to another signed-in account when this
 * one hits its usage limit. The user's arguments are handed over in CLAUDE_AUTO_ARGS
 * (`powershell -File` would otherwise try to bind `-p`, `--model`, … as script params).
 */
export function ensureLauncher(id: AccountId, dir: string, accountName: string, autoSwitchScript: string | null = null): string {
  mkdirSync(dir, { recursive: true });
  const cfg = ensureConfigDir(id);
  if (IS_WIN) {
    const file = join(dir, `claude${id}.cmd`);
    const run = autoSwitchScript
      ? ['set "CLAUDE_AUTO_ARGS=%*"', `powershell -NoProfile -ExecutionPolicy Bypass -File "${autoSwitchScript}" -Account ${id}`]
      : ['claude %*'];
    const body = [
      '@echo off',
      `rem Claude Code as dashboard account ${id} (${accountName}) — generated by Claude Usage Dashboard`,
      `set "CLAUDE_CONFIG_DIR=${cfg}"`,
      `title Claude Code - ${accountName}`,
      ...run,
      '',
    ].join('\r\n');
    writeFileSync(file, body);
    return file;
  }
  const file = join(dir, `claude${id}`);
  writeFileSync(file, `#!/bin/sh\n# Claude Code as dashboard account ${id} (${accountName})\nCLAUDE_CONFIG_DIR="${cfg}" exec claude "$@"\n`, {
    mode: 0o755,
  });
  return file;
}

function windowsTerminal(): string | null {
  const p = join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WindowsApps', 'wt.exe');
  return existsSync(p) ? p : null;
}

/** Opens a new terminal window running Claude Code for the account. */
export function openTerminal(launcher: string, accountName: string): void {
  const cwd = homedir();
  const title = `Claude Code - ${accountName}`;
  if (IS_WIN) {
    const wt = windowsTerminal();
    if (wt) {
      spawn(wt, ['-w', 'new', 'new-tab', '--title', title, '-d', cwd, 'cmd', '/k', launcher], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      }).unref();
    } else {
      spawn('cmd.exe', ['/c', 'start', `"${title}"`, '/D', cwd, 'cmd', '/k', `"${launcher}"`], {
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsHide: false,
      }).unref();
    }
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', launcher], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const term = process.env['TERMINAL'] ?? 'x-terminal-emulator';
  spawn(term, ['-e', launcher], { detached: true, stdio: 'ignore', cwd }).unref();
}
