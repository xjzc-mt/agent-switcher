import type { StatusResult } from './agents/base';

export const MIN_REFRESH_INTERVAL_MS = 30000;

/** Shared by the query cache and the desktop timer. */
export function quotaRefreshAt(status: StatusResult | undefined, isLive: boolean, now = Date.now()): number {
  if (['expired', 'unsupported', 'signed-out'].includes(status?.state || '')) return Infinity;
  if (!status?.checkedAt) return now;
  const checked = Date.parse(status.checkedAt);
  if (!Number.isFinite(checked)) return now;
  if (status.state === 'error') {
    const backoff = [120000, 300000, 900000];
    return checked + backoff[Math.min(Math.max((status.refreshFailures || 1) - 1, 0), 2)];
  }
  let deadline = checked + (isLive ? 60000 : 300000);
  for (const window of [status.quota?.primaryWindow, status.quota?.secondaryWindow, ...(status.quota?.buckets || []).flatMap(bucket => bucket.windows)]) {
    if (!window?.resetsAt) continue;
    const afterReset = window.resetsAt * 1000 + 10000;
    if (afterReset > checked) deadline = Math.min(deadline, afterReset);
  }
  return Math.max(deadline, checked + MIN_REFRESH_INTERVAL_MS);
}
