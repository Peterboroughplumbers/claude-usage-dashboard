/**
 * Claude Code auto-switch support.
 *
 * Terminals opened from the dashboard run Claude Code through a small wrapper
 * (`claude-auto.ps1`, see src/main/scripts). When the current account hits its usage
 * limit, the wrapper moves the running session to another signed-in account and
 * resumes it — no re-login. To choose the target it reads
 * `~/.claude-accounts/accounts.json`, which the dashboard keeps up to date from the
 * same numbers it shows on screen (percentages, recommendation, Claude Code sign-in
 * state). No credentials or tokens are ever written there.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectivePercent, recommendAccount } from '../shared/status';
import type { AccountState, TerminalSwitchStrategy } from '../shared/types';
import { log } from './logger';
import { accountsRoot, configDir, findClaude } from './terminal';

export const AUTO_SWITCH_SCRIPT = 'claude-auto.ps1';

/** One line per account in the file the wrapper reads. */
export interface AccountsFileEntry {
  id: number;
  name: string;
  configDir: string;
  /** Claude Code (CLI) signed in for this account's config dir; null = not checked yet. */
  claudeCodeLoggedIn: boolean | null;
  sessionPercent: number | null;
  weeklyPercent: number | null;
  modelWeeklyPercent: number | null;
  /** Highest known percentage (what the dashboard's status is based on). */
  effectivePercent: number | null;
  sessionResetAt: number | null;
  weeklyResetAt: number | null;
  /** Epoch ms of the usage reading, null when unknown. */
  usageCapturedAt: number | null;
  /** Latest read error kind (e.g. "login_required"), null when the last read succeeded. */
  error: string | null;
}

export interface AccountsFile {
  version: 1;
  /** Epoch ms when this file was written. */
  updatedAt: number;
  /** Master switch from the dashboard settings; the wrapper is a plain launcher when false. */
  autoSwitch: boolean;
  /** Which account the wrapper should prefer when switching. */
  switchStrategy: TerminalSwitchStrategy;
  /** Full path of the `claude` CLI as found by the dashboard (wrapper falls back to PATH). */
  claudePath: string | null;
  /** Account the dashboard currently recommends (most capacity left), or null. */
  recommendedId: number | null;
  accounts: AccountsFileEntry[];
}

/** Pure: builds the file contents from dashboard state. */
export function buildAccountsFile(
  accounts: AccountState[],
  opts: {
    autoSwitch: boolean;
    switchStrategy?: TerminalSwitchStrategy;
    claudePath: string | null;
    now: number;
    configDirFor?: (id: number) => string;
  },
): AccountsFile {
  const dirFor = opts.configDirFor ?? configDir;
  return {
    version: 1,
    updatedAt: opts.now,
    autoSwitch: opts.autoSwitch,
    switchStrategy: opts.switchStrategy === 'soonest-reset' ? 'soonest-reset' : 'most-capacity',
    claudePath: opts.claudePath,
    recommendedId: recommendAccount(accounts)?.id ?? null,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      configDir: dirFor(a.id),
      claudeCodeLoggedIn: a.terminal ? a.terminal.loggedIn : null,
      sessionPercent: a.usage?.sessionPercent ?? null,
      weeklyPercent: a.usage?.weeklyPercent ?? null,
      modelWeeklyPercent: a.usage?.modelWeeklyPercent ?? null,
      effectivePercent: effectivePercent(a),
      sessionResetAt: a.usage?.sessionResetAt ?? null,
      weeklyResetAt: a.usage?.weeklyResetAt ?? null,
      usageCapturedAt: a.usage?.capturedAt ?? null,
      error: a.error,
    })),
  };
}

export function accountsFilePath(): string {
  return join(accountsRoot(), 'accounts.json');
}

/** Writes `~/.claude-accounts/accounts.json` atomically. Errors are logged, never thrown. */
export function writeAccountsFile(
  accounts: AccountState[],
  autoSwitch: boolean,
  switchStrategy: TerminalSwitchStrategy = 'most-capacity',
): void {
  const claudePath = findClaude();
  // Pointless without Claude Code — don't litter the home directory.
  if (!claudePath && !existsSync(accountsRoot())) return;
  const file = accountsFilePath();
  try {
    mkdirSync(accountsRoot(), { recursive: true });
    const data = buildAccountsFile(accounts, { autoSwitch, switchStrategy, claudePath, now: Date.now() });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    log.warn('Could not write accounts.json for the terminal auto-switch', err);
  }
}

/**
 * Installs (or refreshes) the wrapper script in `helperDir` from the copy shipped with
 * the app. Returns the installed path.
 */
export function ensureAutoSwitchScript(helperDir: string): string {
  mkdirSync(helperDir, { recursive: true });
  const dest = join(helperDir, AUTO_SWITCH_SCRIPT);
  const src = join(__dirname, 'scripts', AUTO_SWITCH_SCRIPT);
  try {
    // Always overwrite so app updates reach existing installs. Compare first to avoid churn.
    const next = readFileSync(src);
    if (!existsSync(dest) || !readFileSync(dest).equals(next)) {
      writeFileSync(dest, next);
      log.info(`Installed ${AUTO_SWITCH_SCRIPT} to ${helperDir}`);
    }
  } catch (err) {
    log.warn('Could not install the auto-switch wrapper script', err);
    if (!existsSync(dest)) copyFileSync(src, dest); // let the original error surface if this fails too
  }
  return dest;
}

/* ------------------------------ global shim ------------------------------- */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

export const SHIM_SCRIPT = 'claude-shim.ps1';
const SHIM_BEGIN_MARK = '# >>> Claude Usage Dashboard auto-switch shim >>>';

/** PowerShell "profile.ps1" (all-hosts, current user) — where the shim block lives. */
function powershellProfilePath(): string {
  // Matches Get-ProfilePaths in claude-shim.ps1 (WindowsPowerShell all-hosts profile).
  return join(homedir(), 'Documents', 'WindowsPowerShell', 'profile.ps1');
}

/** True if the `claude` shim block is present in the PowerShell profile. */
export function isGlobalShimInstalled(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const p = powershellProfilePath();
    return existsSync(p) && readFileSync(p, 'utf8').includes(SHIM_BEGIN_MARK);
  } catch {
    return false;
  }
}

/**
 * Installs or removes the global `claude` shim by running claude-shim.ps1. The wrapper is
 * installed alongside first so the shim has something to call. Resolves to an error message or null.
 */
export function setGlobalShim(helperDir: string, enabled: boolean): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve('The global shim is only available on Windows.');
  ensureAutoSwitchScript(helperDir);
  // Install the shim script next to the wrapper, then run it.
  mkdirSync(helperDir, { recursive: true });
  const shimDest = join(helperDir, SHIM_SCRIPT);
  try {
    const src = join(__dirname, 'scripts', SHIM_SCRIPT);
    const next = readFileSync(src);
    if (!existsSync(shimDest) || !readFileSync(shimDest).equals(next)) writeFileSync(shimDest, next);
  } catch (err) {
    return Promise.resolve(`Could not find the shim installer: ${err instanceof Error ? err.message : String(err)}`);
  }
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shimDest, '-Action', enabled ? 'install' : 'uninstall'],
      { windowsHide: true, timeout: 30_000 },
      (err, _stdout, stderr) => {
        if (err) {
          log.warn(`Global shim ${enabled ? 'install' : 'uninstall'} failed`, stderr || err);
          resolve(stderr?.trim() || err.message);
        } else {
          log.info(`Global shim ${enabled ? 'installed' : 'removed'}`);
          resolve(null);
        }
      },
    );
  });
}
