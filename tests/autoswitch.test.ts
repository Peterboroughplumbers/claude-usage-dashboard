import { describe, expect, it } from 'vitest';
import { buildAccountsFile } from '../src/main/autoswitch';
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
    email: 'someone@example.com',
    capturedAt: 1_000,
    ...partial,
  };
}

function account(
  id: number,
  usage: UsageSnapshot | null,
  extra: Partial<AccountState> = {},
): AccountState {
  return {
    id,
    name: `Account ${id}`,
    readState: 'ok',
    usage,
    error: null,
    errorDetail: null,
    hasProfile: true,
    loginInProgress: false,
    autoLinkNote: null,
    windowOpen: false,
    terminal: null,
    terminalBusy: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    ...extra,
  };
}

const opts = { autoSwitch: true, claudePath: 'C:\\bin\\claude.exe', now: 123, configDirFor: (id: number) => `/cfg/account-${id}` };

describe('buildAccountsFile', () => {
  it('mirrors dashboard numbers, recommendation and CLI sign-in state', () => {
    const accounts = [
      account(1, snap({ sessionPercent: 100, weeklyPercent: 40, sessionResetAt: 5 }), {
        terminal: { loggedIn: true, email: 'a@x', subscription: 'max' },
      }),
      account(2, snap({ sessionPercent: 10, weeklyPercent: 20, modelWeeklyPercent: 55 }), {
        terminal: { loggedIn: false, email: null, subscription: null },
      }),
      account(3, null, { error: 'login_required', readState: 'error' }),
    ];
    const f = buildAccountsFile(accounts, opts);
    expect(f.version).toBe(1);
    expect(f.updatedAt).toBe(123);
    expect(f.autoSwitch).toBe(true);
    expect(f.claudePath).toBe('C:\\bin\\claude.exe');
    // account 2 has the lowest effective usage (55) vs account 1 (100); account 3 is unreadable.
    expect(f.recommendedId).toBe(2);
    expect(f.accounts.map((a) => a.id)).toEqual([1, 2, 3]);
    expect(f.accounts[0]).toMatchObject({
      name: 'Account 1',
      configDir: '/cfg/account-1',
      claudeCodeLoggedIn: true,
      sessionPercent: 100,
      weeklyPercent: 40,
      effectivePercent: 100,
      sessionResetAt: 5,
      usageCapturedAt: 1_000,
      error: null,
    });
    expect(f.accounts[1]).toMatchObject({ claudeCodeLoggedIn: false, effectivePercent: 55, modelWeeklyPercent: 55 });
    expect(f.accounts[2]).toMatchObject({
      claudeCodeLoggedIn: null,
      sessionPercent: null,
      effectivePercent: null,
      usageCapturedAt: null,
      error: 'login_required',
    });
  });

  it('never includes e-mail addresses or tokens', () => {
    const f = buildAccountsFile([account(1, snap({ sessionPercent: 1 }), { terminal: { loggedIn: true, email: 'a@x', subscription: null } })], opts);
    const json = JSON.stringify(f);
    expect(json).not.toContain('someone@example.com');
    expect(json).not.toContain('a@x');
  });

  it('reports no recommendation and the off switch when nothing is readable', () => {
    const f = buildAccountsFile([account(1, null, { error: 'network', readState: 'error' })], { ...opts, autoSwitch: false, claudePath: null });
    expect(f.recommendedId).toBeNull();
    expect(f.autoSwitch).toBe(false);
    expect(f.claudePath).toBeNull();
  });
});

describe('buildAccountsFile switchStrategy', () => {
  const a = account(1, snap({ sessionPercent: 10 }));
  it("defaults to 'most-capacity'", () => {
    expect(buildAccountsFile([a], opts).switchStrategy).toBe('most-capacity');
  });
  it('passes through soonest-reset', () => {
    expect(buildAccountsFile([a], { ...opts, switchStrategy: 'soonest-reset' }).switchStrategy).toBe('soonest-reset');
  });
  it('sanitizes unknown values to most-capacity', () => {
    // @ts-expect-error deliberately wrong
    expect(buildAccountsFile([a], { ...opts, switchStrategy: 'bogus' }).switchStrategy).toBe('most-capacity');
  });
})
