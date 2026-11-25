/* Shared quota decisions; cross-tier Pro amounts use an estimated tier weight. */
(function (root) {
  const windows = (status, agent = 'codex') => (agent === 'agy' && status?.quota?.buckets
    ? (status?.quota?.buckets || []).flatMap(bucket => bucket.windows) : [status?.quota?.primaryWindow, status?.quota?.secondaryWindow])
    .filter(w => w && Number.isFinite(w.usedPercent));
  const remaining = w => Math.max(0, Math.min(100, 100 - w.usedPercent));
  function resetText(timestamp, countdown = false) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
    if (!countdown) return new Date(timestamp * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const diff = timestamp * 1000 - Date.now();
    if (diff <= 0) return '待刷新';
    const totalMins = Math.ceil(diff / 60000);
    if (totalMins < 60) return `${totalMins}分`;
    const days = Math.floor(totalMins / 1440);
    const remMins = totalMins % 1440;
    const hours = Math.floor(remMins / 60);
    if (days >= 1) {
      return hours > 0 ? `${days}天${hours}时` : `${days}天`;
    }
    const mins = remMins % 60;
    return mins > 0 ? `${hours}时${String(mins).padStart(2,'0')}分` : `${hours}时`;
  }
  function modelBucket(status, model) {
    const name = model === 'gemini' ? /^gemini(?: models)?$/i : /^claude\s*(?:and|\/)\s*gpt(?: models)?$/i;
    return status?.quota?.buckets?.find(bucket => name.test(bucket.id) || name.test(bucket.label));
  }
  const plan = status => String(status?.plan || status?.quota?.plan || '未识别套餐').trim().toLowerCase();
  function planInfo(status, agent = 'codex') {
    const raw = plan(status);
    // Double-underscore keys are reserved for groups that do not represent a plan.
    const key = raw.startsWith('__') ? '_' + raw : raw;
    const normalized = raw.replace(/[\s·_$-]/g, '');
    if (agent === 'agy') {
      const ultra = /^google ai ultra (5×|20×)$/.exec(raw);
      if (ultra) return { key:raw, label:`Ultra ${ultra[1]}`, tier:'' };
      const labels = { pro:'Pro', ultra:'Ultra', free:'Free', team:'Team', enterprise:'Enterprise' };
      const display = raw.replace(/^google ai (pro|ultra)$/, '$1');
      return { key, label:labels[display] || (['unknown','未识别套餐'].includes(raw) ? '已保存账号' : (status?.plan || status?.quota?.plan || raw)), tier:'' };
    }
    // Official plan IDs distinguish Pro 100 (prolite), 200 (pro), and 500 (promax).
    // Keep explicit numeric labels compatible with imported snapshots.
    const proTiers = { prolite:'100', pro:'200', promax:'500' };
    if (Object.hasOwn(proTiers, normalized) || /^pro\d+$/.test(normalized)) {
      return { key:'pro', label:'Pro', tier: proTiers[normalized] || normalized.slice(3) };
    }
    const labels = { plus:'Plus', go:'Go', free:'Free', team:'Team', business:'Business', enterprise:'Enterprise', edu:'Edu', '未识别套餐':'套餐未知', unknown:'套餐未知' };
    return { key, label:labels[raw] || raw, tier:'' };
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
  function invalidated(status, now = Date.now(), agent = 'codex', samples = windows(status, agent)) {
    const fetched = Date.parse(status?.fetchedAt);
    return !!status?.authExpired || status?.state !== 'ok' || !Number.isFinite(fetched) ||
      samples.some(w => Number.isFinite(w.resetsAt) && w.resetsAt * 1000 <= now);
  }
  function stale(status, now = Date.now(), agent = 'codex', interval = '5m') {
    const minutes = { '15m': 16, '30m': 31, manual: 30 }[interval] ?? 5;
    return invalidated(status, now, agent) || now - Date.parse(status?.fetchedAt) > minutes * 60000;
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
  function needsCredentialUpdate(status) {
    return !!status?.authExpired || status?.state === 'expired' || !!status?.stagedReplacement ||
      (status?.state === 'error' && ['authentication-rejected','account-unavailable','quota-recovery-required'].includes(status.authFailure));
  }
  function quotaConfirmed(status, now = Date.now(), agent = 'codex', slots = quotaSlots(status, agent)) {
    return status?.available !== false && !status?.stagedReplacement && !invalidated(status, now, agent, slots) &&
      slots.length > 0 && slots.every(w => Number.isFinite(w.usedPercent));
  }
  function compare(a, b, now = Date.now(), agent = 'codex') {
    const byName = () => a.name.localeCompare(b.name, 'zh-CN');
    const ap = planInfo(a.status, agent), bp = planInfo(b.status, agent);
    const byPlan = ap.key.localeCompare(bp.key, 'zh-CN');
    if (byPlan) return byPlan;
    const left = quotaSlots(a.status, agent), right = quotaSlots(b.status, agent);
    const aConfirmed = quotaConfirmed(a.status, now, agent, left), bConfirmed = quotaConfirmed(b.status, now, agent, right);
    if (aConfirmed !== bConfirmed) return aConfirmed ? -1 : 1;
    if (!aConfirmed) return byName();
    const headroom = slots => Math.min(...slots.map(remaining));
    if (agent === 'agy' || (agent === 'codex' && ap.key === 'plus')) {
      const amounts = slots => {
        const short = remaining(slots[0]);
        const long = slots.length > 1 ? headroom(slots.slice(1)) : short;
        return [long > 0 ? short : 0, long];
      };
      const [acurrent, aweekly] = amounts(left), [bcurrent, bweekly] = amounts(right);
      return bcurrent - acurrent || bweekly - aweekly || byName();
    }
    if (agent === 'codex' && ap.key === 'pro') {
      // Prices identify tiers, not a server-provided absolute quota. Preserve any
      // additional limiting window if one is actually returned for this account.
      return headroom(right) * Number(bp.tier) - headroom(left) * Number(ap.tier) || byName();
    }
    return headroom(right) - headroom(left) || byName();
  }
  const policy = { windows, remaining, resetText, modelBucket, plan, planInfo, columns, quotaSlots, invalidated, stale, resetExpiryDays, needsCredentialUpdate, quotaConfirmed, compare };
  if (typeof module !== 'undefined' && module.exports) module.exports = policy;
  else root.AccountPolicy = policy;
})(typeof globalThis === 'undefined' ? this : globalThis);
