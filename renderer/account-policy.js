/* Shared quota decisions; cross-tier Pro amounts use an estimated tier weight. */
(function (root) {
  const windows = (status, agent = 'codex') => (agent === 'agy' && status?.quota?.buckets
    ? (status?.quota?.buckets || []).flatMap(bucket => bucket.windows) : [status?.quota?.primaryWindow, status?.quota?.secondaryWindow])
    .filter(w => w && Number.isFinite(w.usedPercent));
  const remaining = w => Math.max(0, Math.min(100, 100 - w.usedPercent));
  function modelBucket(status, model) {
    const name = model === 'gemini' ? /^gemini(?: models)?$/i : /^claude\s*(?:and|\/)\s*gpt(?: models)?$/i;
    return status?.quota?.buckets?.find(bucket => name.test(bucket.id) || name.test(bucket.label));
  }
  function comparisonStatus(status, agent) {
    if (agent !== 'agy') return status;
    // Keep other model limits available for refresh/detail, but compare Gemini only.
    return { ...status, quota: { buckets: [modelBucket(status, 'gemini')].filter(Boolean) } };
  }
  const plan = status => String(status?.plan || status?.quota?.plan || '未识别套餐').trim().toLowerCase();
  function planInfo(status, agent = 'codex') {
    const raw = plan(status);
    const normalized = raw.replace(/[\s·_$-]/g, '');
    if (agent !== 'codex') {
      const labels = { pro:'Pro', max:'Max', ultra:'Ultra', free:'Free', team:'Team', enterprise:'Enterprise' };
      const display = agent === 'agy' ? raw.replace(/^google ai (pro|ultra)$/, '$1') : raw;
      return { key:raw, label:labels[display] || (['unknown','未识别套餐'].includes(raw) ? '已保存账号' : (status?.plan || status?.quota?.plan || raw)), tier:'' };
    }
    // Official plan IDs distinguish Pro 100 (prolite), 200 (pro), and 500 (promax).
    // Keep explicit numeric labels compatible with imported snapshots.
    const proTiers = { prolite:'100', pro:'200', promax:'500' };
    if (Object.hasOwn(proTiers, normalized) || /^pro\d+$/.test(normalized)) {
      return { key:'pro', label:'Pro', tier: proTiers[normalized] || normalized.slice(3) };
    }
    const labels = { plus:'Plus', go:'Go', free:'Free', team:'Team', business:'Business', enterprise:'Enterprise', edu:'Edu', '未识别套餐':'套餐未知', unknown:'套餐未知' };
    return { key:raw, label:labels[raw] || raw, tier:'' };
  }
  function columns(status) {
    const ws = windows(status).sort((a, b) => (a.windowMins || 0) - (b.windowMins || 0));
    // A weekly-only/monthly-only account belongs in the long-window column.
    if (ws.length === 1 && ws[0].windowMins >= 1440) return [undefined, ws[0]];
    return [ws[0], ws[1]];
  }
  function quotaSlots(status, agent = 'codex') {
    if (agent === 'agy') return [...(modelBucket(status, 'gemini')?.windows || [])].sort((a,b) => (a.windowMins || Infinity) - (b.windowMins || Infinity));
    const ws = windows(status, agent).sort((a, b) => (a.windowMins || Infinity) - (b.windowMins || Infinity));
    if (agent !== 'codex' || planInfo(status, agent).key !== 'plus' || !ws.length) return ws;
    return columns(status).map((w, i) => w || { windowMins: i ? 10080 : 300 });
  }
  function invalidated(status, now = Date.now(), agent = 'codex') {
    const fetched = Date.parse(status?.fetchedAt);
    return !!status?.authExpired || status?.state !== 'ok' || !Number.isFinite(fetched) ||
      windows(status, agent).some(w => Number.isFinite(w.resetsAt) && w.resetsAt * 1000 <= now);
  }
  function stale(status, now = Date.now(), agent = 'codex') {
    return invalidated(status, now, agent) || now - Date.parse(status?.fetchedAt) > 300000;
  }
  function resetExpiryDays(summary, now = Date.now()) {
    // Compare local calendar dates, not elapsed hours (also stable across DST).
    const day = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
    const today = day(new Date(now));
    const days = (summary?.credits || [])
      .filter(c => c.status === 'available' && Number.isFinite(c.expiresAt) && c.expiresAt > 0)
      .map(c => day(new Date(c.expiresAt * 1000)) - today)
      .filter(n => Number.isFinite(n) && n >= 0);
    return days.length ? Math.min(...days) : null;
  }
  function health(status, now = Date.now(), agent = 'codex') {
    status = comparisonStatus(status, agent);
    if (status?.authExpired || ['expired', 'signed-out'].includes(status?.state)) return { rank: 4, label: '需要登录', kind: 'error' };
    if (status?.state === 'unsupported') return { rank: 3, label: '额度未提供', kind: 'unknown' };
    const ws = windows(status, agent);
    // Refresh age alone must not discard the last successful comparison or
    // reshuffle every account before a background refresh has returned.
    const incomplete = agent === 'agy' ? quotaSlots(status, agent).some(w => !Number.isFinite(w.usedPercent)) : agent === 'codex' && planInfo(status).key === 'plus' && columns(status).some(w => !w);
    if (invalidated(status, now, agent) || !ws.length || incomplete) return { rank: 3, label: status?.state === 'error' ? '刷新失败' : '待确认额度', kind: 'unknown' };
    const minimum = Math.min(...ws.map(remaining));
    const prefix = stale(status, now, agent) ? '上次查询：' : '';
    if (minimum <= 0) return { rank: 2, label: `${prefix}${agent === 'agy' ? 'Gemini 额度耗尽' : '订阅额度耗尽'}`, kind: 'blocked' };
    if (minimum <= 10) return { rank: 1, label: `${prefix}余额偏低`, kind: 'low' };
    return { rank: 0, label: `${prefix}已知额度可用`, kind: 'ready' };
  }
  function compare(a, b, now = Date.now(), agent = 'codex') {
    a = { ...a, status: comparisonStatus(a.status, agent) };
    b = { ...b, status: comparisonStatus(b.status, agent) };
    const byName = () => a.name.localeCompare(b.name, 'zh-CN');
    const ap = planInfo(a.status, agent), bp = planInfo(b.status, agent);
    const byPlan = ap.key.localeCompare(bp.key, 'zh-CN');
    if (byPlan) return byPlan;
    const arank = health(a.status, now, agent).rank, brank = health(b.status, now, agent).rank;
    // Known quotas share one bucket; low percentages must not override amount ordering.
    const bucket = rank => rank < 3 ? 0 : rank;
    const difference = bucket(arank) - bucket(brank);
    if (difference) return difference;
    if (arank >= 3) return byName();
    const headroom = status => Math.min(...windows(status, agent).map(remaining));
    if (agent === 'agy') {
      const amounts = status => {
        const ws = quotaSlots(status, agent), longer = ws.slice(1);
        return [headroom(status) > 0 ? remaining(ws[0]) : 0, longer.length ? Math.min(...longer.map(remaining)) : remaining(ws[0])];
      };
      const [acurrent, along] = amounts(a.status), [bcurrent, blong] = amounts(b.status);
      return bcurrent - acurrent || blong - along || byName();
    }
    if (agent === 'codex' && ap.key === 'plus') {
      const amounts = status => {
        const [short, long] = columns(status), weekly = remaining(long);
        return [weekly > 0 ? remaining(short) : 0, weekly];
      };
      const [acurrent, aweekly] = amounts(a.status), [bcurrent, bweekly] = amounts(b.status);
      return bcurrent - acurrent || bweekly - aweekly || byName();
    }
    if (agent === 'codex' && ap.key === 'pro') {
      // Prices identify tiers, not a server-provided absolute quota. Preserve any
      // additional limiting window if one is actually returned for this account.
      const amount = (status, info) => headroom(status) * Number(info.tier);
      return amount(b.status, bp) - amount(a.status, ap) || byName();
    }
    return headroom(b.status) - headroom(a.status) || byName();
  }
  const policy = { windows, remaining, modelBucket, plan, planInfo, columns, quotaSlots, invalidated, stale, resetExpiryDays, health, compare };
  if (typeof module !== 'undefined' && module.exports) module.exports = policy;
  else root.AccountPolicy = policy;
})(typeof globalThis === 'undefined' ? this : globalThis);
