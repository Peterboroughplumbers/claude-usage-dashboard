import { shell } from 'electron';
import type { BrowserContext, Page } from 'playwright-core';
import { ensureAutoSwitchScript, writeAccountsFile } from './autoswitch';
import {
  MAX_ACCOUNTS,
  type AccountId,
  type AccountState,
  type DashboardState,
  type Settings,
} from '../shared/types';
import type { BrowserManager } from './browser';
import { log } from './logger';
import type { Store } from './store';
import {
  ensureLauncher,
  ensureNoopBrowser,
  findClaude,
  markOnboarded,
  openTerminal,
  resetClaudeCache,
  startLogin,
  terminalStatus,
} from './terminal';
import { classifyError, CLAUDE_ORIGIN, extractUsage, LOGIN_URL, type ParseResult } from './usage/extractor';

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const LOGIN_POLL_MS = 2_000;
/** Hard cap for one background read (launch + navigate + parse). */
const REFRESH_TIMEOUT_MS = 120_000;
/** Hosts a pasted login link may point to. */
const LOGIN_LINK_HOSTS = /(^|\.)(claude\.ai|anthropic\.com)$/i;
/** How long to wait for the user to click "Authorize" during Claude Code login. */
const TERMINAL_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** Claude Code's OAuth callback page (shows the code we hand back to the CLI). */
const OAUTH_CALLBACK_RE = /oauth\/code\/callback/i;

type Listener = (state: DashboardState) => void;

/**
 * Orchestrates refreshes, logins and the auto-refresh timer.
 * Holds the in-memory dashboard state and notifies listeners on change.
 */
export class AccountManager {
  private accounts: AccountState[];
  private lastUpdatedAt: number | null = null;
  private refreshingAll = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly openWindows = new Map<AccountId, BrowserContext>();

  constructor(
    private readonly store: Store,
    private readonly browsers: BrowserManager,
    private readonly appVersion: string,
    /** Directory for generated helper scripts (launchers, no-op browser). */
    private readonly helperDir: string,
    /** Directory on PATH where `claude1/2/3` launchers are placed (optional). */
    private readonly pathBinDir: string | null,
  ) {
    this.accounts = store.initialAccounts();
    for (const a of this.accounts) {
      if (!a.hasProfile && browsers.hasProfileData(a.id)) a.hasProfile = true;
      if (a.lastSuccessAt && (!this.lastUpdatedAt || a.lastSuccessAt > this.lastUpdatedAt)) {
        this.lastUpdatedAt = a.lastSuccessAt;
      }
    }
  }

  /* ----------------------------- state / events ---------------------------- */

  getState(): DashboardState {
    return {
      accounts: this.accounts.map((a) => ({ ...a, usage: a.usage ? { ...a.usage } : null })),
      settings: { ...this.store.settings, accountNames: { ...this.store.settings.accountNames } },
      lastUpdatedAt: this.lastUpdatedAt,
      refreshing: this.refreshingAll || this.accounts.some((a) => a.readState === 'refreshing'),
      browserName: this.browsers.browserName,
      claudeCliFound: findClaude() !== null,
      appVersion: this.appVersion,
    };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.getState();
    for (const l of this.listeners) {
      try {
        l(state);
      } catch (err) {
        log.error('State listener failed', err);
      }
    }
    this.scheduleAccountsFile();
  }

  private accountsFileTimer: NodeJS.Timeout | null = null;

  /**
   * Keeps `~/.claude-accounts/accounts.json` (read by the terminal auto-switch wrapper)
   * in sync with what the dashboard shows. Debounced: state changes come in bursts.
   */
  private scheduleAccountsFile(): void {
    if (this.accountsFileTimer) return;
    this.accountsFileTimer = setTimeout(() => {
      this.accountsFileTimer = null;
      writeAccountsFile(this.accounts, this.store.settings.terminalAutoSwitch);
    }, 500);
  }

