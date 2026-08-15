import { describe, expect, it } from 'vitest';
import {
  effectivePercent,
  formatAgo,
  formatRemaining,
  recommendAccount,
  statusForPercent,
  statusLabel,
} from '../src/shared/status';
import type { AccountState, UsageSnapshot } from '../src/shared/types';

function snap(partial: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    sessionPercent: null,
    weeklyPercent: null,
    modelWeeklyPercent: null,
    modelWeeklyLabel: null,
    planName: null,
    displayName: null,
    sessionResetText: null,
    sessionResetAt: null,
    weeklyResetText: null,
    weeklyResetAt: null,
    email: null,
    capturedAt: 0,
    ...partial,
  };
}

function account(id: 1 | 2 | 3, usage: UsageSnapshot | null, error: AccountState['error'] = null): AccountState {
  return {
    id,
    name: `Account ${id}`,
    readState: error ? 'error' : 'ok',
    usage,
    error,
    errorDetail: null,
    hasProfile: true,
    loginInProgress: false,
    windowOpen: false,
    terminal: null,
    terminalBusy: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
  };
}

describe('statusForPercent', () => {
  it('follows the 0-49 / 50-79 / 80-94 / 95-100 rules', () => {
    expect(statusForPercent(0)).toBe('available');
    expect(statusForPercent(49)).toBe('available');
    expect(statusForPercent(49.9)).toBe('available');
    expect(statusForPercent(50)).toBe('medium');
    expect(statusForPercent(79)).toBe('medium');
    expect(statusForPercent(80)).toBe('high');
    expect(statusForPercent(94)).toBe('high');
    expect(statusForPercent(95)).toBe('near_limit');
    expect(statusForPercent(100)).toBe('near_limit');
  });

  it('has labels', () => {
    expect(statusLabel('available')).toBe('AVAILABLE');
    expect(statusLabel('near_limit')).toBe('NEAR LIMIT');
  });
});

describe('effectivePercent', () => {
  it('uses the highest known percentage', () => {
    expect(effectivePercent(account(1, snap({ sessionPercent: 20, weeklyPercent: 60 })))).toBe(60);
    expect(effectivePercent(account(1, snap({ sessionPercent: 90, weeklyPercent: 10, modelWeeklyPercent: 95 })))).toBe(95);
  });
  it('returns null with no data', () => {
    expect(effectivePercent(account(1, null))).toBeNull();
    expect(effectivePercent(account(1, snap({})))).toBeNull();
  });
});

describe('recommendAccount', () => {
  it('picks the account with the most capacity', () => {
    const rec = recommendAccount([
      account(1, snap({ sessionPercent: 28, weeklyPercent: 41 })),
      account(2, snap({ sessionPercent: 70, weeklyPercent: 75 })),
      account(3, snap({ sessionPercent: 95, weeklyPercent: 91 })),
    ]);
    expect(rec?.id).toBe(1);
  });

  it('ignores accounts with errors or no data', () => {
    const rec = recommendAccount([
      account(1, snap({ sessionPercent: 5 }), 'login_required'),
      account(2, null),
      account(3, snap({ sessionPercent: 95, weeklyPercent: 91 })),
    ]);
    expect(rec?.id).toBe(3);
  });

  it('returns null when nothing is readable', () => {
    expect(recommendAccount([account(1, null, 'network'), account(2, null), account(3, null)])).toBeNull();
  });

  it('breaks ties by weekly usage then id', () => {
    const rec = recommendAccount([
      account(1, snap({ sessionPercent: 50, weeklyPercent: 40 })),
      account(2, snap({ sessionPercent: 50, weeklyPercent: 20 })),
    ]);
    expect(rec?.id).toBe(2);
    const rec2 = recommendAccount([
      account(3, snap({ sessionPercent: 50, weeklyPercent: 20 })),
      account(1, snap({ sessionPercent: 50, weeklyPercent: 20 })),
    ]);
    expect(rec2?.id).toBe(1);
  });
});

describe('formatting', () => {
  it('formats remaining time', () => {
    const now = 1_000_000_000_000;
    expect(formatRemaining(now + (3 * 60 + 12) * 60_000, now)).toBe('3h 12m');
    expect(formatRemaining(now + 12 * 60_000, now)).toBe('12m');
    expect(formatRemaining(now + 30_000, now)).toBe('<1m');
    expect(formatRemaining(now - 1, now)).toBe('now');
    expect(formatRemaining(now + 26 * 3_600_000, now)).toBe('1d 2h');
  });
  it('formats ago', () => {
    const now = 1_000_000_000_000;
    expect(formatAgo(now, now)).toBe('just now');
    expect(formatAgo(now - 45_000, now)).toBe('45s ago');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAgo(now - 90 * 60_000, now)).toBe('1h 30m ago');
  });
});
