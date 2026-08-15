/**
 * ============================================================================
 *  USAGE EXTRACTION — the ONLY file that knows about claude.ai's page layout.
 *
 *  If Claude changes its UI, update the SELECTORS / PATTERNS below and the
 *  sample text in tests/extractor.test.ts. Everything here is best-effort and
 *  returns `null` for anything it cannot find. It NEVER invents values.
 *
 *  Layout as observed (Aug 2026): /settings/usage redirects to
 *  /new#settings/usage and renders a settings modal ([role="dialog"]) whose
 *  usage tab reads roughly:
 *
 *      Plan usage limits
 *      Max (20x)
 *      Current session
 *      Resets in 3 hr 12 min        (or "Starts when a message is sent")
 *      28% used
 *      Weekly limits
 *      All models
 *      Resets Thu 12:00 PM
 *      41% used
 *      Fable                        (model-specific sub-limit, label varies)
 *      15% used
 *      Last updated: just now
 *
 *  Each limit also has a [role="progressbar"] (aria-valuenow 0-100) in the
 *  same order, used as a fallback for the percentages.
 *  The account email is only shown in the sidebar user menu
 *  ([data-testid="user-menu-button"] -> popover).
 * ============================================================================
 */
import type { Page } from 'playwright-core';
import type { UsageErrorKind, UsageSnapshot } from '../../shared/types';

export const CLAUDE_ORIGIN = 'https://claude.ai';
export const USAGE_URL = `${CLAUDE_ORIGIN}/settings/usage`;
export const LOGIN_URL = `${CLAUDE_ORIGIN}/login`;

/** DOM selectors used by the collector. */
export const SELECTORS = {
  /** Container of the settings modal; falls back to <body> when absent. */
  dialog: '[role="dialog"]',
  /** Something that indicates the usage tab rendered (used to wait for hydration). */
  usageReady: 'text=/current session|weekly limits|all models/i',
  /** Progress bars (searched inside the dialog first, then the whole page). */
  progressBar: '[role="progressbar"], progress',
  /** Sidebar button that opens the account menu (contains display name · plan). */
  userMenuButton: '[data-testid="user-menu-button"]',
  /** Popover content that appears after clicking the user menu button. */
  userMenu: '[role="menu"], [data-radix-popper-content-wrapper], [data-side]',
};

/** Text patterns used by the pure parser. */
export const PATTERNS = {
  loginPage: /log ?in to claude|continue with google|sign in with|continue with email|enter your email/i,
  challengePage: /just a moment|performing security verification|checking your browser|verify you are human|attention required/i,
  serverError: /something went wrong|internal server error|service unavailable|bad gateway|\b50[234]\b/i,
  planHeader: /^plan usage limits?$/i,
  sessionHeader: /^(current session|session usage|session limit)\b/i,
  weeklyHeader: /^weekly limits?$/i,
  allModelsHeader: /^all models\b/i,
  /** Lines that end the model-specific block / usage section. */
  sectionEnd: /^(last updated|usage credits|extra usage|turn on usage credits|learn more)/i,
  percent: /(\d{1,3}(?:[.,]\d+)?)\s*%/,
  resetLine: /\bresets?\b(.*)/i,
  /** "in 3 hr 12 min", "in 2 hours", "in 45 minutes", "in 3h 12m", "in 1 day 3 hr" */
  relativeReset:
    /in\s+(?:(\d+)\s*(?:d|day|days)\b\s*)?(?:(\d+)\s*(?:h|hr|hrs|hour|hours)\b\s*)?(?:(\d+)\s*(?:m|min|mins|minute|minutes)\b)?/i,
  /** "Thu 12:00 PM", "3:00 PM", "Tomorrow 9:00 AM" */
  clockTime: /(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+|(tomorrow)\s+|(today)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
  email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /** Ignore lines like "Fable 5 is still included..." when looking for a model label. */
  noiseLine: /\b(is|are|you|your|if|the|to|and|please|learn|starts when|when a)\b/i,
};

/** Max lines after a header that belong to that section. */
const SECTION_WINDOW = 10;

/** Raw data collected from the page — plain data so the parser is unit-testable. */
export interface PageData {
  url: string;
  title: string;
  /** innerText of the settings dialog (or the whole body if no dialog). */
  usageText: string;
  /** aria-valuenow (0-100) of the usage progress bars in DOM order. */
  progressValues: number[];
  /** Text of the user-menu button, e.g. "P\nPeterborough\n·\nMax" (optional). */
  userButtonText?: string;
  /** Text of the opened user menu popover (contains the email) (optional). */
  userMenuText?: string;
  now?: number;
}

export type ParseResult =
  | { ok: true; usage: UsageSnapshot }
  | { ok: false; error: UsageErrorKind; detail: string };

/* -------------------------------------------------------------------------- */
/*  Pure parsing                                                              */
/* -------------------------------------------------------------------------- */

function toPercent(raw: string): number | null {
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10) / 10;
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

function findIndex(lines: string[], re: RegExp, from = 0, to = lines.length): number {
  for (let i = from; i < Math.min(to, lines.length); i++) if (re.test(lines[i])) return i;
  return -1;
}

/** Index of the first line containing a percentage in [from, to). */
function findPercentIndex(lines: string[], from: number, to: number): number {
  return findIndex(lines, PATTERNS.percent, from, to);
}

function percentAt(lines: string[], idx: number): number | null {
  if (idx < 0) return null;
  const m = PATTERNS.percent.exec(lines[idx]);
  return m ? toPercent(m[1]) : null;
}

function firstResetText(lines: string[], from: number, to: number): string | null {
  for (let i = Math.max(0, from); i < Math.min(to, lines.length); i++) {
    const m = PATTERNS.resetLine.exec(lines[i]);
    if (m) {
      const text = m[0].trim();
      if (text.length > 3 && text.length < 80) return text;
    }
  }
  return null;
}

/** Converts a "Resets in 3 hr 12 min" style string to an absolute timestamp. */
export function parseRelativeReset(text: string | null, now: number): number | null {
  if (!text) return null;
  const m = PATTERNS.relativeReset.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3] ?? 0);
  const total = ((days * 24 + hours) * 60 + minutes) * 60_000;
  return total > 0 ? now + total : null;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Converts "Resets Thu 12:00 PM" / "Resets 3:00 PM" / "Resets tomorrow 9 AM"
 * to the next matching local time after `now`. Returns null if not recognised.
 */
