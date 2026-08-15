import type { AccountState, UsageStatus } from './types';

/**
 * Status rules:
 * 0-49%  = Available
 * 50-79% = Medium
 * 80-94% = High
 * 95-100% = Near Limit
 */
export function statusForPercent(percent: number): UsageStatus {
  if (percent >= 95) return 'near_limit';
  if (percent >= 80) return 'high';
  if (percent >= 50) return 'medium';
  return 'available';
}

export function statusLabel(status: UsageStatus): string {
  switch (status) {
    case 'available':
      return 'AVAILABLE';
    case 'medium':
      return 'MEDIUM';
    case 'high':
      return 'HIGH';
    case 'near_limit':
      return 'NEAR LIMIT';
  }
}

/**
 * The effective load of an account is the *highest* of its known percentages:
 * whichever limit is closest to being exhausted is the one that will block the user.
 * Returns null when no usage percentage is known.
 */
export function effectivePercent(account: AccountState): number | null {
  const u = account.usage;
  if (!u) return null;
  const values = [u.sessionPercent, u.weeklyPercent, u.modelWeeklyPercent].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (values.length === 0) return null;
  return Math.max(...values);
}

export function accountStatus(account: AccountState): UsageStatus | null {
  const p = effectivePercent(account);
  return p === null ? null : statusForPercent(p);
}

/**
 * Picks the account with the most available capacity.
 * Only accounts with a valid, non-error reading are eligible.
 * Ties are broken by lower weekly usage, then lower id.
 */
export function recommendAccount(accounts: AccountState[]): AccountState | null {
  const eligible = accounts.filter((a) => a.usage && a.error === null && effectivePercent(a) !== null);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, a) => {
    const pa = effectivePercent(a) as number;
    const pb = effectivePercent(best) as number;
    if (pa < pb) return a;
    if (pa > pb) return best;
    const wa = a.usage?.weeklyPercent ?? Infinity;
    const wb = best.usage?.weeklyPercent ?? Infinity;
    if (wa < wb) return a;
    if (wa > wb) return best;
    return a.id < best.id ? a : best;
  });
}

/** Formats a remaining duration as "3h 12m" (or "12m", "<1m", "now"). */
export function formatRemaining(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  if (diff <= 0) return 'now';
  const totalMinutes = Math.floor(diff / 60_000);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Formats "last updated" relative time. */
export function formatAgo(timestampMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - timestampMs);
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
