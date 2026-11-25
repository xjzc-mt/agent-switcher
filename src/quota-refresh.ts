import type { StatusResult } from './agents/base';
import type { LiveRefreshInterval, SpareRefreshInterval } from './settings';

export const MIN_REFRESH_INTERVAL_MS = 30000;
export type RefreshInterval = LiveRefreshInterval | SpareRefreshInterval;

export const refreshPeriodMs: Record<RefreshInterval, number> = {
  '1m': 60000, '3m': 180000, '5m': 300000,
  '15m': 900000, '30m': 1800000, manual: Infinity,
};

/** Shared by the query cache and the desktop timer. */
export function quotaRefreshAt(status: StatusResult | undefined, interval: RefreshInterval = '5m', now = Date.now()): number {
  if (interval === 'manual' || ['expired', 'unsupported', 'signed-out'].includes(status?.state || '')) return Infinity;
  if (!status?.checkedAt) return now;
  const checked = Date.parse(status.checkedAt);
  if (!Number.isFinite(checked)) return now;
  const period = refreshPeriodMs[interval];
  if (status.state === 'error') {
    const backoff = [120000, 300000, 900000];
    return checked + Math.max(period, backoff[Math.min(Math.max((status.refreshFailures || 1) - 1, 0), 2)]);
  }
  let deadline = checked + period;
  for (const window of [status.quota?.primaryWindow, status.quota?.secondaryWindow, ...(status.quota?.buckets || []).flatMap(bucket => bucket.windows)]) {
    if (!window?.resetsAt) continue;
    const afterReset = window.resetsAt * 1000 + 10000;
    if (afterReset > checked) deadline = Math.min(deadline, afterReset);
  }
  return Math.max(deadline, checked + MIN_REFRESH_INTERVAL_MS);
}