  private account(id: AccountId): AccountState {
    const a = this.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`Unknown account ${id}`);
    return a;
  }

  private setWindow(id: AccountId, ctx: BrowserContext | null): void {
    if (ctx) this.openWindows.set(id, ctx);
    else this.openWindows.delete(id);
    this.account(id).windowOpen = ctx !== null;
    this.emit();
  }

  /** Brings the account's visible browser window (if any) to the front. */
  async focusWindow(id: AccountId): Promise<void> {
    const ctx = this.openWindows.get(id);
    if (!ctx) return;
    const page = ctx.pages()[0];
    if (!page) return;
    await page.bringToFront().catch((err) => log.warn(`Could not focus window for account ${id}`, err));
  }

  /**
   * Opens a claude.ai link inside the account's login window. Used when the
   * e-mail login link opened in another browser: pasting it here makes the
   * session land in this account's profile. Returns an error message or null.
   */
  async loginNavigate(id: AccountId, rawUrl: string): Promise<string | null> {
    const acc = this.account(id);
    const ctx = this.openWindows.get(id);
    if (!ctx || !acc.loginInProgress) return 'No login window is open for this account. Click Login first.';
    let url: URL;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      return 'That is not a valid link.';
    }
    if (url.protocol !== 'https:' || !LOGIN_LINK_HOSTS.test(url.hostname)) {
      return 'Only https://claude.ai links can be opened here.';
    }
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    try {
      await page.bringToFront().catch(() => undefined);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      log.info(`Account ${id}: opened pasted login link (${url.origin}${url.pathname})`);
      return null;
    } catch (err) {
      const { detail } = classifyError(err);
      log.warn(`Account ${id}: pasted login link failed`, detail);
      return `Could not open the link: ${detail}`;
    }
  }

  /** Id of the account whose login was started most recently (target for clipboard links). */
  private lastLoginId: AccountId | null = null;

  /** True if the text looks like a claude.ai login / magic link (what the login e-mail contains). */
  static isLoginLink(text: string): boolean {
    const t = text.trim();
    if (t.length > 4000 || /\s/.test(t)) return false;
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' || !LOGIN_LINK_HOSTS.test(url.hostname)) return false;
    return /(magic|login|signin|auth|verify|token|code)/i.test(url.pathname + url.search + url.hash);
  }

  /**
   * Called by the clipboard watcher: opens a copied login link in the account whose login
   * window is open (the most recently started one if several are). Returns true if handled.
   */
  async autoOpenLoginLink(text: string): Promise<boolean> {
    const open = this.accounts.filter((a) => a.loginInProgress && this.openWindows.has(a.id));
    if (open.length === 0) return false;
    const target = open.find((a) => a.id === this.lastLoginId) ?? open[open.length - 1]!;
    target.autoLinkNote = 'Login link found in clipboard — opening it here…';
    this.emit();
    const err = await this.loginNavigate(target.id, text);
    target.autoLinkNote = err ? `Clipboard link: ${err}` : 'Login link from clipboard opened in this window ✓';
    this.emit();
    log.info(`Account ${target.id}: clipboard login link ${err ? 'failed' : 'opened'}`);
    return true;
  }

  /* --------------------------------- settings ------------------------------- */

  applySettings(settings: Settings): void {
    // The account list itself is managed via addAccount/removeAccount; keep the current ids.
    this.store.setSettings({ ...settings, accountIds: this.accounts.map((a) => a.id) });
    for (const a of this.accounts) a.name = this.store.settings.accountNames[a.id] ?? a.name;
    this.startTimer();
    this.emit();
  }

  hasAccount(id: AccountId): boolean {
    return this.accounts.some((a) => a.id === id);
  }

  /** Adds a new, empty account (next free id). Returns its id or null at the limit. */
  addAccount(): AccountId | null {
    if (this.accounts.length >= MAX_ACCOUNTS) return null;
    const used = new Set(this.accounts.map((a) => a.id));
    // Never reuse an id: profiles/config dirs of removed accounts may linger.
    let id = 1;
    while (used.has(id) || this.browsers.hasProfileData(id)) id++;
    const s = this.store.settings;
    this.store.setSettings({
      ...s,
      accountIds: [...this.accounts.map((a) => a.id), id],
      accountNames: { ...s.accountNames, [id]: `Account ${id}` },
    });
    this.accounts.push({
      id,
      name: `Account ${id}`,
      readState: 'idle',
      usage: null,
      error: 'login_required',
      errorDetail: 'Click "Login" to sign in to this account',
      hasProfile: false,
      loginInProgress: false,
      autoLinkNote: null,
      windowOpen: false,
      terminal: null,
      terminalBusy: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
    });
    log.info(`Account ${id} added`);
    this.emit();
    return id;
  }

  /** Removes an account and deletes its saved data + browser profile. */
  async removeAccount(id: AccountId): Promise<void> {
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx < 0) return;
    if (this.accounts.length <= 1) return; // keep at least one card
    const acc = this.accounts[idx];
    if (acc.windowOpen || acc.loginInProgress || acc.readState === 'refreshing' || acc.terminalBusy) {
      log.info(`Remove account ${id} refused: busy`);
      return;
    }
    this.accounts.splice(idx, 1);
    const s = this.store.settings;
    const names = { ...s.accountNames };
    delete names[id];
    this.store.setSettings({ ...s, accountIds: this.accounts.map((a) => a.id), accountNames: names });
    this.store.deleteAccount(id);
    this.emit();
    try {
      this.browsers.deleteProfile(id);
    } catch (err) {
      log.warn(`Could not delete browser profile for account ${id}`, err);
    }
    log.info(`Account ${id} removed`);
  }

  startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const minutes = this.store.settings.refreshIntervalMinutes;
    if (minutes > 0) {
      this.timer = setInterval(() => void this.refreshAll(), minutes * 60_000);
      log.info(`Auto refresh every ${minutes} min`);
    }
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* --------------------------------- refresh -------------------------------- */

  async refreshAll(): Promise<void> {
    if (this.refreshingAll) return;
    this.refreshingAll = true;
    this.emit();
    try {
      // Sequential to keep CPU/memory low (each refresh launches a browser).
      for (const id of this.accounts.map((a) => a.id)) {
        if (this.accounts.some((a) => a.id === id)) await this.refreshOne(id);
      }
    } finally {
      this.refreshingAll = false;
      this.emit();
    }
  }

  async refreshOne(id: AccountId): Promise<void> {
    const acc = this.account(id);
    if (acc.readState === 'refreshing') return;
    if (this.openWindows.has(id) || acc.loginInProgress) {
      // A visible browser window is using this profile; don't interfere with the user.
      // The login flow reads usage itself when it completes.
      log.info(`Refresh skipped for account ${id}: browser window open`);
      return;
    }
    if (!acc.hasProfile) {
      // Never logged in: don't launch a browser, just report login required.
      acc.error = 'login_required';
      acc.errorDetail = 'Click "Login" to sign in to this account';
      acc.readState = 'error';
      this.emit();
      return;
    }
    if (!this.browsers.browserName) {
      this.browsers.redetect();
      if (!this.browsers.browserName) {
        this.setError(acc, 'no_browser', 'Install Microsoft Edge or Google Chrome');
        return;
      }
    }

    acc.readState = 'refreshing';
    acc.lastAttemptAt = Date.now();
    this.emit();

    try {
      const result = await this.browsers.withContext(
        id,
        { headless: !this.store.settings.showBrowserOnRefresh, timeoutMs: REFRESH_TIMEOUT_MS },
        (_ctx, page) => extractUsage(page, { includeIdentity: !acc.usage?.email }),
      );
      this.applyResult(acc, result);
    } catch (err) {
      const { error, detail } = classifyError(err);
      log.warn(`Refresh failed for account ${id}: ${error}`, detail);
      this.setError(acc, error, detail);
    }
  }

  private applyResult(acc: AccountState, result: ParseResult): void {
    if (result.ok) {
      // Identity fields are only re-read occasionally; keep previous values when absent.
      acc.usage = {
        ...result.usage,
        email: result.usage.email ?? acc.usage?.email ?? null,
        displayName: result.usage.displayName ?? acc.usage?.displayName ?? null,
        planName: result.usage.planName ?? acc.usage?.planName ?? null,
      };
      acc.error = null;
      acc.errorDetail = null;
      acc.readState = 'ok';
      acc.hasProfile = true;
      acc.lastSuccessAt = result.usage.capturedAt;
      this.lastUpdatedAt = result.usage.capturedAt;
      this.store.saveAccount(acc.id, acc);
      log.info(
        `Account ${acc.id}: session=${acc.usage.sessionPercent}% weekly=${acc.usage.weeklyPercent}% model=${acc.usage.modelWeeklyLabel}:${acc.usage.modelWeeklyPercent}%`,
      );
      this.emit();
    } else {
      log.warn(`Account ${acc.id}: ${result.error} — ${result.detail}`);
      this.setError(acc, result.error, result.detail);
    }
  }

  private setError(acc: AccountState, error: AccountState['error'], detail: string | null): void {
    acc.error = error;
    acc.errorDetail = detail;
    acc.readState = 'error';
    if (error === 'login_required') {
      // Keep the last snapshot for reference but it must not count as current.
      acc.usage = null;
      this.store.saveAccount(acc.id, acc);
    }
    this.emit();
  }

  /* ---------------------------------- login --------------------------------- */

  /**
   * Opens a visible browser window in the account's profile so the user can log
   * in manually. Polls until we can read the usage page, then closes the window.
   * No credentials are ever touched by this app.
   */
  async login(id: AccountId): Promise<void> {
    const acc = this.account(id);
    if (acc.loginInProgress || this.openWindows.has(id)) {
      log.info(`Login requested for account ${id} but a window is already open — focusing it`);
      await this.focusWindow(id);
      return;
    }
    if (acc.readState === 'refreshing') {
      log.info(`Login requested for account ${id} while refreshing — will open after the read`);
    }
    acc.loginInProgress = true;
    acc.autoLinkNote = null;
    this.lastLoginId = id;
    acc.error = null;
    acc.errorDetail = null;
    this.emit();
    log.info(`Login started for account ${id}`);

    try {
      await this.browsers.withContext(id, { headless: false }, async (ctx, page) => {
        this.setWindow(id, ctx);
        try {
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
          const result = await this.waitForLogin(ctx);
          if (result) this.applyResult(acc, result);
          else log.info(`Login window for account ${id} closed or timed out without a successful read`);
        } finally {
          this.setWindow(id, null);
        }
      });
    } catch (err) {
      const { error, detail } = classifyError(err);
      log.warn(`Login flow ended with error for account ${id}: ${error}`, detail);
      if (error !== 'browser_busy') this.setError(acc, error, detail);
    } finally {
      acc.loginInProgress = false;
      acc.autoLinkNote = null;
      acc.hasProfile = acc.hasProfile || this.browsers.hasProfileData(id);
      this.emit();
      log.info(`Login finished for account ${id}`);
    }
  }

  private async waitForLogin(ctx: BrowserContext): Promise<ParseResult | null> {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let stableLoggedInPolls = 0;
    let closed = false;
    ctx.once('close', () => (closed = true));

    while (Date.now() < deadline && !closed) {
      await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
      const pages = ctx.pages();
      if (pages.length === 0) break; // user closed the window
      const loggedInLooking = pages.some((p) => {
        const u = p.url();
        return (
          u.startsWith(CLAUDE_ORIGIN) &&
          !/\/(login|signin|magic-link|oauth|auth)\b/i.test(u.slice(CLAUDE_ORIGIN.length))
        );
      });
      stableLoggedInPolls = loggedInLooking ? stableLoggedInPolls + 1 : 0;
      if (stableLoggedInPolls >= 2) {
        // Looks logged in — verify by reading the usage page in a fresh tab.
        const page = await ctx.newPage();
        try {
          const result = await extractUsage(page, { includeIdentity: true });
          if (result.ok) return result;
          if (result.error !== 'login_required') {
            // Logged in but page unreadable/unavailable: report and stop waiting.
            return result;
          }
        } catch (err) {
          if (closed) break;
          log.warn('Verification read during login failed', classifyError(err).detail);
        } finally {
          await page.close().catch(() => undefined);
        }
        stableLoggedInPolls = 0;
      }
    }
    return null;
  }

  /* -------------------------------- open claude ------------------------------ */

  /** Opens claude.ai in a visible window using the account's own profile. */
  async openClaude(id: AccountId): Promise<void> {
    const acc = this.account(id);
    if (this.openWindows.has(id)) {
      log.info(`Open Claude requested for account ${id} but a window is already open — focusing it`);
      await this.focusWindow(id);
      return;
    }
    log.info(`Open Claude for account ${id}`);
    if (!acc.hasProfile) {
      await this.login(id);
      return;
    }
    if (!this.browsers.browserName) {
      // No automation-capable browser: at least open in the default browser.
      await shell.openExternal(CLAUDE_ORIGIN);
      return;
    }
    try {
      await this.browsers.withContext(id, { headless: false }, async (ctx, page) => {
        this.setWindow(id, ctx);
        try {
          await page.goto(`${CLAUDE_ORIGIN}/new`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
          await new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (ctx.pages().length === 0) {
                clearInterval(check);
                resolve();
              }
            }, 1000);
            ctx.once('close', () => {
              clearInterval(check);
              resolve();
            });
          });
        } finally {
          this.setWindow(id, null);
        }
      });
    } catch (err) {
      log.warn(`Open Claude failed for account ${id}`, classifyError(err).detail);
    } finally {
      log.info(`Open Claude window closed for account ${id}`);
      // The user may have logged in (or out) in that window: re-read right away.
      void this.refreshOne(id);
    }
  }

  isWindowOpen(id: AccountId): boolean {
    return this.openWindows.has(id);
  }

  /* ------------------------------ Claude Code ------------------------------- */

  /** Re-reads `claude auth status` for every account (background, sequential). */
  async refreshTerminalStatus(): Promise<void> {
    resetClaudeCache();
    if (!findClaude()) {
      this.emit();
      return;
    }
    for (const acc of this.accounts) {
      if (acc.terminalBusy) continue;
      acc.terminal = await terminalStatus(acc.id);
      this.emit();
    }
  }

  /**
   * Opens a terminal running Claude Code as this account. If the account's own
   * Claude Code config dir isn't signed in yet, runs `claude auth login` first and
   * shows the OAuth page in the account's browser profile (already logged in to
   * claude.ai) — the user only clicks "Authorize"; the code is handed back to the
   * CLI automatically. Returns an error message or null.
   */
  async openTerminal(id: AccountId): Promise<string | null> {
    const acc = this.account(id);
    if (acc.terminalBusy) return null;
    resetClaudeCache();
    if (!findClaude()) {
      this.emit();
      return 'Claude Code (claude CLI) was not found. Install it first: https://claude.com/claude-code';
    }
    acc.terminalBusy = true;
    this.emit();
    try {
      let status = acc.terminal ?? (await terminalStatus(id));
      if (!status?.loggedIn) {
        log.info(`Terminal setup for account ${id}: Claude Code not signed in yet — starting login`);
        const err = await this.terminalLogin(id);
        if (err) return err;
        status = await terminalStatus(id);
        acc.terminal = status;
        this.emit();
        if (!status?.loggedIn) return 'Claude Code login did not complete. Please try again.';
        log.info(`Terminal setup for account ${id} done (${status.email ?? 'unknown e-mail'})`);
      } else {
        acc.terminal = status;
      }
      markOnboarded(id);
      let wrapper: string | null = null;
      if (process.platform === 'win32') {
        try {
          wrapper = ensureAutoSwitchScript(this.helperDir);
        } catch (err) {
          log.warn('Auto-switch wrapper unavailable, opening a plain terminal', err);
        }
      }
      writeAccountsFile(this.accounts, this.store.settings.terminalAutoSwitch);
      const launcher = ensureLauncher(id, this.helperDir, acc.name, wrapper);
      if (this.pathBinDir) {
        try {
          ensureLauncher(id, this.pathBinDir, acc.name, wrapper);
        } catch (err) {
          log.warn('Could not write PATH launcher', err);
        }
      }
      openTerminal(launcher, acc.name);
      log.info(`Opened terminal for account ${id}`);
      return null;
    } catch (err) {
      log.warn(`Terminal open failed for account ${id}`, err);
      return `Could not open terminal: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      acc.terminalBusy = false;
      this.emit();
    }
  }

  /** Runs the CLI login inside the account's browser profile. Returns an error message or null. */
  private async terminalLogin(id: AccountId): Promise<string | null> {
    if (this.openWindows.has(id) || this.account(id).loginInProgress) {
      await this.focusWindow(id);
      return 'A browser window for this account is already open. Close it and try again.';
    }
    const session = startLogin(id, ensureNoopBrowser(this.helperDir));
    if (!session) return 'Could not start `claude auth login`.';
    const url = await Promise.race([
      session.url,
      new Promise<null>((r) => setTimeout(() => r(null), 45_000)),
    ]);
    if (!url) {
      session.cancel();
      return 'The claude CLI did not provide a login link.';
    }
    let ok = false;
    let error: string | null = null;
    try {
      await this.browsers.withContext(id, { headless: false }, async (ctx, page) => {
        this.setWindow(id, ctx);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
          const deadline = Date.now() + TERMINAL_LOGIN_TIMEOUT_MS;
          let submitted = false;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1000));
            const pages = ctx.pages();
            if (pages.length === 0) {
              error = 'The browser window was closed before the login finished.';
              break;
            }
            if (!submitted) {
              for (const p of pages) {
                const code = await this.readOauthCode(p);
                if (code) {
                  session.submitCode(code);
                  submitted = true;
                  log.info(`Account ${id}: authorization code handed to claude CLI`);
                  // Tell the user nothing more is needed (the callback page says "copy this code").
                  await p
                    .evaluate(() => {
                      document.body.innerHTML =
                        '<div style="font:600 22px/1.4 Segoe UI,system-ui,sans-serif;color:#e9edff;background:#0a0e1a;' +
                        'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px">' +
                        '<div style="font-size:44px">✅</div><div>Done — Claude Code is signed in.</div>' +
                        '<div style="font-size:15px;color:#7d86a8;font-weight:400">You don’t need to copy anything. This window closes automatically.</div></div>';
                    })
                    .catch(() => undefined);
                  break;
                }
              }
              continue;
            }
            const result = await Promise.race([
              session.done,
              new Promise<'pending'>((r) => setTimeout(() => r('pending'), 1000)),
            ]);
            if (result !== 'pending') {
              ok = result;
              if (!ok) error = 'The claude CLI rejected the authorization code.';
              break;
            }
          }
          if (!ok && !error) error = 'Timed out waiting for authorization.';
        } finally {
          this.setWindow(id, null);
        }
      });
    } catch (err) {
      error = classifyError(err).detail;
    }
    if (!ok) session.cancel();
    return ok ? null : error;
  }

  /** Extracts the "code#state" authorization code from Claude's OAuth callback page, if this is one. */
  private async readOauthCode(page: Page): Promise<string | null> {
    const u = page.url();
    if (!OAUTH_CALLBACK_RE.test(u)) return null;
    try {
      const q = new URL(u).searchParams;
      const code = q.get('code');
      const state = q.get('state');
      if (code && state) return `${code}#${state}`;
    } catch {
      /* fall through to page text */
    }
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const m = /([A-Za-z0-9_-]{16,}#[A-Za-z0-9_-]{16,})/.exec(text);
    return m ? m[1] : null;
  }

  async shutdown(): Promise<void> {
    this.stopTimer();
    if (this.accountsFileTimer) {
      clearTimeout(this.accountsFileTimer);
      this.accountsFileTimer = null;
      writeAccountsFile(this.accounts, this.store.settings.terminalAutoSwitch);
    }
    await this.browsers.closeAll();
  }
}
