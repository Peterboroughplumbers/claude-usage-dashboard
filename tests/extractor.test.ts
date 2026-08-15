import { describe, expect, it } from 'vitest';
import {
  classifyError,
  parseClockReset,
  parseRelativeReset,
  parseUsage,
  type PageData,
} from '../src/main/usage/extractor';

const NOW = new Date(2026, 7, 14, 22, 0, 0).getTime(); // Fri Aug 14 2026, 22:00 local

function page(usageText: string, extra: Partial<PageData> = {}): PageData {
  return {
    url: 'https://claude.ai/new#settings/usage',
    title: 'New chat - Claude',
    usageText,
    progressValues: [],
    now: NOW,
    ...extra,
  };
}

/** Verbatim structure of the settings modal as observed in Aug 2026 (fresh account). */
const REAL_PAGE_IDLE = `Settings

Settings

General

Account

Privacy

Billing

Usage

Capabilities

Claude Code

Cowork

Claude in Chrome
Customize

Skills

Connectors

Plugins

Plan usage limits
Max (20x)
Current session
Starts when a message is sent
0% used
Weekly limits

Fable 5 is still included with your Max plan.
If you see a prompt to set up usage credits for it, restart Claude Code.
Learn more about usage limits
All models
Starts when a message is sent
0% used
Fable
You haven’t used Fable yet
0% used
Last updated: just now

Usage credits
Turn on usage credits to keep using Claude if you hit a plan limit. Learn more`;

/** Same layout with an active session and non-zero numbers. */
const REAL_PAGE_ACTIVE = `Settings
Usage
Plan usage limits
Max (20x)
Current session
Resets in 3 hr 12 min
28% used
Weekly limits
All models
Resets Thu 12:00 PM
41% used
Fable
Resets Thu 12:00 PM
15% used
Last updated: 2 minutes ago

Usage credits`;

/** Older layout with a Sonnet-only sub-limit. */
const OLDER_PAGE = `Usage
Current session
Resets in 45 minutes
70% used
Weekly limits
All models
75% used
Resets Mon 9:00 AM
Sonnet only
33% used
Resets Mon 9:00 AM`;

