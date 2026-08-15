import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_ACCOUNT_IDS,
  MAX_ACCOUNTS,
  DEFAULT_SETTINGS,
  type AccountId,
  type AccountState,
  type Settings,
  type UsageSnapshot,
} from '../shared/types';
import { log } from './logger';

/**
 * Persists settings and the last known usage snapshots as JSON in userData.
 * Only non-sensitive data is stored here (no cookies / tokens — those live in
 * the browser profile directories managed by Chromium itself).
 */

interface PersistedAccount {
  usage: UsageSnapshot | null;
  hasProfile: boolean;
  lastSuccessAt: number | null;
}

interface PersistedFile {
  version: 1;
  settings: Settings;
  accounts: Record<string, PersistedAccount>;
}

export class Store {
  private readonly file: string;
  private data: PersistedFile;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'dashboard-state.json');
    this.data = this.load();
  }

  private load(): PersistedFile {
    const empty: PersistedFile = { version: 1, settings: { ...DEFAULT_SETTINGS }, accounts: {} };
    if (!existsSync(this.file)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedFile>;
      return {
        version: 1,
        settings: sanitizeSettings(raw.settings),
        accounts: raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {},
      };
    } catch (err) {
      log.warn('Could not read state file, starting fresh', err);
      return empty;
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      log.error('Failed to save state', err);
    }
  }

  get settings(): Settings {
    return this.data.settings;
  }

  setSettings(settings: Settings): void {
    this.data.settings = sanitizeSettings(settings);
    this.save();
  }

  initialAccounts(): AccountState[] {
    return this.data.settings.accountIds.map((id) => {
      const p = this.data.accounts[String(id)];
      return {
        id,
        name: this.data.settings.accountNames[id],
        readState: 'idle',
        usage: p?.usage ?? null,
        error: null,
        errorDetail: null,
        hasProfile: p?.hasProfile ?? false,
        loginInProgress: false,
        windowOpen: false,
        terminal: null,
        terminalBusy: false,
        lastAttemptAt: null,
        lastSuccessAt: p?.lastSuccessAt ?? null,
      };
    });
  }

  /** Removes the persisted snapshot of an account (settings are updated separately). */
  deleteAccount(id: AccountId): void {
    delete this.data.accounts[String(id)];
    this.save();
  }

  saveAccount(id: AccountId, acc: Pick<AccountState, 'usage' | 'hasProfile' | 'lastSuccessAt'>): void {
    this.data.accounts[String(id)] = {
      usage: acc.usage,
      hasProfile: acc.hasProfile,
      lastSuccessAt: acc.lastSuccessAt,
    };
    this.save();
  }
}

export function sanitizeSettings(input: unknown): Settings {
  const s = (input && typeof input === 'object' ? input : {}) as Partial<Settings>;
  // Account ids: positive integers, unique, at most MAX_ACCOUNTS; default 1..3.
  let ids: number[] = Array.isArray(s.accountIds)
    ? s.accountIds
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0 && v <= 10_000)
    : [...DEFAULT_ACCOUNT_IDS];
  ids = Array.from(new Set(ids)).slice(0, MAX_ACCOUNTS);
  if (ids.length === 0) ids = [1];
  const names: Record<number, string> = {};
  const rawNames = s.accountNames && typeof s.accountNames === 'object' ? (s.accountNames as Record<number, unknown>) : {};
  for (const id of ids) {
    const n = rawNames[id];
    names[id] = typeof n === 'string' && n.trim() ? n.trim().slice(0, 40) : `Account ${id}`;
  }
  const interval = Number(s.refreshIntervalMinutes);
  return {
    accountIds: ids,
    accountNames: names,
    refreshIntervalMinutes: Number.isFinite(interval) ? Math.min(1440, Math.max(0, Math.round(interval))) : 5,
    launchAtStartup: Boolean(s.launchAtStartup),
    alwaysOnTop: Boolean(s.alwaysOnTop),
    minimizeToTray: s.minimizeToTray === undefined ? true : Boolean(s.minimizeToTray),
    showBrowserOnRefresh: Boolean(s.showBrowserOnRefresh),
    windowOpacity: Number.isFinite(Number(s.windowOpacity))
      ? Math.min(100, Math.max(30, Math.round(Number(s.windowOpacity))))
      : 100,
  };
}