export function parseClockReset(text: string | null, now: number): number | null {
  if (!text) return null;
  const m = PATTERNS.clockTime.exec(text);
  if (!m) return null;
  const weekday = m[1] ? WEEKDAYS.indexOf(m[1].toLowerCase()) : -1;
  const tomorrow = Boolean(m[2]);
  let hour = Number(m[4]) % 12;
  const minute = Number(m[5] ?? 0);
  if (m[6].toLowerCase() === 'pm') hour += 12;
  if (hour > 23 || minute > 59) return null;

  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (weekday >= 0) {
    let delta = (weekday - d.getDay() + 7) % 7;
    if (delta === 0 && d.getTime() <= now) delta = 7;
    d.setDate(d.getDate() + delta);
  } else if (tomorrow) {
    d.setDate(d.getDate() + 1);
  } else if (d.getTime() <= now) {
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

export function parseResetAt(text: string | null, now: number): number | null {
  return parseRelativeReset(text, now) ?? parseClockReset(text, now);
}

/** Extracts "Peterborough" and "Max" from the user-menu button text "P\nPeterborough\n·\nMax". */
function parseUserButton(text: string | undefined): { displayName: string | null; plan: string | null } {
  if (!text) return { displayName: null, plan: null };
  const parts = text
    .split(/\n|·/)
    .map((p) => p.trim())
    .filter((p) => p.length > 1); // drop the single-letter avatar
  if (parts.length === 0) return { displayName: null, plan: null };
  const displayName = parts[0].slice(0, 60);
  const plan = parts.length > 1 ? parts[parts.length - 1].slice(0, 30) : null;
  return { displayName, plan };
}

/**
 * Parses previously collected page data into a snapshot.
 * Detects login / challenge / error pages first.
 */
export function parseUsage(data: PageData): ParseResult {
  const now = data.now ?? Date.now();
  const url = data.url || '';
  const text = data.usageText || '';

  if (/\/(login|signin|magic-link)\b/i.test(url) || PATTERNS.loginPage.test(text.slice(0, 4000))) {
    return { ok: false, error: 'login_required', detail: 'Redirected to Claude login page' };
  }
  if (PATTERNS.challengePage.test(data.title) || PATTERNS.challengePage.test(text.slice(0, 2000))) {
    return { ok: false, error: 'unavailable', detail: 'Claude is showing a browser verification page' };
  }
  if (text.trim().length < 20) {
    return { ok: false, error: 'unavailable', detail: 'Page rendered no readable content' };
  }

  const lines = splitLines(text);
  const sIdx = findIndex(lines, PATTERNS.sessionHeader);
  const wHeaderIdx = findIndex(lines, PATTERNS.weeklyHeader, Math.max(0, sIdx));
  let amIdx = findIndex(lines, PATTERNS.allModelsHeader, Math.max(0, wHeaderIdx));
  if (amIdx < 0) amIdx = wHeaderIdx; // older layout without "All models" sub-header
  const endIdx = (() => {
    const e = findIndex(lines, PATTERNS.sectionEnd, Math.max(sIdx, amIdx, 0) + 1);
    return e < 0 ? lines.length : e;
  })();

  // --- session block: header .. next header (weekly/all models) or window
  const sEnd = sIdx < 0 ? -1 : Math.min(wHeaderIdx > sIdx ? wHeaderIdx : amIdx > sIdx ? amIdx : sIdx + SECTION_WINDOW, endIdx);
  const sPctIdx = sIdx < 0 ? -1 : findPercentIndex(lines, sIdx + 1, sEnd);
  let sessionPercent = percentAt(lines, sPctIdx);
  const sessionResetText = sIdx < 0 ? null : firstResetText(lines, sIdx + 1, sEnd);

  // --- weekly (all models) block: header .. first percent after it
  const wEnd = amIdx < 0 ? -1 : Math.min(amIdx + SECTION_WINDOW, endIdx);
  const wPctIdx = amIdx < 0 ? -1 : findPercentIndex(lines, amIdx + 1, wEnd);
  let weeklyPercent = percentAt(lines, wPctIdx);
  const weeklyResetText = amIdx < 0 ? null : firstResetText(lines, amIdx + 1, wPctIdx > 0 ? wPctIdx + 2 : wEnd);

  // --- model-specific block: label line after the weekly percent, then its percent
  let modelWeeklyLabel: string | null = null;
  let modelWeeklyPercent: number | null = null;
  if (wPctIdx >= 0) {
    const mEnd = Math.min(wPctIdx + 1 + SECTION_WINDOW, endIdx);
    const mPctIdx = findPercentIndex(lines, wPctIdx + 1, mEnd);
    if (mPctIdx > wPctIdx + 1) {
      // First "label-looking" line between the two percentages.
      for (let i = wPctIdx + 1; i < mPctIdx; i++) {
        const l = lines[i];
        if (PATTERNS.resetLine.test(l) || PATTERNS.noiseLine.test(l) || l.length > 40) continue;
        modelWeeklyLabel = l.replace(/\s*(only|usage)$/i, '').trim();
        break;
      }
      if (modelWeeklyLabel) modelWeeklyPercent = percentAt(lines, mPctIdx);
    }
  }

  // --- fallback: progress bars in DOM order (session, weekly, model)
  const bars = data.progressValues.filter((v) => Number.isFinite(v) && v >= 0 && v <= 100);
  if (sessionPercent === null && sIdx >= 0 && bars.length >= 1) sessionPercent = bars[0];
  if (weeklyPercent === null && amIdx >= 0 && bars.length >= 2) weeklyPercent = bars[1];
  if (modelWeeklyPercent === null && modelWeeklyLabel && bars.length >= 3) modelWeeklyPercent = bars[2];

  if (sessionPercent === null && weeklyPercent === null && modelWeeklyPercent === null) {
    if (PATTERNS.serverError.test(text.slice(0, 3000))) {
      return { ok: false, error: 'unavailable', detail: 'Claude reported an error page' };
    }
    return {
      ok: false,
      error: 'unreadable',
      detail:
        sIdx < 0 && amIdx < 0
          ? 'Usage sections not found on page (UI may have changed)'
          : 'Usage percentages not found on page (UI may have changed)',
    };
  }

  // --- plan name: line after "Plan usage limits", else from the user button
  const pIdx = findIndex(lines, PATTERNS.planHeader);
  const { displayName, plan: buttonPlan } = parseUserButton(data.userButtonText);
  let planName: string | null = null;
  if (pIdx >= 0 && pIdx + 1 < lines.length && lines[pIdx + 1].length <= 30 && !PATTERNS.sessionHeader.test(lines[pIdx + 1])) {
    planName = lines[pIdx + 1];
  }
  planName = planName ?? buttonPlan;

  const emailMatch = PATTERNS.email.exec(data.userMenuText ?? '');

  return {
    ok: true,
    usage: {
      sessionPercent,
      weeklyPercent,
      modelWeeklyPercent,
      modelWeeklyLabel,
      planName,
      displayName,
      sessionResetText,
      sessionResetAt: parseResetAt(sessionResetText, now),
      weeklyResetText,
      weeklyResetAt: parseResetAt(weeklyResetText, now),
      email: emailMatch ? emailMatch[0].toLowerCase() : null,
      capturedAt: now,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Playwright collection                                                     */
/* -------------------------------------------------------------------------- */

const NAV_TIMEOUT_MS = 45_000;
const HYDRATION_TIMEOUT_MS = 25_000;
const CHALLENGE_WAIT_MS = 12_000;

/** Reads aria-valuenow (0-100) from progress bars. Runs in the page. */
function readProgressValues(els: Element[]): number[] {
  return els
    .map((el) => {
      const max = Number(el.getAttribute('aria-valuemax') ?? el.getAttribute('max') ?? '100');
      const val = el.getAttribute('aria-valuenow') ?? el.getAttribute('value');
      const n = Number(val);
      if (val === null || !Number.isFinite(n) || max !== 100) return NaN;
      return n;
    })
    .filter((n) => Number.isFinite(n));
}

export interface CollectOptions {
  /** Also open the user menu to read the email/display name (slightly slower). */
  includeIdentity?: boolean;
}

async function dialogOrBodyText(page: Page): Promise<string> {
  return page
    .evaluate((sel) => {
      const d = document.querySelector<HTMLElement>(sel);
      return (d && d.innerText.length > 50 ? d.innerText : document.body?.innerText) ?? '';
    }, SELECTORS.dialog)
    .catch(() => '');
}

/**
 * Drives the given page to the usage settings and collects raw page data.
 * Throws for network-level failures (mapped by the caller).
 */
export async function collectPageData(page: Page, opts: CollectOptions = {}): Promise<PageData> {
  await page.goto(USAGE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  // A Cloudflare JS challenge may show first; give it a moment to pass.
  const challengeStart = Date.now();
  while (Date.now() - challengeStart < CHALLENGE_WAIT_MS) {
    const title = await page.title().catch(() => '');
    if (!PATTERNS.challengePage.test(title)) break;
    await page.waitForTimeout(1000);
  }

  // Wait for the SPA to render the usage tab; ignore timeout — parser decides what it sees.
  await page
    .waitForSelector(SELECTORS.usageReady, { timeout: HYDRATION_TIMEOUT_MS, state: 'attached' })
    .catch(() => undefined);
  await page.waitForTimeout(1500); // numbers may populate after skeleton loaders

  const url = page.url();
  const title = await page.title().catch(() => '');
  const usageText = await dialogOrBodyText(page);
  let progressValues = await page
    .$$eval(`${SELECTORS.dialog} :is(${SELECTORS.progressBar})`, readProgressValues)
    .catch(() => [] as number[]);
  if (progressValues.length === 0) {
    progressValues = await page.$$eval(SELECTORS.progressBar, readProgressValues).catch(() => [] as number[]);
  }

  const data: PageData = { url, title, usageText, progressValues };

  if (opts.includeIdentity && !/\/login\b/.test(url)) {
    try {
      const btn = page.locator(SELECTORS.userMenuButton).first();
      data.userButtonText = await btn.innerText({ timeout: 3000 });
      // The settings modal covers the sidebar; close it first.
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(400);
      await btn.click({ timeout: 3000 });
      await page.waitForTimeout(800);
      data.userMenuText = await page
        .evaluate((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel)).map((e) => e.innerText).join('\n'), SELECTORS.userMenu)
        .catch(() => '');
      await page.keyboard.press('Escape').catch(() => undefined);
    } catch {
      /* identity is optional */
    }
  }
  return data;
}

/** Full read: navigate + collect + parse. */
export async function extractUsage(page: Page, opts: CollectOptions = {}): Promise<ParseResult> {
  const data = await collectPageData(page, opts);
  return parseUsage(data);
}

/** Maps a thrown Playwright/network error to a UsageErrorKind. */
export function classifyError(err: unknown): { error: UsageErrorKind; detail: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const short = msg.split('\n')[0].slice(0, 200);
  if (/net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Timeout \d+ms exceeded|navigation timeout/i.test(msg)) {
    return { error: 'network', detail: short };
  }
  if (/Executable doesn't exist|Failed to launch|Chromium revision|No Chromium-based browser/i.test(msg)) {
    return { error: 'no_browser', detail: short };
  }
  if (/already in use|profile.*locked|SingletonLock|browser has been closed|Target closed|Target page, context or browser has been closed|exitCode=21/i.test(msg)) {
    return { error: 'browser_busy', detail: 'Browser profile is in use by another window' };
  }
  return { error: 'unavailable', detail: short };
}