describe('parseUsage', () => {
  it('reads the real idle page (0% everywhere) without inventing data', () => {
    const r = parseUsage(page(REAL_PAGE_IDLE, { progressValues: [0, 0, 0] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage.sessionPercent).toBe(0);
    expect(r.usage.weeklyPercent).toBe(0);
    expect(r.usage.modelWeeklyPercent).toBe(0);
    expect(r.usage.modelWeeklyLabel).toBe('Fable');
    expect(r.usage.planName).toBe('Max (20x)');
    expect(r.usage.sessionResetText).toBeNull();
    expect(r.usage.sessionResetAt).toBeNull();
    expect(r.usage.weeklyResetText).toBeNull();
    expect(r.usage.email).toBeNull();
    expect(r.usage.displayName).toBeNull();
  });

  it('reads the active page with resets', () => {
    const r = parseUsage(page(REAL_PAGE_ACTIVE));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage.sessionPercent).toBe(28);
    expect(r.usage.weeklyPercent).toBe(41);
    expect(r.usage.modelWeeklyPercent).toBe(15);
    expect(r.usage.modelWeeklyLabel).toBe('Fable');
    expect(r.usage.sessionResetText).toBe('Resets in 3 hr 12 min');
    expect(r.usage.sessionResetAt).toBe(NOW + (3 * 60 + 12) * 60_000);
    expect(r.usage.weeklyResetText).toBe('Resets Thu 12:00 PM');
    // Next Thursday 12:00 after Fri Aug 14 22:00 -> Thu Aug 20 12:00
    expect(r.usage.weeklyResetAt).toBe(new Date(2026, 7, 20, 12, 0, 0).getTime());
  });

  it('reads the older layout with a Sonnet-only sub-limit', () => {
    const r = parseUsage(page(OLDER_PAGE));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage.sessionPercent).toBe(70);
    expect(r.usage.weeklyPercent).toBe(75);
    expect(r.usage.modelWeeklyLabel).toBe('Sonnet');
    expect(r.usage.modelWeeklyPercent).toBe(33);
    expect(r.usage.sessionResetAt).toBe(NOW + 45 * 60_000);
    expect(r.usage.planName).toBeNull();
  });

  it('extracts identity from the user menu button and popover', () => {
    const r = parseUsage(
      page(REAL_PAGE_IDLE, {
        userButtonText: 'P\nPeterborough\n·\nMax\n',
        userMenuText: 'Me@Example.com\n\nSettings\nCtrl\n+\n⇧\n+\n,\nLog out',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage.email).toBe('me@example.com');
    expect(r.usage.displayName).toBe('Peterborough');
    expect(r.usage.planName).toBe('Max (20x)'); // page value wins over button plan
  });

  it('does not fabricate missing sections', () => {
    const r = parseUsage(page('Usage\nCurrent session\n12% used\nResets in 2 hours'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage.sessionPercent).toBe(12);
    expect(r.usage.weeklyPercent).toBeNull();
    expect(r.usage.modelWeeklyPercent).toBeNull();
    expect(r.usage.modelWeeklyLabel).toBeNull();
    expect(r.usage.sessionResetAt).toBe(NOW + 2 * 3_600_000);
  });

  it('falls back to progress bars when the numbers are not in the text', () => {
    const r = parseUsage(page('Usage\nCurrent session\nResets in 1 hr\nWeekly limits\nAll models', { progressValues: [33, 66] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage.sessionPercent).toBe(33);
    expect(r.usage.weeklyPercent).toBe(66);
    expect(r.usage.modelWeeklyPercent).toBeNull();
  });

  it('detects login redirect', () => {
    const r = parseUsage(page('Log in to Claude\nContinue with Google', { url: 'https://claude.ai/login?returnTo=%2Fsettings%2Fusage' }));
    expect(r).toMatchObject({ ok: false, error: 'login_required' });
    const r2 = parseUsage(page('Question what’s next\nContinue with Google\nOR\nContinue with email'));
    expect(r2).toMatchObject({ ok: false, error: 'login_required' });
  });

  it('detects Cloudflare challenge pages as unavailable', () => {
    const r = parseUsage(
      page('claude.ai\nPerforming security verification\nThis website uses a security service to protect against malicious bots.', {
        title: 'Just a moment...',
        url: 'https://claude.ai/settings/usage',
      }),
    );
    expect(r).toMatchObject({ ok: false, error: 'unavailable' });
  });

  it('reports unreadable when the layout changed', () => {
    const r = parseUsage(page('Settings\nProfile\nBilling\nSome completely different content here'));
    expect(r).toMatchObject({ ok: false, error: 'unreadable' });
  });

  it('reports unavailable on error pages', () => {
    const r = parseUsage(page('Something went wrong\nPlease try again later, this is a longer text.'));
    expect(r).toMatchObject({ ok: false, error: 'unavailable' });
  });

  it('rejects out-of-range percentages', () => {
    const r = parseUsage(page('Current session\n250% used'));
    expect(r.ok).toBe(false);
  });
});

describe('parseRelativeReset', () => {
  it('parses various relative formats', () => {
    expect(parseRelativeReset('Resets in 3 hr 12 min', NOW)).toBe(NOW + 192 * 60_000);
    expect(parseRelativeReset('Resets in 45 minutes', NOW)).toBe(NOW + 45 * 60_000);
    expect(parseRelativeReset('Resets in 2 hours', NOW)).toBe(NOW + 120 * 60_000);
    expect(parseRelativeReset('Resets in 1 day 3 hr', NOW)).toBe(NOW + 27 * 3_600_000);
    expect(parseRelativeReset('Resets in 3h 12m', NOW)).toBe(NOW + 192 * 60_000);
  });
  it('returns null for absolute dates or garbage', () => {
    expect(parseRelativeReset('Resets Thu 12:00 PM', NOW)).toBeNull();
    expect(parseRelativeReset('Resets in a while', NOW)).toBeNull();
    expect(parseRelativeReset(null, NOW)).toBeNull();
  });
});

describe('parseClockReset', () => {
  it('resolves weekday + time to the next occurrence', () => {
    expect(parseClockReset('Resets Thu 12:00 PM', NOW)).toBe(new Date(2026, 7, 20, 12, 0).getTime());
    expect(parseClockReset('Resets Fri 9:00 AM', NOW)).toBe(new Date(2026, 7, 21, 9, 0).getTime()); // today already past 9am
    expect(parseClockReset('Resets Fri 11:30 PM', NOW)).toBe(new Date(2026, 7, 14, 23, 30).getTime()); // later today
  });
  it('resolves bare times to today/tomorrow', () => {
    expect(parseClockReset('Resets 11 PM', NOW)).toBe(new Date(2026, 7, 14, 23, 0).getTime());
    expect(parseClockReset('Resets 3:00 PM', NOW)).toBe(new Date(2026, 7, 15, 15, 0).getTime());
    expect(parseClockReset('Resets tomorrow 9:00 AM', NOW)).toBe(new Date(2026, 7, 15, 9, 0).getTime());
  });
  it('returns null for unrecognised text', () => {
    expect(parseClockReset('Starts when a message is sent', NOW)).toBeNull();
    expect(parseClockReset(null, NOW)).toBeNull();
  });
});

describe('classifyError', () => {
  it('maps network errors', () => {
    expect(classifyError(new Error('page.goto: net::ERR_INTERNET_DISCONNECTED at https://claude.ai')).error).toBe('network');
    expect(classifyError(new Error('page.goto: Timeout 45000ms exceeded.')).error).toBe('network');
  });
  it('maps missing browser', () => {
    expect(classifyError(new Error("browserType.launchPersistentContext: Executable doesn't exist at C:\\x")).error).toBe('no_browser');
    expect(classifyError(new Error('No Chromium-based browser found')).error).toBe('no_browser');
  });
  it('maps locked profile / closed targets to browser_busy', () => {
    expect(classifyError(new Error('Target page, context or browser has been closed')).error).toBe('browser_busy');
    expect(classifyError(new Error('browserType.launchPersistentContext: Target page, context or browser has been closed\n<process did exit: exitCode=21>')).error).toBe('browser_busy');
  });
  it('defaults to unavailable', () => {
    expect(classifyError(new Error('weird')).error).toBe('unavailable');
  });
});
