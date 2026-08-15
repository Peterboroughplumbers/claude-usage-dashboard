import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { AccountId } from '../shared/types';
import { log } from './logger';

/**
 * Manages one persistent Chromium profile per account.
 *
 * - Profiles live in <userData>/profiles/account-<id>. Cookies/session data are
 *   stored there by Chromium itself; this app never reads or exports them.
 * - Uses an installed Chromium-based browser (Edge/Chrome — Edge ships with
 *   Windows) through playwright-core so we don't have to bundle a browser.
 * - Only one context per profile can be open at a time (Chromium locks the
 *   profile), so every access goes through a per-account queue.
 */

export interface DetectedBrowser {
  channel: 'msedge' | 'chrome' | 'chromium';
  name: string;
  executablePath?: string;
}

const CANDIDATES: Array<{ channel: 'chrome' | 'msedge'; name: string; paths: string[] }> = [
  {
    channel: 'chrome',
    name: 'Google Chrome',
    paths: [
      join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
  },
  {
    channel: 'msedge',
    name: 'Microsoft Edge',
    paths: [
      join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
  },
];

export function detectBrowser(): DetectedBrowser | null {
  for (const c of CANDIDATES) {
    const found = c.paths.find((p) => p && existsSync(p));
    if (found) return { channel: c.channel, name: c.name, executablePath: found };
  }
  // Non-Windows dev machines: let Playwright resolve its own chromium if installed.
  if (process.platform !== 'win32') {
    try {
      const p = chromium.executablePath();
      if (p && existsSync(p)) return { channel: 'chromium', name: 'Chromium', executablePath: p };
    } catch {
      /* not installed */
    }
  }
  return null;
}

type Task<T> = () => Promise<T>;

class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  private active = 0;

  get busy(): boolean {
    return this.active > 0;
  }

  run<T>(task: Task<T>): Promise<T> {
    const next = this.tail.then(async () => {
      this.active++;
      try {
        return await task();
      } finally {
        this.active--;
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface LaunchOptions {
  headless: boolean;
  /**
   * Hard upper bound for the whole task (launch + fn). When exceeded the context
   * is force-closed and the returned promise rejects. Omit for interactive windows.
   */
  timeoutMs?: number;
}

export class BrowserManager {
  private readonly queues = new Map<AccountId, Queue>();
  private readonly openContexts = new Map<AccountId, BrowserContext>();
  private browser: DetectedBrowser | null;
  /** Cached headless UA ('' = could not determine, undefined = not probed yet). */
  private headlessUA: string | undefined;

  constructor(private readonly userDataDir: string) {
    this.browser = detectBrowser();
    if (this.browser) log.info(`Using browser: ${this.browser.name}`);
    else log.warn('No Chromium-based browser (Edge/Chrome) found');
  }

  get browserName(): string | null {
    return this.browser?.name ?? null;
  }

  redetect(): void {
    this.browser = detectBrowser();
  }

  profileDir(id: AccountId): string {
    const dir = join(this.userDataDir, 'profiles', `account-${id}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Deletes the account's browser profile folder (must not be in use). */
  deleteProfile(id: AccountId): void {
    const dir = join(this.userDataDir, 'profiles', `account-${id}`);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  hasProfileData(id: AccountId): boolean {
    return existsSync(join(this.profileDir(id), 'Default'));
  }

  isBusy(id: AccountId): boolean {
    return this.queue(id).busy;
  }

  private queue(id: AccountId): Queue {
    let q = this.queues.get(id);
    if (!q) {
      q = new Queue();
      this.queues.set(id, q);
    }
    return q;
  }

  /**
   * Headless Chrome announces itself as "HeadlessChrome/…" which claude.ai's
   * bot protection rejects. We read the real UA once and reuse it with the
   * "Headless" marker removed. Everything else stays the genuine browser.
   */
  private async headlessUserAgent(): Promise<string | undefined> {
    if (this.headlessUA !== undefined) return this.headlessUA || undefined;
    if (!this.browser) return undefined;
    try {
      const b = await chromium.launch({
        channel: this.browser.channel === 'chromium' ? undefined : this.browser.channel,
        executablePath: this.browser.channel === 'chromium' ? this.browser.executablePath : undefined,
        headless: true,
        chromiumSandbox: true,
      });
      try {
        const page = await b.newPage();
        const ua = await page.evaluate(() => navigator.userAgent);
        this.headlessUA = ua.replace(/HeadlessChrome/g, 'Chrome');
      } finally {
        await b.close().catch(() => undefined);
      }
    } catch (err) {
      log.warn('Could not determine browser user agent', err);
      this.headlessUA = '';
    }
    return this.headlessUA || undefined;
  }

  private async launch(id: AccountId, opts: LaunchOptions): Promise<BrowserContext> {
    if (!this.browser) throw new Error('No Chromium-based browser found (install Microsoft Edge or Google Chrome)');
    const userAgent = opts.headless ? await this.headlessUserAgent() : undefined;
    const ctx = await chromium.launchPersistentContext(this.profileDir(id), {
      channel: this.browser.channel === 'chromium' ? undefined : this.browser.channel,
      executablePath: this.browser.channel === 'chromium' ? this.browser.executablePath : undefined,
      headless: opts.headless,
      chromiumSandbox: true,
      userAgent,
      viewport: opts.headless ? { width: 1200, height: 900 } : null,
      locale: 'en-US',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        ...(opts.headless ? [] : ['--window-size=1100,850']),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    this.openContexts.set(id, ctx);
    ctx.on('close', () => {
      if (this.openContexts.get(id) === ctx) this.openContexts.delete(id);
    });
    return ctx;
  }

  /**
   * Runs `fn` with an exclusive context for the account. The context is always
   * closed afterwards. Calls for the same account are serialized.
   */
  async withContext<T>(
    id: AccountId,
    opts: LaunchOptions,
    fn: (ctx: BrowserContext, page: Page) => Promise<T>,
  ): Promise<T> {
    return this.queue(id).run(async () => {
      const state: { ctx: BrowserContext | null; timedOut: boolean } = { ctx: null, timedOut: false };
      let timer: NodeJS.Timeout | null = null;
      const work = (async () => {
        const c = await this.launch(id, opts);
        if (state.timedOut) {
          // Launch finished after the deadline: don't leave the profile locked.
          await c.close().catch(() => undefined);
          throw new Error('Timed out before the browser was ready');
        }
        state.ctx = c;
        const page = c.pages()[0] ?? (await c.newPage());
        return await fn(c, page);
      })();
      const guarded =
        opts.timeoutMs && opts.timeoutMs > 0
          ? Promise.race([
              work,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  state.timedOut = true;
                  reject(new Error(`Timeout ${opts.timeoutMs}ms exceeded while reading account ${id}`));
                }, opts.timeoutMs);
              }),
            ])
          : work;
      try {
        return await guarded;
      } finally {
        if (timer) clearTimeout(timer);
        work.catch(() => undefined); // avoid unhandled rejection when the race lost
        if (state.ctx) await state.ctx.close().catch(() => undefined);
      }
    });
  }

  /** Force-closes any open context for the account (e.g. on app quit). */
  async closeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.openContexts.values()).map((c) => c.close().catch(() => undefined)),
    );
    this.openContexts.clear();
  }
}
