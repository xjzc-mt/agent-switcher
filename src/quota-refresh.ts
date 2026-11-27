import { createHash } from 'node:crypto';
import type { QuotaWindow, StatusResult } from './agents/base';
import type { LiveRefreshInterval, SpareRefreshInterval } from './settings';

export const MIN_REFRESH_INTERVAL_MS = 30000;
export type RefreshInterval = LiveRefreshInterval | SpareRefreshInterval;

export const refreshPeriodMs: Record<RefreshInterval, number> = {
  '1m': 60000, '3m': 180000, '5m': 300000,
  '15m': 900000, '30m': 1800000, manual: Infinity,
};

function quotaWindows(status?: StatusResult) {
  const windows = new Map<string, QuotaWindow>();
  function add(key: string, window?: QuotaWindow) {
    if (!window || !Number.isFinite(window.usedPercent)) return;
    const period = key + '/' + (window.windowMins ?? '');
    let slot = period;
    for (let i = 2; windows.has(slot); i++) slot = period + '/' + i;
    windows.set(slot, window);
  }
  const quota = status?.quota;
  add('primary', quota?.primaryWindow);
  add('secondary', quota?.secondaryWindow);
  for (const bucket of quota?.buckets || []) for (const window of bucket.windows) add('bucket/' + bucket.id, window);
  return windows;
}

export function spareQuotaActivity(previous: StatusResult | undefined, current: StatusResult) {
  if (previous?.state !== 'ok' || !previous.checkedAt) return;
  const before = quotaWindows(previous), after = quotaWindows(current);
  let unchanged = after.size > 0 && after.size === before.size;
  for (const [key, window] of after) {
    const old = before.get(key);
    const reset = (old?.resetsAt ?? 0) * 1000;
    if (old && !(Date.parse(previous.checkedAt) < reset && reset <= Date.now())) {
      if (window.usedPercent > old.usedPercent) return { activeRounds: 2, unchangedRounds: 0 };
      if (window.usedPercent === old.usedPercent) continue;
    }
    unchanged = false;
  }
  const activeRounds = Math.max(0, (previous.spareActivity?.activeRounds || 0) - 1);
  if (unchanged || activeRounds) return { activeRounds,
    unchangedRounds: unchanged ? Math.min(3, (previous.spareActivity?.unchangedRounds || 0) + 1) : 0 };
}

/** The timer, panel-open hint and query cache use the same identity and observation. */
export function quotaRefreshTimes(status: StatusResult | undefined, interval: RefreshInterval, identity: string, spare: boolean, now = Date.now()) {
  if (interval === 'manual' || status?.available === false || ['expired', 'unsupported', 'signed-out'].includes(status?.state || '')) {
    return { refreshAt: Infinity, hotRefreshAt: Infinity };
  }
  const checked = Date.parse(status?.checkedAt || '');
  if (!status || !Number.isFinite(checked)) return { refreshAt: now, hotRefreshAt: status?.stagedReplacement ? Infinity : now };
  const period = refreshPeriodMs[interval];
  const fraction = createHash('sha256').update(JSON.stringify([identity, checked])).digest().readUInt32BE(0) / 0xffffffff;
  const windows = [...quotaWindows(status).values()];
  const floor = checked + (interval === '1m' ? 52000 : MIN_REFRESH_INTERVAL_MS);
  const exhausted = spare && (status.state === 'ok' || status.state === 'error')
    ? windows.filter(w => w.usedPercent >= 100 && (w.resetsAt || 0) * 1000 > checked) : [];
  const reset = Math.min(...exhausted.map(w => w.resetsAt! * 1000));
  const wake = Number.isFinite(reset) ? Math.max(floor, reset + 8000 + Math.round(17000 * fraction)) : 0;
  if (status.state === 'error' || wake) {
    const backoff = [120000, 300000, 900000];
    const retry = status.state === 'error' ? checked + Math.max(period, backoff[Math.min(Math.max((status.refreshFailures || 1) - 1, 0), 2)]) : 0;
    const refreshAt = Math.max(retry, wake);
    return { refreshAt, hotRefreshAt: now < wake ? Infinity : refreshAt };
  }
  const activity = spare && status.state === 'ok' ? status.spareActivity : undefined;
  let base = period, ceiling = Infinity;
  if (activity?.activeRounds) base = Math.max(300000, period / 2);
  else if (activity && activity.unchangedRounds >= 3) {
    ceiling = refreshPeriodMs['30m'];
    base = Math.min(ceiling, period * 2);
  }
  let refreshAt = checked + Math.min(ceiling, Math.round(base * (0.88 + 0.27 * fraction)));
  for (const window of windows) {
    const afterReset = (window.resetsAt || 0) * 1000 + 10000;
    if (window.resetsAt && afterReset > checked) refreshAt = Math.min(refreshAt, afterReset);
  }
  refreshAt = Math.max(floor, refreshAt);
  const lastSuccess = Date.parse(status.fetchedAt || '') || checked;
  const hotRefreshAt = status.state === 'ok' ? Math.max(floor, lastSuccess + Math.min(period, 120000) + 1) : refreshAt;
  return { refreshAt, hotRefreshAt: status.stagedReplacement ? Infinity : hotRefreshAt };
}
