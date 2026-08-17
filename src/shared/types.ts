/** Shared types between main, preload and renderer. Keep this file dependency-free. */

/** Accounts are numbered 1..n; ids are stable (a removed id is never reused). */
export type AccountId = number;
export const DEFAULT_ACCOUNT_IDS: readonly AccountId[] = [1, 2, 3];
export const MAX_ACCOUNTS = 10;

export type UsageStatus = 'available' | 'medium' | 'high' | 'near_limit';

/** Result kinds when reading usage fails. Never fabricated values. */
export type UsageErrorKind =
  | 'login_required'
  | 'unavailable' // Claude page could not be loaded (5xx, challenge page, etc.)
  | 'unreadable' // page loaded but expected elements were not found
  | 'network' // no connectivity / DNS / timeout
  | 'browser_busy' // profile currently in use (e.g. login window open)
  | 'no_browser'; // no Chromium-based browser found on this machine

export interface UsageSnapshot {
  /** Current (5h) session usage in percent, or null if not shown. */
  sessionPercent: number | null;
  /** Weekly (all models) usage in percent, or null if not shown. */
  weeklyPercent: number | null;
  /**
   * Weekly usage of the model-specific sub-limit (Claude shows e.g. "Sonnet only"
   * or "Fable"), or null if not shown.
   */
  modelWeeklyPercent: number | null;
  /** Label of the model-specific sub-limit as displayed (e.g. "Sonnet", "Fable"). */
  modelWeeklyLabel: string | null;
  /** Plan name as displayed (e.g. "Max (20x)", "Pro"). */
  planName: string | null;
  /** Display name of the account holder if it could be read. */
  displayName: string | null;
  /** Human-readable reset text for the session limit as shown on the page. */
  sessionResetText: string | null;
  /** Absolute epoch ms when session resets, if it could be derived. */
  sessionResetAt: number | null;
  /** Human-readable reset text for the weekly limit. */
  weeklyResetText: string | null;
  weeklyResetAt: number | null;
  /** Account email if it could be read. */
  email: string | null;
  /** Epoch ms when this snapshot was captured. */
  capturedAt: number;
}

export type AccountReadState = 'idle' | 'refreshing' | 'ok' | 'error';

/** Sign-in state of Claude Code (terminal) for this account's own config dir. */
export interface TerminalState {
  loggedIn: boolean;
  email: string | null;
  subscription: string | null;
}

export interface AccountState {
  id: AccountId;
  name: string;
  readState: AccountReadState;
  /** Last successful snapshot (kept even if a later refresh failed). */
  usage: UsageSnapshot | null;
  /** Error from the latest attempt, null when latest attempt succeeded. */
  error: UsageErrorKind | null;
  errorDetail: string | null;
  /** True if we have ever successfully read usage from this profile. */
  hasProfile: boolean;
  /** Whether a login browser window is currently open for this account. */
  loginInProgress: boolean;
  /** Whether any visible browser window (login or "Open Claude") is open for this account. */
  windowOpen: boolean;
  /** Claude Code sign-in state for this account (null = unknown / CLI missing). */
  terminal: TerminalState | null;
  /** True while a terminal setup (CLI login) or launch is running. */
  terminalBusy: boolean;
  /** Short note about a login link picked up from the clipboard (shown under the login box). */
  autoLinkNote: string | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
}

export interface Settings {
  /** Ordered list of account ids shown in the dashboard. */
  accountIds: AccountId[];
  accountNames: Record<AccountId, string>;
  /** Auto-refresh interval in minutes (0 disables). */
  refreshIntervalMinutes: number;
  launchAtStartup: boolean;
  alwaysOnTop: boolean;
  minimizeToTray: boolean;
  /** Show the browser window during background refresh (debugging aid). */
  showBrowserOnRefresh: boolean;
  /** Window background opacity in percent (30–100). Lower = more see-through. */
  windowOpacity: number;
  /** Keep the widget hidden; reveal it when the mouse touches the right screen edge. */
  edgeAutoHide: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  accountIds: [1, 2, 3],
  accountNames: { 1: 'Account 1', 2: 'Account 2', 3: 'Account 3' },
  refreshIntervalMinutes: 5,
  launchAtStartup: false,
  alwaysOnTop: false,
  minimizeToTray: true,
  showBrowserOnRefresh: false,
  windowOpacity: 100,
  edgeAutoHide: false,
};

export interface DashboardState {
  accounts: AccountState[];
  settings: Settings;
  lastUpdatedAt: number | null;
  refreshing: boolean;
  /** Name of the browser used by Playwright ("Google Chrome", "Microsoft Edge") or null when none found. */
  browserName: string | null;
  /** Whether the `claude` CLI (Claude Code) was found on this machine. */
  claudeCliFound: boolean;
  appVersion: string;
}

/** IPC channel names. */
export const IPC = {
  getState: 'dashboard:get-state',
  stateChanged: 'dashboard:state-changed',
  refreshAll: 'dashboard:refresh-all',
  refreshOne: 'dashboard:refresh-one',
  login: 'dashboard:login',
  openClaude: 'dashboard:open-claude',
  focusWindow: 'dashboard:focus-window',
  loginNavigate: 'dashboard:login-navigate',
  terminalOpen: 'dashboard:terminal-open',
  addAccount: 'dashboard:add-account',
  removeAccount: 'dashboard:remove-account',
  saveSettings: 'dashboard:save-settings',
  minimize: 'window:minimize',
  close: 'window:close',
  fitHeight: 'window:fit-height',
} as const;

/** API exposed to the renderer through the preload script. */
export interface DashboardApi {
  getState(): Promise<DashboardState>;
  refreshAll(): Promise<void>;
  refreshOne(id: AccountId): Promise<void>;
  login(id: AccountId): Promise<void>;
  openClaude(id: AccountId): Promise<void>;
  /** Brings the account's open browser window to the front (no-op when none is open). */
  focusWindow(id: AccountId): Promise<void>;
  /**
   * Opens a claude.ai link (e.g. the magic link from the login e-mail) inside the
   * account's login window so the session lands in the app profile. Resolves to an
   * error message, or null on success.
   */
  loginNavigate(id: AccountId, url: string): Promise<string | null>;
  /**
   * Opens a terminal running Claude Code signed in as this account. On first use it
   * runs the CLI login inside the account's browser profile (one "Authorize" click).
   * Resolves to an error message, or null on success.
   */
  terminalOpen(id: AccountId): Promise<string | null>;
  /** Adds a new empty account card. Resolves to its id, or null when the limit is reached. */
  addAccount(): Promise<AccountId | null>;
  /** Removes an account and deletes its local browser profile / saved data. */
  removeAccount(id: AccountId): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
  minimize(): void;
  close(): void;
  /** Ask the window to resize its height to fit `px` of content (clamped to the screen). */
  fitHeight(px: number): void;
  onStateChanged(cb: (state: DashboardState) => void): () => void;
}
