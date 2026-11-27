const DEFAULT_AGENTS = [
  { id: 'codex', label: 'Codex' },
  { id: 'agy', label: 'Antigravity' },
];

let currentTab = 'codex';
let lastAgentTab = 'codex';
let agentsData = [];
// Start local-only until the user's saved refresh preference is available.
let settings = { showResetTimes: true, openPrivateLogin: true, liveRefreshInterval: 'manual', spareRefreshInterval: 'manual' };
let appUpdateState = { currentVersion: '', status: 'idle', autoCheck: true };
let appUpdateRevision = 0, appUpdateFeedback = '', appUpdateFeedbackError = false;
const appUpdatePending = new Set();
let accountLayout = readLayout('accountLayout', 'cards') === 'rows' ? 'rows' : 'cards';
let inputModality = 'pointer';
const exportSelection = new Set();
let selecting = false, filter = '';
let loading;
const refreshBatches = new Map();
let switchingAccount = false;
const refreshFailedAt = new Map();
let activeDialog = newAccountDialog(0);
function newAccountDialog(generation) {
  return { generation, tab:'local', loginMode:'open', login:{} };
}
let quotaRefreshTimer;
let quotaPaused, quotaInitialized = false, initialOpenPlatform;
let statusRetryAt = 0;
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const stateLabels = { ok: '查询成功', error: '查询失败', expired: '凭据失效', unsupported: '暂不支持', unverified: '尚未查询', 'signed-out': '未检测到凭据' };
const time = date => date ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '尚未查询';
function windows(status) {
  return AccountPolicy.windows(status, currentTab).sort((a,b) => (a.windowMins || Infinity) - (b.windowMins || Infinity));
}
function quotaWindowLabel(w) {
  const minutes = w.windowMins;
  if (!minutes) return '周期未知';
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
function creditInfo(status, current = false) {
  const credits = status?.quota?.credits;
  if (!credits) return null;
  const raw = credits.balance == null ? '' : String(credits.balance).replace(/,/g,'').trim();
  const amount = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const balance = credits.unlimited ? '∞' : amount !== null ? (Math.abs(amount)>0 && Math.abs(amount)<.01 ? new Intl.NumberFormat('en-US',{maximumSignificantDigits:2}).format(amount) : amount.toLocaleString('en-US',{maximumFractionDigits:2})) : credits.hasCredits === false ? '0' : '—';
  const available = credits.unlimited === true || (amount !== null ? amount !== 0 : credits.hasCredits === true);
  const recent = status.state === 'ok' && status.creditActivity && Date.now() - Date.parse(status.creditActivity.lastDecreaseAt) < 300000;
  const tooltipBalance = amount === null ? credits.hasCredits === false ? '0.00' : '余额未取得' : amount > 0 && amount < .01 ? '<0.01' : amount < 0 && amount > -.01 ? '>-0.01' : amount.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const title = `Credits ${credits.unlimited ? '不限额' : tooltipBalance}${stale(status, currentTab, current) ? '（缓存）' : ''}`;
  // Subscription-window resets do not invalidate a separately reported balance.
  const unconfirmed = AccountPolicy.invalidated({ ...status, quota: undefined });
  return { balance, title, available, negative:amount !== null && amount<0, recent, unconfirmed, unknown:amount===null && !credits.unlimited && credits.hasCredits!==false };
}
function creditBadge(status, current = false) {
  if (credentialsExpired(status)) return '';
  const c=creditInfo(status, current); if(!c || (!c.available && !c.unknown && !(current&&c.recent)))return '';
  return `<span class="credit-badge ${current?'current-credit-badge':''} ${c.negative?'negative':''} ${c.recent?'credit-spending':''} ${c.unconfirmed?'cached':''}" aria-label="${escapeHTML(c.title)}${c.recent?'；最近检测到余额下降':''}"><small>Credits</small><b data-tooltip-overflow data-tooltip="${escapeHTML(c.title)}">${escapeHTML(c.balance)}</b></span>`;
}
function creditCorner(status) {
  const c=creditInfo(status);if(!c?.available)return '';
  return `<span class="credit-corner ${c.negative?'negative':''} ${c.unconfirmed?'cached':''}" tabindex="0" role="img" data-tooltip-instant data-tooltip="${escapeHTML(c.title)}" aria-label="${escapeHTML(c.title)}"></span>`;
}
function resetTicket(agent,p,status) {
  if (credentialsExpired(status)) return '';
  const summary=status?.quota?.resetCredits,n=summary?.availableCount;if(!Number.isSafeInteger(n)||n<=0)return '';
  const days=AccountPolicy.resetExpiryDays(summary),expiring=days!==null&&days<=1;
  const expiry=days===null?'':days===0?' · 最近一张今天到期':days===1?' · 最近一张明天到期':` · 最近一张 ${days} 天后到期`;
  const tip=`重置卡 ${n} 张${stale(status, agent.id, !!(p?.isActive || p?.unsaved))?' · 缓存':''}${expiry}`;
  return `<button class="reset-ticket ${expiring?'expiring':''}" data-action="openResetCards" data-agent="${agent.id}" ${p?.name?`data-profile="${escapeHTML(p.name)}"`:''} data-tooltip-instant data-tooltip="${escapeHTML(tip)}" aria-label="${escapeHTML(tip)}">${icon('ticket')}<span>${n>99?'99+':n}</span></button>`;
}
function accountRefreshInterval(id, profile) {
  const agent = agentsData.find(a => a.id === id);
  const isLive = !profile || !!agent?.profiles.find(p => p.name === profile)?.isActive;
  return isLive ? settings.liveRefreshInterval : settings.spareRefreshInterval;
}
function stale(status, agent = currentTab, current = false) {
  return AccountPolicy.stale(status, Date.now(), agent, current ? settings.liveRefreshInterval : settings.spareRefreshInterval);
}
function credentialsExpired(status) { return !!status?.authExpired || status?.state === 'expired'; }
function planLabel(status, className='', agentId=currentTab, showOverflow=false) {
  const info=AccountPolicy.planInfo(status,agentId);
  const label = escapeHTML(info.tier ? `${info.label}·${info.tier}` : info.label);
  const tooltip = showOverflow ? ` data-tooltip-overflow data-tooltip="${label}"` : '';
  return `<span class="${className}"${tooltip}${info.tier?` data-plan-tier="${escapeHTML(info.tier)}"`:''}>${escapeHTML(info.label)}${info.tier?`<span aria-hidden="true">·</span>${escapeHTML(info.tier)}`:''}</span>`;
}
function canUpdateCredentials(profile, status) {
  return AccountPolicy.needsCredentialUpdate(status) || !!profile?.meta?.snapshot?.stagedReplacement;
}
function queryWarning(status) {
  if(status?.state!=='error'||!windows(status).length)return '';
  return `<span class="account-query-warning" role="img" aria-label="查询失败，显示上次额度" data-tooltip-instant data-tooltip="查询失败，暂显示上次额度；可右键刷新">${icon('warning')}</span>`;
}
function resetLabel(w) {
  const hasReset=Number.isFinite(w.resetsAt)&&w.resetsAt>0;
  return `<span class="quota-reset" data-tooltip="${escapeHTML(hasReset?`${quotaWindowLabel(w)} 重置：${time(w.resetsAt*1000)}`:'服务端未提供重置时间')}"><span class="reset-symbol" aria-hidden="true">↻</span>${hasReset?`<span class="${settings.showResetTimes?'reset-countdown':'reset-date'}">${escapeHTML(AccountPolicy.resetText(w.resetsAt, settings.showResetTimes))}</span>`:'<span>—</span>'}</span>`;
}
function quotaCell(w, status, model = '', current = false) {
  const label = `${model ? model+' · ' : ''}${quotaWindowLabel(w)}`;
  const tip = model ? ` data-tooltip="${escapeHTML(`${label} 剩余额度；${Number.isFinite(w.resetsAt)?'重置：'+time(w.resetsAt*1000):'重置时间未提供'}`)}"` : '';
  const view = AccountPolicy.quotaWindowView(w, AccountPolicy.queryInvalidated(status));
  if (view.remaining === undefined) return `<div class="quota-cell" aria-label="${escapeHTML(label)} 未提供"${tip}><div class="quota-cell-line"><span class="quota-label">${escapeHTML(quotaWindowLabel(w))}</span><strong class="quota-value"><span class="quota-number">${view.text}</span></strong><span class="quota-reset">未提供</span></div></div>`;
  return `<div class="quota-cell" data-tone="${view.tone}" aria-label="${escapeHTML(`${label} 剩余 ${view.text}${stale(status, currentTab, current)?'（上次查询）':''}`)}"${tip}>
    <div class="quota-cell-line"><span class="quota-label">${escapeHTML(quotaWindowLabel(w))}</span><strong class="quota-value"><span class="quota-number">${escapeHTML(view.text.slice(0,-1))}<small>%</small></span></strong>${resetLabel(w)}</div><progress class="quota-track" aria-hidden="true" value="${view.remaining}" max="100"></progress></div>`;
}
function quotaSummary(bucket, status, current) {
  const name = escapeHTML(bucket.label), compact = !current;
  return `<div class="quota-summary"><span class="quota-summary-name" data-tooltip="${name}"><span${compact?' class="model-name-full"':''}>${name}</span>${compact?'<span class="model-name-short" aria-label="Claude / GPT">C/G</span>':''}</span><div class="quota-summary-windows">${bucket.windows.length?bucket.windows.map(w=>quotaCell(w,status,bucket.label,current)).join(''):'<span class="quota-unavailable">未提供</span>'}</div></div>`;
}
function quotaCells(status, agent = 'codex', current = false, row = false) {
  const pro = agent === 'codex' && AccountPolicy.planInfo(status, agent).key === 'pro';
  const wrap = content => row ? `<div class="row-windows ${pro?'pro-windows':''}">${content}${pro?planLabel(status,'plan-tier',agent):''}</div>` : content;
  if(credentialsExpired(status))return wrap(`<span class="account-state auth-expired" data-tooltip-instant data-tooltip="请更新此账号的凭据">${icon('warning')}凭据失效</span>`);
  const ws=AccountPolicy.windows(status, agent);
  if(!ws.length&&status?.state==='error')return wrap(`<span class="account-state query-failed" data-tooltip-instant data-tooltip="${escapeHTML(status.extra||'暂时无法查询额度，请稍后重试')}">${icon('warning')}查询失败</span>`);
  if(!ws.length)return wrap(`<span class="quota-unavailable" data-tooltip="${escapeHTML(status?.extra||'刷新后查看额度')}">${escapeHTML(status?.state==='ok'?'额度未提供':stateLabels[status?.state]||'额度尚未查询')}</span>`);
  if (agent === 'agy') {
    const primary = AccountPolicy.modelBucket(status, 'gemini'), slots = AccountPolicy.quotaSlots(status, agent);
    const main = slots.length ? `<div class="quota-cells" data-window-count="${slots.length}">${slots.map(w=>quotaCell(w,status,primary.label,current)).join('')}</div>` : '<span class="quota-unavailable">Gemini 额度未取得</span>';
    const groups = current ? (status.quota?.buckets || []).filter(bucket=>bucket!==primary) : [AccountPolicy.modelBucket(status, 'claude')].filter(Boolean);
    const summary = groups.map(bucket=>quotaSummary(bucket,status,current)).join('');
    return current ? `<div class="model-quotas">${main}${summary?`<div class="model-quota-summaries">${summary}</div>`:''}</div>` : wrap(main)+summary;
  }
  const slots = AccountPolicy.quotaSlots(status, agent);
  return wrap(`<div class="quota-cells" data-window-count="${slots.length}">${slots.map(w=>quotaCell(w,status,'',current)).join('')}</div>`);
}
const ICON_PATHS = {
  // GitHub outline from lucide-static v0.468.0 (ISC).
  github: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  export: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 4v12m-4-4 4 4 4-4',
  delete: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6',
  restart: 'M4 4v5h5M20 20v-5h-5M4.6 9a8 8 0 0113.2-4M19.4 15a8 8 0 01-13.2 4',
  ticket: 'M4 5h16a1 1 0 0 1 1 1v3a3 3 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a3 3 0 0 0 0-6V6a1 1 0 0 1 1-1Zm8 0v2m0 4v2m0 4v2',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  rows: 'M3 5h18M3 12h18M3 19h18',
  warning: 'M12 8v5m0 3h.01M10.3 3.8 2.4 17.5A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.5L13.7 3.8a2 2 0 0 0-3.4 0Z',
  check: 'm6 12 4 4 8-8',
  close: 'm6 6 12 12M6 18 18 6',
  chevron: 'm9 5 7 7-7 7',
  up: 'M12 20V4m-7 7 7-7 7 7',
  down: 'M12 4v16m-7-7 7 7 7-7',
};
function icon(name) {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;
}
function button(action, label, agent, profile, cls = 'btn btn-sm', disabled = false) {
  return `<button class="${cls}" data-action="${action}" data-agent="${escapeHTML(agent || currentTab)}" ${profile !== undefined ? `data-profile="${escapeHTML(profile)}"` : ''} ${disabled ? 'disabled' : ''}>${label}</button>`;
}
let toastTimer, toastExitTimer;
const toastBox=$('toastBox');
function restoreToastLayer(dialog) {
  if(!dialog.contains(toastBox))return;
  const visible=toastBox.matches(':popover-open');
  toastBox.hidePopover();document.body.append(toastBox);
  if(visible)toastBox.showPopover();
}
document.addEventListener('close',event=>restoreToastLayer(event.target),true);
function showToast(message, type = 'ok') {
  clearTimeout(toastTimer);clearTimeout(toastExitTimer);
  const toast=document.createElement('div'),duration=type==='ok'?3000:6500;
  toast.className=`toast-item ${type}`;
  toast.setAttribute('role',type==='error'?'alert':'status');
  toast.setAttribute('aria-atomic','true');
  toast.innerHTML=`<span class="toast-symbol">${icon(type==='ok'?'check':'warning')}</span><span class="toast-message">${escapeHTML(message)}</span><button type="button" class="toast-close" aria-label="关闭提示">${icon('close')}</button>`;
  const dismiss=()=>{
    clearTimeout(toastTimer);toast.classList.add('leaving');
    toastExitTimer=setTimeout(()=>{toastBox.hidePopover();toastBox.replaceChildren();},120);
  };
  const schedule=()=>{clearTimeout(toastTimer);toastTimer=setTimeout(dismiss,duration);};
  toast.querySelector('button').addEventListener('click',dismiss);
  toast.addEventListener('pointerenter',()=>clearTimeout(toastTimer));
  toast.addEventListener('pointerleave',()=>{if(!toast.contains(document.activeElement))schedule();});
  toast.addEventListener('focusin',()=>clearTimeout(toastTimer));
  toast.addEventListener('focusout',()=>{if(!toast.matches(':hover'))schedule();});
  // A modal makes outside content inert. Keep its feedback inside the active dialog.
  const host=document.querySelector('dialog[open]:not([data-closing])')||document.body;
  if(toastBox.parentElement!==host){toastBox.hidePopover();host.append(toastBox);}
  toastBox.replaceChildren(toast);
  toastBox.showPopover();schedule();
}
function check(result) {
  if (result?.ok === false) throw new Error(result.error || '操作失败');
  return result;
}
function agentEnabled(id) { return DEFAULT_AGENTS.some(agent => agent.id === id); }
function platformOptions(list, selected) {
  return list.filter(a => agentEnabled(a.id)).map(a => `<option value="${escapeHTML(a.id)}" ${a.id === selected ? 'selected' : ''}>${escapeHTML(a.label)}</option>`).join('');
}
function selectTab(id) {
  if (id !== 'settings' && !agentEnabled(id)) return;
  if (id !== 'settings') lastAgentTab = id;
  currentTab = id; filter = ''; selecting = false; exportSelection.clear();
  document.querySelectorAll('.nav-item').forEach(el => {const active=el.id===`nav-${id}`;el.classList.toggle('active',active);if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  $('viewTitle').textContent = id === 'settings' ? '设置' : `${agentsData.find(a => a.id === id)?.label || id} 账号管理`;
  $('btnRefresh').hidden = id === 'settings';
  $('utilitySettings').dataset.agent = id === 'settings' ? lastAgentTab : 'settings';
  $('settingsLabel').textContent = id === 'settings' ? '返回账号' : '设置';
  $('utilitySettings').title = $('settingsLabel').textContent;
  $('utilitySettings').setAttribute('aria-label', $('settingsLabel').textContent);
  $('utilitySettings').classList.toggle('active',id==='settings');
  renderWorkbench();
  syncTray();
}
function profileStatus(agent, profile) { return profile?.isActive ? agent.status : profile?.meta?.snapshot; }
function hasIsolatedLogin(id) { return agentsData.find(a => a.id === id)?.management?.isolatedLogin ?? id === 'codex'; }
function hasQuota(agent) { return agent?.management?.quota ?? agent?.id === 'codex'; }
function canSaveLocal(agent) { return agent?.management?.canSaveCurrent ?? true; }
const knownPlan = status => status?.plan || status?.quota?.plan;
const profileKey = (id, name) => `${id}/${name}`;

function providerNotice(management) {
  const cli = management?.cliStatus;
  if (!cli || cli.state === 'ready') return management?.notice ? `<p class="provider-notice">${escapeHTML(management.notice)}</p>` : '';
  const missing = cli.state === 'missing';
  const message = missing ? '查看额度需安装官方 agy CLI。' : cli.state === 'outdated'
    ? `本机 agy CLI 版本过旧${cli.version ? `（当前 v${cli.version}）` : ''}，请运行 agy update 更新后查看额度。`
    : '未能确认本机 agy CLI 版本，请检查安装后重新检测。';
  return `<div class="provider-notice cli-notice"><span>${escapeHTML(message)}</span>
    ${missing ? button('openAntigravityInstall','查看官方安装说明','agy',undefined,'app-update-link') : ''}
    ${button('recheckAntigravityCli','重新检测','agy',undefined,'app-update-link')}</div>`;
}
function renderProviderCurrent(agent, current, status) {
  const title=current?.meta?.label||current?.name||(status.available?'已登录':status.state==='signed-out'?'尚未登录':'登录状态未确认');
  const managed=agent.management?.storage==='unified'||agent.management?.storage==='unknown';
  const account=status.account||current?.meta?.email|| (managed?'在官方客户端查看与切换账号':status.state==='error'?(status.extra||'暂时无法读取登录状态'):'未检测到登录账号');
  const action=agent.management?.loginLabel||'打开官方登录';
  const selectable=selecting&&current,checked=selectable&&exportSelection.has(profileKey(agent.id,current.name));
  const interaction=selectable?`data-account-context tabindex="0" data-action="toggleExport" role="button" aria-pressed="${!!checked}"`:status.available?'data-account-context tabindex="0" aria-haspopup="dialog" aria-keyshortcuts="Enter Shift+F10"':'';
  return `<section class="current-section"><div class="section-caption">${status.available?'当前使用':'客户端登录'}</div>
    <article class="active-session-card provider-session-card ${selectable?'selectable':''} ${checked?'is-selected':''}" ${interaction} data-agent="${agent.id}" data-profile="${escapeHTML(current?.name||'')}">
      <div class="session-card-header"><div class="session-meta-group"><div class="platform-logo-big">${agentLogo(agent.id, 'current')}</div>
        <div class="session-title-group"><div class="detail-title"><strong class="account-name">${escapeHTML(managed?'Antigravity':title)}</strong>${knownPlan(status)?planLabel(status,'current-plan',agent.id):''}</div><div class="session-account-line"><span class="session-account-email" data-tooltip-overflow data-tooltip="${escapeHTML(account)}">${escapeHTML(account)}</span></div></div></div>
        <div class="detail-header-actions">${selectable?`<span class="selection-check ${checked?'checked':''}" aria-hidden="true">${checked?'✓':''}</span>`:button('handleOfficialLogin',action,agent.id,undefined,'btn btn-sm')}${!selecting&&status.available&&!current&&canSaveLocal(agent)?button('openSaveModal','保存账号',agent.id):''}</div>
      </div>${providerNotice(agent.management)}
    </article></section>`;
}
function renderCurrentSectionHtml(agent, current, status, statusTip) {
  if (!hasQuota(agent)) return renderProviderCurrent(agent,current,status);
  if (!current && status.available) current = { name: '', meta: {label:'当前登录（未保存）'}, unsaved:true };
  if (current) {
    const account = status.account || current.meta?.email || '未检测到登录账号';
    const title = current.meta?.label || current.name || agent.label;
    const problem = status.state === 'error' && !credentialsExpired(status);
    const activeChecked = exportSelection.has(profileKey(agent.id, current.name));
    return `
      <section class="current-section"><div class="section-caption">当前使用</div>
      <article class="active-session-card ${selecting && !current.unsaved ? 'selectable' : ''} ${selecting && activeChecked ? 'is-selected' : ''}" data-account-context data-agent="${agent.id}" data-profile="${escapeHTML(current.name)}" tabindex="0" ${selecting && !current.unsaved ? `data-action="toggleExport" role="button" aria-pressed="${activeChecked}"` : 'aria-haspopup="dialog" aria-keyshortcuts="Enter Shift+F10"'} aria-label="当前使用账号 ${escapeHTML(title)}">
        <div class="session-card-header">
          <div class="session-meta-group"><div class="platform-logo-big">${agentLogo(agent.id, 'current')}</div><div class="session-title-group"><div class="detail-title"><strong class="account-name" data-tooltip-overflow data-tooltip="${escapeHTML(title)}">${escapeHTML(title)}</strong>${status.plan ? planLabel(status,'current-plan') : ''}${problem ? `<span class="pill-badge pill-query-error" title="${escapeHTML(statusTip)}">${escapeHTML(stateLabels[status.state])}</span>` : ''}</div><div class="session-account-line"><span class="session-account-email" data-tooltip-overflow data-tooltip="${escapeHTML(account)}">${escapeHTML(account)}</span></div></div></div>
          ${creditBadge(status,true)}<div class="detail-header-actions">${resetTicket(agent,current,status)}${current.unsaved ? button('openSaveModal', '保存当前账号', agent.id) : selecting ? `<span class="selection-check ${activeChecked ? 'checked' : ''}" aria-hidden="true">${activeChecked ? '✓' : ''}</span>` : `${canUpdateCredentials(current, status) ? button('openCredentialUpdate', '更新', agent.id, current.name) : !status.available ? button('reloginAccount', '登录', agent.id, current.name) : ''}${['codex', 'agy'].includes(agent.id) ? button('handleRestartClient', `${icon('restart')} 重启客户端`, agent.id, undefined, 'btn btn-sm btn-restart-client') : ''}`}</div>
        </div>
        <div class="current-quota">${quotaCells(status, agent.id, true)}</div>
      </article></section>`;
  }
  const loginError = status.state === 'error' && status.extra;
  return `
    <section class="current-section"><div class="section-caption">当前使用</div>
    <article class="active-session-card unassigned-session-card">
      <div class="session-card-header">
        <div class="session-meta-group"><div class="platform-logo-big unassigned-logo">${agentLogo(agent.id, 'current')}</div><div class="session-title-group"><div class="detail-title"><strong class="unassigned-title">${loginError ? '登录状态待核对' : '暂未激活账号'}</strong></div><div class="session-account-line"><span class="unassigned-tip">${escapeHTML(loginError || '当前未选择任何账号，请从下方备用账号列表中点击「切换」使用')}</span></div></div></div>
      </div>
    </article></section>`;
}

function renderWorkbench() {
  const container = $('workspaceContent');
  if (!container) return;
  if (currentTab === 'settings') { if (!$('appUpdatePanel')) renderSettings(); return; }
  const agent = agentsData.find(a => a.id === currentTab);
  if (!agent) return;
  const current = agent.profiles.find(p => p.isActive), status = agent.status;
  const poolCount = agent.profiles.filter(p => !p.isActive).length;
  const allSelected = agent.profiles.length > 0 && agent.profiles.every(p => exportSelection.has(profileKey(agent.id, p.name)));
  $('btnRefresh').hidden = !hasQuota(agent) && !!agent.management?.cliStatus;
  $('btnRefresh').title = hasQuota(agent)?`刷新全部 ${agent.label} 账号额度；右键账号可在详情中单独刷新`:'刷新账号列表';
  if (hasQuota(agent) && !agent.profiles.length && !status.available && status.state !== 'ok' && !(status.state === 'error' && status.extra)) {
    container.innerHTML = `<div class="platform-empty"><div class="empty-icon-wrap">${agentLogo(agent.id, 'current')}</div><h2>尚未添加该智能体的账号凭据</h2><p>通过本地登录、Session 凭据或加密备份添加 ${escapeHTML(agent.label)} 账号。</p>${button('openSaveModal', '+ 添加账号', agent.id, undefined, 'btn btn-primary')}</div>`;
    syncRefreshUi();
    return;
  }
  const focus = document.activeElement;
  const focusedControl = focus?.id==='accountSearch' ? focus.id : null;
  const focusedGroup = focus?.closest('.account-group-head button')?.dataset;
  const searchSelection = focus?.id === 'accountSearch' ? [focus.selectionStart, focus.selectionEnd] : null;
  container.innerHTML = `${renderCurrentSectionHtml(agent, current, status, status.extra || `额度更新：${time(status.fetchedAt)}`)}
    <section class="account-section ${agent.id==='agy'&&hasQuota(agent)?'model-account-section':''} ${hasQuota(agent)?'':'credentials-section'} ${!poolCount?'empty-pool':''}" data-layout="${accountLayout}" data-reset-format="${settings.showResetTimes?'countdown':'date'}">
      <div class="matrix-section-header"><div class="matrix-title"><h4>${selecting ? '管理账号' : hasQuota(agent)?'备用账号':'已保存账号'} <span class="pool-badge">${selecting ? `已选 ${exportSelection.size}` : poolCount}</span></h4></div><div class="pool-tools">
        <input type="search" id="accountSearch" aria-label="搜索账号" placeholder="搜索账号" value="${escapeHTML(filter)}">
        <div class="layout-toggle" role="group" aria-label="账号展示方式"><button type="button" data-action="setAccountLayout" data-layout="cards" aria-label="紧凑卡片" aria-pressed="${accountLayout==='cards'}" data-tooltip="紧凑卡片">${icon('grid')}</button><button type="button" data-action="setAccountLayout" data-layout="rows" aria-label="单行比较" aria-pressed="${accountLayout==='rows'}" data-tooltip="单行比较">${icon('rows')}</button></div>
        <div class="detail-header-actions">${selecting ? `
        ${button('selectAllExport', allSelected ? '取消全选' : `全选全部 ${agent.profiles.length} 个`, agent.id)}
        ${button('handleDeleteSelected', '删除', agent.id, undefined, 'btn btn-sm btn-danger-ghost', !exportSelection.size)}
        ${button('exportSelected', '导出', agent.id, undefined, 'btn btn-sm', !exportSelection.size)}
        ${button('endSelection', '完成', agent.id, undefined, 'btn btn-primary btn-sm')}` : `
        ${agent.profiles.length ? button('startSelection', '管理', agent.id) : ''}
        ${button('openSaveModal', '+ 添加账号', agent.id, undefined, 'btn btn-primary btn-sm')}`}</div></div></div>
      <div class="account-list" id="accountGrid" aria-label="备用账号"></div>
    </section>`;
  renderCards();
  syncRefreshUi();
  if (focusedGroup) focusAccountGroup(focusedGroup.family, focusedGroup.action, focusedGroup.direction);
  if (focusedControl) $(focusedControl)?.focus();
  if (searchSelection) { $('accountSearch').focus(); $('accountSearch').setSelectionRange(...searchSelection); }
}
function sortedProfiles(agent) {
  const now = Date.now();
  const pool = agent.profiles.filter(p => !p.isActive);
  if (!hasQuota(agent)) return pool.sort((a,b) => a.name.localeCompare(b.name,'zh-CN'));
  const order = [...new Set([...readAccountGroups(agent.id).order, 'pro', 'plus', 'go', 'free'])];
  const rank = key => order.includes(key) ? order.indexOf(key) : order.length;
  return pool.sort((a,b) => {
    const left = profileStatus(agent,a), right = profileStatus(agent,b);
    return rank(AccountPolicy.planInfo(left,agent.id).key) - rank(AccountPolicy.planInfo(right,agent.id).key)
      || AccountPolicy.compare({ name:a.name, status:left }, { name:b.name, status:right }, now, agent.id);
  });
}

function trayAccount(agent, profile, positions, freshRows) {
  const status = profileStatus(agent, profile);
  const expired = canUpdateCredentials(profile, status);
  let nickname = typeof profile.meta.label === 'string' && profile.meta.label || profile.name;
  // Imported profile names can consist of, or contain, the full login email.
  if (nickname.includes('@')) {
    const email = profile.meta.email || status?.account;
    if (email && nickname.includes(email)) nickname = nickname.replaceAll(email, '').replace(/^[\s_-]+|[\s_-]+$/g, '');
    const privacyLabel = `账号 ${positions.get(profile)}`;
    nickname = nickname && !nickname.includes('@') ? `${nickname} · ${privacyLabel}` : privacyLabel;
  }
  const plan = knownPlan(status) && AccountPolicy.planInfo(status,agent.id).label;
  const slots = hasQuota(agent) && !expired ? AccountPolicy.quotaSlots(status, agent.id) : [];
  const row = {
    name: profile.name, label: nickname, expired,
    plan: typeof plan === 'string' && !plan.includes('@') ? plan : undefined,
    weeklyPro: agent.id === 'codex' && plan === 'Pro' && slots.length === 1 && slots[0].windowMins === 10080 &&
      [status.quota.primaryWindow, status.quota.secondaryWindow].every(w => !w || w.windowMins === 10080),
    windows: slots.map(w => ({
      label: quotaWindowLabel(w),
      usedPercent: w.usedPercent,
      invalidated: AccountPolicy.quotaWindowView(w, AccountPolicy.queryInvalidated(status)).invalidated,
      resetsAt: w.resetsAt,
    })),
  };
  if (row.windows.some(w => Number.isFinite(w.usedPercent))) {
    const isLive = !!profile.isActive;
    row.cached = stale(status, agent.id, isLive);
    if (!row.cached) freshRows.push({ row, status, agent: agent.id, isLive });
  }
  return row;
}

let trayGroups, lastTrayState, lastTrayJson, freshTrayRows = [];
function syncTray(rebuild = false, cacheChanged = false) {
  if (!window.api.updateTray) return;
  if (rebuild) {
    freshTrayRows = [];
    trayGroups = DEFAULT_AGENTS.map(({id}) => {
      const agent = agentsData.find(a => a.id === id);
      if (!agent || statusRetryAt) return { id, unavailable:'账号状态未取得', total:0, alternates:[], unmanaged:false, canRefresh:false };
      const active = agent.profiles.find(p => p.isActive);
      const pool = sortedProfiles(agent);
      const positions = new Map(agent.profiles.map((profile, i) => [profile, i + 1]));
      const alternates = agent.switchUnsupported ? [] : pool
        .filter(p => !canUpdateCredentials(p, profileStatus(agent, p)) && p.meta.snapshot?.available !== false)
        .map(p => trayAccount(agent, p, positions, freshTrayRows));
      const unmanaged = !active && agent.status.available && canSaveLocal(agent);
      const unavailable = !active && !unmanaged && agent.status.state !== 'signed-out' ? '登录状态未确认' : undefined;
      return { id, current: active && trayAccount(agent, active, positions, freshTrayRows), unmanaged, unavailable, canRefresh:hasQuota(agent),
        alternates, total:pool.length, hasTargets: hasQuota(agent) && refreshTargets(agent, pool).length > 0 };
    });
  }
  if (!trayGroups) return;
  let busyChanged = false;
  for (const group of trayGroups) {
    const refreshing = [...refreshQueue.jobs.values()].some(job => job.payload.id === group.id);
    const bulkRefreshing = !!refreshBatches.get(group.id)?.manual.size;
    busyChanged ||= group.refreshing !== refreshing || group.bulkRefreshing !== bulkRefreshing;
    Object.assign(group, { refreshing, bulkRefreshing });
  }
  const menu = { tab: currentTab, layout: accountLayout, blocked: !!document.querySelector('dialog[open]') || switchingAccount };
  if (!rebuild && !cacheChanged && menu.tab === lastTrayState?.menu.tab && menu.layout === lastTrayState?.menu.layout &&
      menu.blocked === lastTrayState?.menu.blocked && !busyChanged &&
      switchingAccount === lastTrayState?.switching && lastAgentTab === lastTrayState?.selectedAgent &&
      settings.showResetTimes === lastTrayState?.countdown) return;
  const state = { groups: trayGroups, switching:switchingAccount, selectedAgent:lastAgentTab, countdown:settings.showResetTimes, menu };
  lastTrayState = state;
  const serialized = JSON.stringify(state);
  if (serialized !== lastTrayJson) {
    lastTrayJson = serialized;
    window.api.updateTray(state);
  }
}

async function handleTrayCommand({action, agent:id, name, operation, decision}) {
  if (loading && action !== 'add' && action !== 'open') await loading;
  if (action === 'open') return;
  if (switchingAccount || document.querySelector('dialog[open]')) {
    if (action === 'switch') throw new Error(switchingAccount ? '另一项切换正在进行' : '请先完成主窗口中的操作');
    return;
  }
  if (action === 'menu') {
    switch (operation) {
      case 'settings': case 'codex': case 'agy': return selectTab(operation);
      case 'sidebar': return toggleSidebar();
      case 'add': return openSaveModal(lastAgentTab);
    }
    if (!agentEnabled(currentTab)) return;
    if (operation === 'refresh') return actions.loadStatus();
    if (operation === 'restart') return handleRestartClient(currentTab);
    if (operation === 'cards' || operation === 'rows') return setAccountLayout(operation);
    return;
  }
  if (action === 'add') return openSaveModal(id || lastAgentTab);
  if (action === 'refresh') return id && refreshAll(true, id, 'tray');
  if (statusRetryAt) {
    if (action === 'switch') throw new Error('暂时无法读取账号列表，请稍后重试');
    return;
  }
  const agent = agentsData.find(a => a.id === id && agentEnabled(a.id));
  if (!agent) {
    if (action === 'switch') throw new Error('账号列表已变更，请重新选择');
    return;
  }
  if (action === 'save') {
    if (!agent.active && agent.status.available && canSaveLocal(agent)) { selectTab(id); return openSaveModal(id); }
    return;
  }
  const profile = agent.profiles.find(p => p.name === name);
  if (!profile) throw new Error('账号列表已变更，请重新选择');
  if (canUpdateCredentials(profile,profileStatus(agent,profile))) {
    if (action === 'switch') throw new Error('请先在主窗口更新此账号的凭据');
    if (!document.querySelector('dialog[open]')) { selectTab(id); return openCredentialUpdate(id,name); }
  } else if (action === 'switch' && !profile.isActive) {
    if (agent.switchUnsupported) throw new Error(agent.switchUnsupported);
    return handleSwitchProfile(id,name,'tray',decision);
  }
}
const invalidGroup = { key: '__invalid__', label: '凭据失效' };
function invalidCredentialLabel(status) {
  return status.stagedReplacement ? '待验证凭据' : status.available === false ? '凭据不可用' : invalidGroup.label;
}
function renderCardHTML(agent, p, invalid = false) {
  const status = profileStatus(agent, p);
  const email = p.meta.email || status?.account || '账号信息未识别';
  const checked = exportSelection.has(profileKey(agent.id, p.name));
  const info=AccountPolicy.planInfo(status,agent.id);
  const needsLogin=canUpdateCredentials(p, status);
  if (!hasQuota(agent)) return `<article class="account-card credential-card ${selecting?'selectable':''} ${selecting&&checked?'is-selected':''}" role="listitem" data-account-context data-agent="${agent.id}" data-profile="${escapeHTML(p.name)}" ${selecting?'data-action="toggleExport"':'tabindex="0" aria-haspopup="dialog" aria-keyshortcuts="Enter Shift+F10"'} aria-label="${escapeHTML(p.meta.label||p.name)}"><div class="account-summary"><div class="account-title-row"><strong class="account-main-name" data-tooltip-overflow data-tooltip="${escapeHTML(p.meta.label||p.name)}">${escapeHTML(p.meta.label||p.name)}</strong>${knownPlan(status)?planLabel(status,'plan-tier',agent.id):''}</div><div class="account-secondary"><span class="account-email-sub" data-tooltip-overflow data-tooltip="${escapeHTML(email)}">${escapeHTML(email)}</span></div></div><div class="card-actions">${selecting?`<input type="checkbox" class="account-select" data-action="toggleExport" data-agent="${agent.id}" data-profile="${escapeHTML(p.name)}" ${checked?'checked':''} aria-label="选择 ${escapeHTML(p.name)}">`:agent.switchUnsupported?'':button('handleSwitchProfile','切换',agent.id,p.name,'btn btn-brand-soft btn-switch',needsLogin||status?.available===false)}</div></article>`;
  let resources;
  if (invalid) {
    const label = invalidCredentialLabel(status);
    const detail = status.extra || (needsLogin ? '请更新此账号的凭据' : label);
    const plan = info.key && !['unknown', '未识别套餐'].includes(info.key) ? planLabel(status,'plan-tier',agent.id,true) : '';
    resources = `<div class="credential-status"><span class="account-state auth-expired" data-tooltip-instant data-tooltip="${escapeHTML(detail)}">${icon('warning')}${label}</span>${plan}</div>`;
  } else {
    resources = quotaCells(status, agent.id, false, accountLayout==='rows') + (accountLayout==='rows' ? creditBadge(status) : '');
  }
  return `<article class="account-card ${selecting ? 'selectable' : ''} ${selecting && checked ? 'is-selected' : ''}" role="listitem" data-account-context data-agent="${agent.id}" data-profile="${escapeHTML(p.name)}" ${selecting?'data-action="toggleExport"':'tabindex="0" aria-haspopup="dialog" aria-keyshortcuts="Enter Shift+F10"'} aria-label="${escapeHTML(p.meta.label||p.name)}">
    <div class="account-summary"><div class="account-title-row"><strong class="account-main-name" ${accountLayout==='cards'?'data-tooltip-overflow':''} data-tooltip="${escapeHTML((p.meta.label||p.name)+' · '+email)}">${escapeHTML(p.meta.label || p.name)}</strong>${invalid?'':queryWarning(status)}</div>
    <div class="account-secondary">${!invalid&&accountLayout==='cards'&&info.tier?planLabel(status,'plan-tier'):''}<span class="account-email-sub" data-tooltip-overflow data-tooltip="${escapeHTML(email)}">${escapeHTML(email)}</span></div></div>
    <div class="card-actions">${!selecting&&!invalid?resetTicket(agent,p,status):''}${selecting ? `<input type="checkbox" class="account-select" data-action="toggleExport" data-agent="${agent.id}" data-profile="${escapeHTML(p.name)}" ${checked ? 'checked' : ''} aria-label="选择 ${escapeHTML(p.name)}">` : button(needsLogin?'openCredentialUpdate':'handleSwitchProfile', needsLogin?'更新':'切换', agent.id, p.name, 'btn btn-brand-soft btn-switch', !needsLogin&&(invalid||!!agent.switchUnsupported)).replace('<button ', `<button title="${escapeHTML(needsLogin?'更新此账号的登录凭据':invalid?'当前凭据不可用':agent.switchUnsupported || '切换到此账号')}" aria-label="${needsLogin?'更新凭据':'切换到'} ${escapeHTML(p.name)}" `)}</div>
    <div class="card-resources">${resources}</div>${!invalid&&accountLayout==='cards'?creditCorner(status):''}</article>`;
}
function readAccountGroups(id) {
  let saved;
  try { saved = JSON.parse(readLayout(`accountGroups.${id}`, '{}')); } catch { /* Ignore malformed display preferences. */ }
  const keys = value => Array.isArray(value) ? [...new Set(value.filter(key => typeof key === 'string'))] : [];
  return { order: keys(saved?.order), collapsed: keys(saved?.collapsed) };
}
function focusAccountGroup(family, action = 'toggleAccountGroup', direction) {
  const controls = [...document.querySelectorAll('.account-group-head button')];
  const sameGroup = button => button.dataset.family === family && !button.disabled;
  const target = controls.find(button => sameGroup(button) && button.dataset.action === action && button.dataset.direction === direction)
    || controls.find(sameGroup);
  target?.focus({ preventScroll: true });
}
function toggleAccountGroup(id, _profile, target) {
  if (filter.trim()) return;
  const saved = readAccountGroups(id), family = target.dataset.family;
  saved.collapsed = saved.collapsed.includes(family) ? saved.collapsed.filter(key => key !== family) : [...saved.collapsed, family];
  writeLayout(`accountGroups.${id}`, JSON.stringify(saved));
  renderCards();
  focusAccountGroup(family);
}
function moveAccountGroup(id, _profile, target) {
  if (!selecting || filter.trim()) return;
  const keys = [...document.querySelectorAll('#accountGrid .account-plan-group[data-family]')].map(group => group.dataset.family).filter(key => key !== invalidGroup.key);
  const from = keys.indexOf(target.dataset.family), to = from + Number(target.dataset.direction);
  if (from < 0 || to < 0 || to >= keys.length) return;
  [keys[from], keys[to]] = [keys[to], keys[from]];
  const saved = readAccountGroups(id);
  saved.order = [...keys, ...saved.order.filter(key => !keys.includes(key))];
  writeLayout(`accountGroups.${id}`, JSON.stringify(saved));
  syncTray(true);
  renderCards();
  focusAccountGroup(target.dataset.family, 'moveAccountGroup', String(-Number(target.dataset.direction)));
}
function sizeAccountRows(grid, agent, groups, pool, states) {
  if (accountLayout !== 'rows') return;
  const values = [...groups.values()];
  grid.style.setProperty('--window-count', Math.max(1, ...values.map(g => g.pro ? 2 : g.windowCount)));
  grid.style.setProperty('--first-label-space', values.some(g => !g.shared || g.pro && g.windowCount > 1) ? '28px' : '0px');
  grid.style.setProperty('--other-label-space', values.some(g => !g.pro && !g.shared) ? '28px' : '0px');
  grid.style.setProperty('--actions-width', states.some(status => resetTicket(agent, null, status)) ? '84px' : '48px');
  const name = grid.querySelector('.account-main-name'), style = getComputedStyle(name || grid);
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = name ? style.font : `600 13px ${style.fontFamily}`;
  const width = Math.ceil(Math.max(measure.measureText('账号名称测试').width, ...pool.map(p => measure.measureText(p.meta.label || p.name).width)));
  const warningSpace = states.some(status => queryWarning(status)) ? 19 : 0;
  grid.style.setProperty('--name-width', `${width + warningSpace}px`);
}
function renderCards() {
  const grid = $('accountGrid');
  if (!grid) return;
  const agent = agentsData.find(a => a.id === currentTab);
  const pool = sortedProfiles(agent);
  const query = filter.trim().toLowerCase();
  const matches = (p, plan, state = '') => !query ||
    [p.name, p.meta.email, p.meta.label, plan.label, plan.tier, state].join(' ').toLowerCase().includes(query);
  if (!hasQuota(agent)) {
    const profiles = pool.filter(p => matches(p, AccountPolicy.planInfo(profileStatus(agent,p), agent.id)));
    grid.innerHTML=profiles.length?`<div class="account-plan-group credential-group"><div class="accounts-grid" role="list">${profiles.map(p=>renderCardHTML(agent,p)).join('')}</div></div>`:`<div class="empty-accounts-box"><div>${filter?'没有符合条件的账号':'暂无已保存账号'}</div><div class="empty-accounts-sub">${filter?'试试其他关键词':'可导入已有的文件凭据或账号备份'}</div></div>`;
    syncRefreshUi(); return;
  }
  const groups = new Map(), quotaStates = [];
  for (const p of pool) {
    const status = profileStatus(agent,p);
    const plan = AccountPolicy.planInfo(status, agent.id);
    const info = canUpdateCredentials(p,status) || status?.available === false ? invalidGroup : plan;
    if (info !== invalidGroup) quotaStates.push(status);
    if (!groups.has(info.key)) groups.set(info.key, { info, profiles:[], samples:[] });
    const group = groups.get(info.key), slots = info === invalidGroup ? [] : AccountPolicy.quotaSlots(status,agent.id);
    if (matches(p, plan, info === invalidGroup ? `${info.label} ${invalidCredentialLabel(status)}` : '')) group.profiles.push(p);
    if (slots.length) group.samples.push(slots);
  }
  for (const group of groups.values()) {
    group.ws = group.samples[0] || [];
    group.shared = group.samples.every(sample => sample.map(quotaWindowLabel).join('|') === group.ws.map(quotaWindowLabel).join('|'));
    group.windowCount = Math.max(1, ...group.samples.map(ws => ws.length));
    group.pro = agent.id === 'codex' && group.info.key === 'pro';
  }
  const saved = readAccountGroups(agent.id), searching = !!query;
  const ordered=[...groups.values()].filter(g=>g.profiles.length && g.info !== invalidGroup);
  const movableCount = ordered.length, invalid = groups.get(invalidGroup.key);
  if (invalid?.profiles.length) ordered.push(invalid);
  const credits = accountLayout === 'rows' && quotaStates.some(status => creditBadge(status));
  const summary = accountLayout === 'rows' && agent.id==='agy' && quotaStates.some(status => AccountPolicy.modelBucket(status,'claude'));
  grid.classList.toggle('has-credits', credits);
  grid.classList.toggle('has-model-summary', summary);
  grid.innerHTML = ordered.length ? ordered.map((group, index)=>{
    const { ws, shared, pro, windowCount } = group;
    const family = escapeHTML(group.info.key), label = escapeHTML(group.info.label);
    const collapsed = !searching && saved.collapsed.includes(group.info.key);
    const isInvalidGroup = group.info === invalidGroup;
    const now = Date.now();
    const pending = collapsed && !isInvalidGroup ? group.profiles.filter(p => !AccountPolicy.quotaConfirmed(profileStatus(agent,p), now, agent.id)).length : 0;
    const warning = `${pending} 个额度待确认`;
    const groupId = `account-group-${index}`;
    const moves = selecting && !isInvalidGroup ? `<div class="account-group-actions">${[-1, 1].map(direction => {
      const text = `${direction < 0 ? '上移' : '下移'} ${label}`;
      const disabled = searching || index + direction < 0 || index + direction >= movableCount;
      return `<button type="button" data-action="moveAccountGroup" data-family="${family}" data-direction="${direction}" aria-label="${text}" data-tooltip="${searching ? '清空搜索后调整顺序' : text}" ${disabled ? 'disabled' : ''}>${icon(direction < 0 ? 'up' : 'down')}</button>`;
    }).join('')}</div>` : '';
    const columnHeads = pro ? `<span>${shared && windowCount === 1 && ws.length ? escapeHTML(quotaWindowLabel(ws[0]))+' 剩余' : '周期额度 · 剩余'}</span><span>档位</span>` : shared && ws.length ? ws.map(w=>`<span${agent.id==='agy'?' data-tooltip="Gemini 剩余额度"':''}>${escapeHTML(quotaWindowLabel(w))} 剩余</span>`).join('') : '<span class="row-window-label">周期额度 · 剩余</span>';
    return `<section class="account-plan-group ${shared?'shared-windows':'mixed-windows'} ${pro&&windowCount>1?'pro-multi':''} ${collapsed?'is-collapsed':''}" data-family="${family}"><div class="account-group-head">
      <h4><button type="button" class="account-group-toggle" data-action="toggleAccountGroup" data-family="${family}" aria-expanded="${!collapsed}" aria-controls="${groupId}" ${searching?'disabled':''}>${icon('chevron')}<span class="account-group-name" data-tooltip-overflow data-tooltip="${label}">${label}</span><span class="group-count">${group.profiles.length}</span></button>${pending ? `<button type="button" class="account-group-alert" data-action="toggleAccountGroup" data-family="${family}" aria-label="${label}：${warning}，展开查看" data-tooltip="${warning}">${icon('warning')}<span>${pending}</span></button>` : ''}</h4>
      ${accountLayout==='rows'?`<div class="row-column-head"><div class="row-window-head">${isInvalidGroup?'凭据状态':columnHeads}</div>${!isInvalidGroup&&summary?'<span class="row-model-head" data-tooltip="Claude / GPT 剩余额度">Claude / GPT</span>':''}${!isInvalidGroup&&credits?'<span class="row-credit-head">Credits</span>':''}</div>${moves||'<span class="row-action-head">操作</span>'}`:moves}</div><div class="accounts-grid" id="${groupId}" role="list" ${collapsed?'hidden':''}>${group.profiles.map(p=>renderCardHTML(agent,p,isInvalidGroup)).join('')}</div></section>`;
  }).join('') : `<div class="empty-accounts-box"><div>${filter?'没有符合条件的账号':'暂无备用账号'}</div><div class="empty-accounts-sub">${filter?'试试其他关键词':'点击「+ 添加账号」录入其他账号'}</div></div>`;
  sizeAccountRows(grid, agent, groups, pool, quotaStates);
  syncRefreshUi();
}
function renderSettings() {
  const preferences = [
    ['showResetTimes', '额度重置时间', [[true, '倒计时'], [false, '日期时间']]],
    ['liveRefreshInterval', '当前账号自动刷新', [['1m', '1分'], ['3m', '3分'], ['5m', '5分'], ['manual', '手动']]],
    ['spareRefreshInterval', '备用账号自动刷新', [['5m', '5分'], ['15m', '15分'], ['30m', '30分'], ['manual', '手动']]],
    ['openPrivateLogin', '无痕登录入口', [[true, '自动打开'], [false, '仅复制链接']]],
  ];
  $('workspaceContent').innerHTML = `<div class="settings-layout">
    <section class="settings-panel" aria-labelledby="preferencesTitle">
      <h3 id="preferencesTitle">偏好设置</h3><div class="settings-card settings-preferences">
        ${preferences.map(([name, label, options]) => `<div class="setting-row">
          <strong id="${name}Label">${label}</strong><div class="setting-options" role="radiogroup" aria-labelledby="${name}Label">
            ${options.map(([value, text]) => `<label><input type="radio" name="${name}" value="${value}" ${settings[name] === value ? 'checked' : ''}><span>${text}</span></label>`).join('')}
          </div></div>`).join('')}
      </div>
    </section>
    <section class="settings-panel" aria-labelledby="cleanupSettingsTitle">
      <h3 id="cleanupSettingsTitle">数据清理</h3><div class="settings-card setting-cleanup">
        <div class="setting-copy"><strong>Codex 本机账号数据</strong><span id="cleanupHint">与 AI 助手的对话，选择要清理的历史遗留账号和数据</span></div>
        <button type="button" class="btn btn-sm" data-action="copyCleanupPrompt" aria-label="复制 Codex 检查与清理指令" aria-describedby="cleanupHint">${icon('copy')}<span>复制指令</span></button>
      </div>
    </section>
    <section class="settings-panel" id="appUpdatePanel" aria-labelledby="appUpdateTitle">
    <h3 id="appUpdateTitle">应用与更新</h3><div class="settings-card app-update-card">
      <div class="app-update-heading">
        <div class="app-update-identity">
          <img class="app-update-mark" src="../assets/gate-mark.png" width="28" height="28" alt="">
          <div class="app-update-copy">
            <div class="app-update-name"><strong>AgentSwitcher</strong><span id="appUpdateVersion"></span></div>
            <div class="app-update-status"><span id="appUpdateStatus" role="status"></span><button class="app-update-link" data-action="appUpdate" data-update-action="notes" aria-expanded="false" aria-controls="appUpdateNotes" hidden>更新说明 ▾</button><button class="app-update-link" data-action="appUpdate" data-update-action="check">检查新版</button></div>
          </div>
        </div>
        <div class="app-update-actions">
          <button class="btn btn-sm" data-action="appUpdate" data-update-action="download" disabled>下载安装包</button>
          <button class="btn btn-sm" data-action="appUpdate" data-update-action="cancel" hidden>取消下载</button>
          <button class="btn btn-sm" data-action="appUpdate" data-update-action="install" hidden>立即安装并重启</button>
        </div>
      </div>
      <div id="appUpdateProgress" class="app-update-progress" hidden><progress max="100" aria-label="安装包下载进度"></progress></div>
      <div id="appUpdateNotes" class="app-update-notes" role="region" aria-label="更新说明" hidden><p></p></div>
      <p id="appUpdateMessage" class="app-update-hint" role="status" hidden></p>
      <p id="appUpdateInstallHint" class="app-update-hint" hidden></p>
      <div class="app-update-footer"><label class="app-update-auto"><input id="autoCheckUpdates" type="checkbox">自动检查新版</label><div class="app-update-actions">
        <button class="btn btn-sm" data-action="exportDiagnostics">导出故障报告</button><button class="btn btn-sm app-update-project" data-action="appUpdate" data-update-action="project">${icon('github')}<span>GitHub</span></button>
      </div></div>
    </div></section></div>`;
  updateAppUpdatePanel();
  readAppUpdateState();
}
async function readAppUpdateState() {
  const revision = appUpdateRevision;
  try {
    const state = check(await window.api.getAppUpdateState?.());
    if (state && revision === appUpdateRevision) appUpdateState = state;
  } catch (error) { appUpdateFeedback = error.message; appUpdateFeedbackError = true; }
  updateAppUpdatePanel();
}
function updateAppUpdatePanel() {
  const panel = $('appUpdatePanel');
  if (!panel) return;
  const state = appUpdateState, release = state.release;
  const busy = ['checking', 'downloading', 'verifying'].includes(state.status);
  const downloaded = state.status === 'downloaded';
  const available = !!release?.downloadable && ['available', 'error'].includes(state.status);
  const downloadFailed = state.status === 'error' && state.errorStage === 'download';
  const checkFailed = state.status === 'error' && !downloadFailed;
  const size = release?.size ? ` · ${Math.round(release.size / 1048576)} MB` : '';
  const labels = { idle: '尚未检查新版', checking: '正在检查新版…', available: `新版 ${release?.version || ''}${size}`, current: '当前已是最新版本', unavailable: '暂未取得可用版本', error: '更新暂不可用', downloading: typeof state.progress === 'number' ? `正在下载 · ${Math.floor(state.progress)}%` : '准备下载…', verifying: '正在校验安装包…', downloaded: `${release?.version || ''} 安装包已下载` };
  $('appUpdateVersion').textContent = state.currentVersion || '正在读取版本…';
  $('appUpdateStatus').textContent = labels[state.status] || labels.unavailable;
  const message = appUpdateFeedback || (state.status === 'unavailable' ? '' : state.message) || '';
  $('appUpdateMessage').textContent = message === labels[state.status] ? '' : message;
  $('appUpdateMessage').hidden = !$('appUpdateMessage').textContent;
  $('appUpdateMessage').classList.toggle('app-update-error', appUpdateFeedbackError || state.status === 'error');
  const canShowNotes = !!release?.notes?.trim() && ['available', 'checking', 'error'].includes(state.status);
  const notes = $('appUpdateNotes'), toggle = panel.querySelector('[data-update-action="notes"]');
  if (notes.dataset.version !== (release?.version || '') || !canShowNotes) notes.hidden = true;
  notes.dataset.version = release?.version || '';
  notes.querySelector('p').textContent = release?.notes || '';
  toggle.setAttribute('aria-expanded', String(!notes.hidden));
  toggle.textContent = notes.hidden ? '更新说明 ▾' : '收起说明 ▴';
  const visibility = { download: !downloaded && state.status !== 'downloading', cancel: state.status === 'downloading', install: downloaded, notes: canShowNotes, check: checkFailed || (!available && !downloaded && (!busy || state.status === 'checking')) };
  const focused = document.activeElement;
  for (const button of panel.querySelectorAll('[data-update-action]')) {
    const action = button.dataset.updateAction;
    button.hidden = visibility[action] === false;
    button.disabled = appUpdatePending.has(action) || (action === 'download' && !available) || (action === 'check' && busy);
    button.classList.toggle('btn-primary', (action === 'download' && available) || (action === 'install' && downloaded));
  }
  panel.querySelector('[data-update-action="download"]').textContent = downloadFailed ? '重新下载' : state.status === 'verifying' ? '正在校验…' : '下载安装包';
  $('appUpdateProgress').hidden = !['downloading', 'verifying'].includes(state.status);
  const progress = $('appUpdateProgress').querySelector('progress');
  if (typeof state.progress === 'number') progress.value = Math.max(0, Math.min(100, state.progress));
  else progress.removeAttribute('value');
  const manualInstall = state.installMode === 'open';
  panel.querySelector('[data-update-action="install"]').textContent = manualInstall ? '打开安装并退出' : '立即安装并重启';
  $('appUpdateInstallHint').hidden = !downloaded || !manualInstall;
  $('appUpdateInstallHint').textContent = manualInstall ? '将 AgentSwitcher 拖入「应用程序」替换，再重新打开。' : '';
  $('autoCheckUpdates').checked = state.autoCheck;
  $('autoCheckUpdates').disabled = appUpdatePending.has('auto');
  if (focused?.hidden && panel.contains(focused)) panel.querySelector('.app-update-actions button:not([hidden]):not(:disabled)')?.focus();
}
async function handleAppUpdateAction(action, value) {
  if (action === 'notes') { $('appUpdateNotes').hidden = !$('appUpdateNotes').hidden; updateAppUpdatePanel(); return; }
  const requests = {
    check: () => window.api.checkAppUpdates(), download: () => window.api.downloadAppUpdate(),
    cancel: () => window.api.cancelAppUpdate(), install: () => window.api.installAppUpdate(),
    auto: () => window.api.setAutoUpdateCheck(value),
    project: () => window.api.openProjectPage(),
  };
  if (!requests[action] || appUpdatePending.has(action)) return;
  appUpdateFeedback = '';
  appUpdateFeedbackError = false;
  appUpdatePending.add(action);
  updateAppUpdatePanel();
  try {
    check(await requests[action]());
    await readAppUpdateState();
  } catch (error) { appUpdateFeedback = error.message; appUpdateFeedbackError = true; }
  finally { appUpdatePending.delete(action); updateAppUpdatePanel(); }
}
function setAccountLayout(layout) {
  accountLayout = layout === 'rows' ? 'rows' : 'cards';
  writeLayout('accountLayout', accountLayout);
  renderWorkbench();
  syncTray();
  document.querySelector(`.layout-toggle [data-layout="${accountLayout}"]`)?.focus();
}
function accountContextCard(id,name) {
  return [...document.querySelectorAll('[data-account-context]')].find(el=>el.dataset.agent===id&&el.dataset.profile===(name||''));
}
function showAccountDialog(dialog,origin) {
  dialog.classList.add('account-modal');
  dialog.accountOrigin=origin;
  let closing;
  dialog.dismissAccountDialog=(restoreFocus=true)=>{
    if(closing)return closing;
    dialog.style.setProperty('--dialog-close-opacity',getComputedStyle(dialog).opacity);
    dialog.style.setProperty('--backdrop-close-opacity',getComputedStyle(dialog,'::backdrop').opacity);
    dialog.dataset.closing='';
    dialog.inert=true;
    closing=(async()=>{
      const animations=dialog.getAnimations({subtree:true}).filter(a=>['account-dialog-out','account-backdrop-out'].includes(a.animationName));
      let timeout;
      await Promise.race([Promise.allSettled(animations.map(a=>a.finished)),new Promise(resolve=>{timeout=setTimeout(resolve,180);})]);
      clearTimeout(timeout);
      dialog.close();restoreToastLayer(dialog);dialog.remove();
      if(!restoreFocus)return;
      if(origin.keyboard){
        const target=origin.trigger?.isConnected?origin.trigger:accountContextCard(origin.id,origin.name);
        target?.focus({preventScroll:true});
        if(target===document.activeElement)target.dataset.keyboardFocus='';
      }else if(document.activeElement?.closest('[data-account-context]'))document.activeElement.blur();
    })();
    return closing;
  };
  dialog.querySelector('[data-close-dialog]')?.addEventListener('click',()=>dialog.dismissAccountDialog());
  dialog.addEventListener('cancel',event=>{event.preventDefault();dialog.dismissAccountDialog();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.dismissAccountDialog();}});
  if(!origin.keyboard)document.activeElement?.blur();
  document.body.append(dialog);dialog.showModal();return dialog;
}
function accountDialog(id,name,title,content,trigger) {
  const dialog=document.createElement('dialog');dialog.className='password-dialog account-detail-dialog';
  dialog.setAttribute('aria-label',title);
  dialog.innerHTML=`<div class="account-dialog-head"><strong>${escapeHTML(title)}</strong><button class="btn-icon-ghost" data-close-dialog aria-label="关闭">${icon('close')}</button></div><div class="account-dialog-body">${content}</div>`;
  return showAccountDialog(dialog,{id,name,trigger,keyboard:inputModality==='keyboard'});
}
function detailAccount(id,name) {
  const agent=agentsData.find(a=>a.id===id);
  const p=name?agent?.profiles.find(p=>p.name===name):agent?.profiles.find(p=>p.isActive)||
    (agent?.status.available?{name:'',meta:{label:'当前登录（未保存）'},unsaved:true}:undefined);
  return {agent,p,status:p&&!p.unsaved?profileStatus(agent,p):agent?.status};
}
function accountDetailActions(id,p,status,dialog) {
  if (p.unsaved) return '';
  const name = p.name;
  if(dialog?.hasAttribute('data-delete-confirm')) {
    const preview=dialog.deletePreview;
    const scope=preview?`将移除 ${preview.profiles.length} 份 AGS 备份及其缓存。`:'正在核对删除范围…';
    const aliases=preview?.profiles.length>1?`<ul class="delete-profile-list">${preview.profiles.map(profile=>`<li>${escapeHTML(profile)}</li>`).join('')}</ul>`:'';
    const logout=preview?.current?`<label class="delete-logout-choice"><input type="checkbox" data-delete-logout ${dialog.deleteLogout?'checked':''} ${preview.logoutUnsupported?'disabled':''}>同时退出当前客户端登录</label>${preview.logoutUnsupported?`<span>${escapeHTML(preview.logoutUnsupported)}</span>`:''}`:'';
    return `<div class="detail-delete-confirm" role="group" aria-label="删除账号确认"><p>从 AGS 移除「${escapeHTML(p.meta.label||p.name)}」？</p><span>${dialog.dataset.deleteError&&!preview?'未能取得删除范围，请重新核对。':scope}</span>${aliases}${logout}<span class="delete-retained">${dialog.deleteLogout?'客户端历史记录和项目文件将保留。':'客户端登录、历史记录和项目文件将保留。'}</span>${dialog.dataset.deleteError?`<p class="detail-delete-error" role="alert">${escapeHTML(dialog.dataset.deleteError)}</p>`:''}<div class="detail-actions">${button('cancelDeleteProfile','取消',id,name)}${dialog.dataset.deleteError?button('handleDeleteProfile','重新核对',id,name):''}${button('confirmDeleteProfile',dialog.deleteLogout?'退出并移除':'从 AGS 移除',id,name,'btn btn-danger',!preview)}</div></div>`;
  }
  const update = canUpdateCredentials(p, status) ? button('openCredentialUpdate', '更新凭据', id, name, 'btn btn-sm btn-brand-soft') : '';
  return `<div class="detail-actions account-actions">${button('handleDeleteProfile',`${icon('delete')}<span>删除账号</span>`,id,name,'btn detail-account-action btn-delete-account')}${button('handleExportProfile',`${icon('export')}<span>导出账号</span>`,id,name,'btn detail-account-action')}${update}</div>`;
}
function accountDetailStatus(status, id) {
  const expired = credentialsExpired(status);
  const title = expired ? '凭据失效' : status?.state === 'error' ? '查询失败' : '';
  const row = title ? `<div class="detail-status-row"><span class="detail-status ${expired?'is-expired':'is-warning'}">${icon('warning')}${title}</span>${status?.quota?'<span class="detail-history-label">上次额度</span>':''}</div>` : '';
  let note = status?.extra;
  if (!title && !note) {
    const missing = AccountPolicy.quotaSlots(status, id).filter(w => !Number.isFinite(w.usedPercent));
    if (missing.length) note = `${missing.map(w => w.windowMins === 10080 ? '周' : quotaWindowLabel(w)).join('、')}额度未提供`;
  }
  return row + (note && note !== title ? `<p class="detail-note detail-status-note">${escapeHTML(note)}</p>` : '');
}
function accountDetailsContent(id,name,dialog) {
  const {agent,p,status}=detailAccount(id,name);if(!p)return '<p class="detail-note">此账号已移除。</p>';
  const savedPlan=knownPlan(status);
  const plan=savedPlan?(id==='agy'?escapeHTML(savedPlan):planLabel(status,'',id)):'未取得';
  if (!hasQuota(agent)) return `<p class="account-dialog-email">${escapeHTML(p.meta.email||status?.account||'账号信息未识别')}</p>${savedPlan?`<div class="account-detail-line"><span>套餐</span><b>${plan}</b></div>`:''}${agent?.switchUnsupported?'<p class="detail-note provider-detail-note">可重命名、导出或从本机移除这份备份。</p>':''}${accountDetailActions(id,p,status,dialog)}`;
  const staged = p.isActive && p.meta.snapshot?.stagedReplacement ? p.meta.snapshot : undefined;
  const candidateNote = staged ? `<p class="detail-note detail-status-note">新凭据验证 · ${escapeHTML(staged.extra || '等待验证')}</p>` : '';
  const credit=creditInfo(status, !!(p.isActive || p.unsaved)),email=p.meta.email||status?.account||'未取得';
  const refresh=button('refreshSelected',icon('restart'),id,name,'btn-icon-ghost detail-refresh').replace('<button ','<button data-refresh-account data-tooltip-instant data-tooltip="刷新额度" aria-label="刷新额度" ');
  return `<p class="account-dialog-email">${escapeHTML(email)}</p><div class="account-detail-line"><span>套餐</span><b>${plan}</b></div>${id==='codex'||credit?`<div class="account-detail-line"><span>Credits</span><b>${escapeHTML(credit?.balance??'未取得')}</b></div>`:''}<div class="detail-quota-list">${accountDetailStatus(status,id)}${candidateNote}${(id==='agy'?(status?.quota?.buckets||[]).flatMap(bucket=>bucket.windows.map(w=>({...w,model:bucket.label}))):windows(status)).map(w=>`<div class="account-detail-line"><span>${escapeHTML(w.model?`${w.model} · ${quotaWindowLabel(w)}`:quotaWindowLabel(w))} 剩余</span><b>${escapeHTML(AccountPolicy.quotaWindowView(w).text)}</b><span>${Number.isFinite(w.resetsAt)?AccountPolicy.resetText(w.resetsAt):'重置时间未提供'}</span></div>`).join('')}</div><div class="detail-update-row"><span>${status?.fetchedAt?'上次更新：':''}${escapeHTML(time(status?.fetchedAt))}</span>${refresh}</div>${accountDetailActions(id,p,status,dialog)}`;
}
function updateAccountDetails() {
  document.querySelectorAll('dialog[data-account-details]:not([data-closing])').forEach(dialog=>{
    if(dialog.hasAttribute('data-deleting'))return;
    const focusAction=dialog.contains(document.activeElement)?document.activeElement.dataset.action:null;
    const focusLogout=dialog.contains(document.activeElement)&&document.activeElement.matches('[data-delete-logout]');
    dialog.querySelector('.account-dialog-body').innerHTML=accountDetailsContent(dialog.dataset.agent,dialog.dataset.profile,dialog);
    if(focusAction)[...dialog.querySelectorAll('[data-action]')].find(el=>el.dataset.action===focusAction)?.focus({preventScroll:true});
    if(focusLogout)dialog.querySelector('[data-delete-logout]')?.focus({preventScroll:true});
  });
  syncRefreshUi();
}
function openAccountDetails(id,name,trigger) {
  const {p}=detailAccount(id,name);if(!p)return;
  const dialog=accountDialog(id,name,p.meta.label||p.name,accountDetailsContent(id,name),trigger);
  dialog.dataset.accountDetails='';dialog.dataset.agent=id;dialog.dataset.profile=name||'';
  if(!p.unsaved)installAccountNameEditor(dialog);
  syncRefreshUi();
}
function openResetCards(id,name,trigger) {
  const {p,status}=detailAccount(id,name),summary=status?.quota?.resetCredits;if(!summary)return;
  const details=summary.credits;
  accountDialog(id,name,`重置卡 ${summary.availableCount} 张`,`<p class="account-dialog-email">${escapeHTML(p?.meta?.label||name||status?.account||'当前账号')}</p>${details?.length?details.map(c=>`<div class="reset-credit-detail"><strong>${escapeHTML(c.title||'额度重置卡')}</strong>${c.description?`<p>${escapeHTML(c.description)}</p>`:''}<p>${c.expiresAt===null?'无到期时间':Number.isFinite(c.expiresAt)?`${AccountPolicy.resetText(c.expiresAt)} 到期`:'有效期未提供'}${c.status==='redeeming'?' · 正在处理':c.status==='redeemed'?' · 已使用':''}</p></div>`).join(''):'<p class="detail-note">已取得张数，适用范围和有效期待刷新。</p>'}${details&&details.length<summary.availableCount?'<p class="detail-note">其余重置卡详情待刷新。</p>':''}<p class="detail-note">使用重置卡请在 Codex 客户端操作。</p>`,trigger);
}
function startSelection() { selecting = true; exportSelection.clear(); renderWorkbench(); }
function endSelection() { selecting = false; exportSelection.clear(); renderWorkbench(); }
function toggleExport(id, name) {
  const key = profileKey(id, name);
  if (exportSelection.has(key)) exportSelection.delete(key); else exportSelection.add(key);
  renderWorkbench();
  [...document.querySelectorAll('[data-action=toggleExport]')].find(el => el.dataset.agent === id && el.dataset.profile === name && el.tabIndex >= 0)?.focus();
}
function selectAllExport() {
  const agent = agentsData.find(a => a.id === currentTab);
  const allProfiles = agent.profiles;
  const allSelected = allProfiles.length > 0 && allProfiles.every(p => exportSelection.has(profileKey(agent.id, p.name)));
  if (allSelected) {
    allProfiles.forEach(p => exportSelection.delete(profileKey(agent.id, p.name)));
  } else {
    allProfiles.forEach(p => exportSelection.add(profileKey(agent.id, p.name)));
  }
  renderWorkbench();
}
async function exportSelected() {
  const items = [...exportSelection].map(key => { const [agent, profile] = key.split('/'); return { agent, profile }; });
  const password = await askPassword(); if (password === null) return;
  const result = check(await window.api.exportProfiles(items, password));
  if (!result.canceled) { showToast(`已加密导出 ${result.count} 个账号`); endSelection(); }
}

async function loadStatus(silent = false, readDashboard = window.api.getStatus) {
  if (loading) return loading;
  loading = (async () => {
    agentsData = check(await readDashboard());
    statusRetryAt = 0;
    syncTray(true);
    agentsData.forEach(a => { $(`badge-count-${a.id}`).textContent = a.profiles.length; $(`logo-nav-${a.id}`).innerHTML = agentLogo(a.id, 'sidebar'); });
    syncSidebarLabels();
    if ($('saveModalOverlay')?.open) {
      const currentSelected = $('modalPlatformSelect').value || activeDialog.agent || currentTab;
      $('modalPlatformSelect').innerHTML = platformOptions(agentsData, currentSelected);
      $('modalPlatformSelect').value = currentSelected;
      if (!activeDialog.agent) { activeDialog.agent = currentSelected; pollLocalAccount(); }
    }
    renderWorkbench();
    updateAccountDetails();
    scheduleQuotaRefresh();
  })().catch(error => {
    statusRetryAt = Date.now() + 60000;
    syncTray(true);
    if (!silent) showToast(error.message, 'error');
    scheduleQuotaRefresh();
  }).finally(() => { loading = null; });
  return loading;
}
function scheduleQuotaRefresh() {
  clearTimeout(quotaRefreshTimer);
  if (!canAutoRefresh()) return;
  if (statusRetryAt) {
    // Refresh the local deadlines before scheduling queries from a stale dashboard.
    quotaRefreshTimer = setTimeout(resumeQuotaRefresh, Math.max(0, statusRetryAt - Date.now()));
    return;
  }
  const targets = agentsData.filter(a => hasQuota(a) && !refreshBatches.has(a.id)).flatMap(a => refreshTargets(a));
  const deadline = Math.min(...targets.filter(t=>!refreshQueue.get(t.key)).map(t=>t.deadline));
  if (!Number.isFinite(deadline)) return;
  quotaRefreshTimer = setTimeout(() => refreshAll(), Math.min(2147483647, Math.max(1000, deadline - Date.now())));
}
function refreshKey(id, profile) {
  const agent=agentsData.find(a=>a.id===id);
  return JSON.stringify([id, profile || agent?.profiles.find(p=>p.isActive)?.name || null]);
}
function refreshTargets(agent, pool = sortedProfiles(agent)) {
  const active = agent.profiles.find(p => p.isActive);
  const targets = [];
  const add = (profile, live, record) => {
    const saved = profile?.meta.snapshot;
    const status = live && !saved?.stagedReplacement ? agent.status : saved;
    if (saved?.available === false || ['signed-out','unsupported'].includes(status?.state) || (!saved?.stagedReplacement && credentialsExpired(status))) return;
    const key = JSON.stringify([agent.id, profile?.name || null]);
    const failed = refreshFailedAt.get(key);
    const retryAt = failed === undefined ? 0 : failed + agent.refreshPeriods[live ? 'live' : 'spare'];
    targets.push({key, id:agent.id, profile:profile?.name, live,
      deadline:Math.max(record.refreshAt ?? 0, retryAt), hotRefreshAt:Math.max(record.hotRefreshAt ?? Infinity, retryAt),
      switchable:!agent.switchUnsupported && !canUpdateCredentials(profile, status)});
  };
  if (active || agent.status.available) add(active, true, active?.meta.snapshot?.stagedReplacement ? active : agent);
  for (const profile of pool) add(profile, false, profile);
  return targets;
}
function syncRefreshUi() {
  syncTray();
  const supportsQuota = hasQuota(agentsData.find(a=>a.id===currentTab));
  const batch = supportsQuota && refreshBatches.get(currentTab);
  const manual = batch?.manual?.size;
  $('refreshIcon')?.classList.toggle('spin',!!batch);
  if($('btnRefresh')){
    $('btnRefresh').disabled = !!manual;
    $('btnRefresh').setAttribute('aria-busy',String(!!batch));
    $('refreshLabel').textContent = !supportsQuota ? '刷新' : manual ? `刷新中 ${batch.completed}/${batch.requests.size}` : '刷新全部';
  }
  document.querySelectorAll('[data-refresh-account]').forEach(el=>{
    const job=refreshQueue.get(refreshKey(el.dataset.agent,el.dataset.profile));
    el.disabled=!!el.closest('[data-deleting]')||job?.state==='running';
    el.dataset.refreshState=job?.state||'';
    el.setAttribute('aria-busy',String(!!job));
    const label=job?.state==='running'?'刷新中…':job?.state==='queued'?'等待刷新…':'刷新额度';
    el.setAttribute('aria-label',label);el.dataset.tooltip=label;
    el.querySelector('svg')?.classList.toggle('spin',job?.state==='running');
  });
  scheduleQuotaRefresh();
}
function canAutoRefresh(payload) {
  if (!quotaInitialized || quotaPaused) return false;
  if (payload) return accountRefreshInterval(payload.id, payload.profile) !== 'manual';
  return settings.liveRefreshInterval !== 'manual' || settings.spareRefreshInterval !== 'manual';
}
const refreshQueue = new AccountRefreshQueue({
  serialGroup: ({id}) => id === 'agy' ? id : undefined,
  canAutoRefresh,
  onChange:syncRefreshUi,
  run:async ({id,profile,source},force)=>{
    const key=refreshKey(id,profile);
    const startingAgent = agentsData.find(a=>a.id===id);
    if (!hasQuota(startingAgent)) return { skipped: true };
    const startingSnapshot = profile ? startingAgent?.profiles.find(p=>p.name===profile)?.meta.snapshot : startingAgent?.status;
    try {
      const result=check(await window.api.refreshAccount(id,profile,force,source));
      if (result.skipped) return result;
      const batch = refreshBatches.get(id);
      const agent = agentsData.find(a=>a.id===id);
      refreshFailedAt.delete(key);
      if (!batch) {
        await loadStatus(source === 'automatic' || source === 'on-open');
      } else if (agent) {
        const saved = agent.profiles.find(p => p.name === profile);
        if (startingAgent !== agent) {
          const revision = (profile ? saved?.meta.snapshot : agent.status)?.credentialRevision;
          if (!revision || (revision !== startingSnapshot?.credentialRevision && revision !== result.credentialRevision)) return result;
        }
        const checkingCandidate = saved?.meta.snapshot?.stagedReplacement || result.stagedReplacement;
        if (saved) saved.meta.snapshot = result;
        // Only the subsequent dashboard read can confirm which login a verified replacement reached.
        if ((!profile && !agent.active) || (saved?.isActive && !checkingCandidate)) agent.status = result;
        syncTray(true);
        updateAccountDetails();
        if (currentTab === id && !batch.frame) {
          batch.frame = requestAnimationFrame(() => {
            batch.frame = 0;
            if (refreshBatches.get(id) === batch && currentTab === id) renderWorkbench();
          });
        }
      }
      return result;
    } catch(error) {
      // IPC / file errors have no saved checkedAt from which to calculate backoff.
      refreshFailedAt.set(key,Date.now());
      throw error;
    }
  },
});
function requestRefresh(id,profile,force,priority,source = 'automatic') {
  const resolved=profile||agentsData.find(a=>a.id===id)?.profiles.find(p=>p.isActive)?.name;
  return refreshQueue.request(refreshKey(id,resolved),{id,profile:resolved,source},{force,priority,automatic:source === 'automatic' || source === 'on-open'});
}
async function refreshSelected(id = currentTab, profile, force = true, trigger, source = 'manual') {
  if (!hasQuota(agentsData.find(a=>a.id===id))) { await loadStatus(); return; }
  const restoreFocus=trigger?.matches(':focus-visible');
  const previousCheckedAt=detailAccount(id,profile).status?.checkedAt;
  let result;
  try { result=await requestRefresh(id,profile,force || accountRefreshInterval(id, profile) === 'manual',4,source); }
  finally {
    if(restoreFocus&&document.activeElement===document.body)[...document.querySelectorAll('[data-refresh-account]')].find(el=>refreshKey(el.dataset.agent,el.dataset.profile)===refreshKey(id,profile))?.focus({preventScroll:true});
  }
  if(force&&!result.skipped){
    if(result.state==='ok')showToast(result.checkedAt&&result.checkedAt===previousCheckedAt?'已使用最近查询结果':'账号额度已刷新');
    else showToast(result.extra||stateLabels[result.state]||'未取得额度',result.state==='error'?'error':'warn');
  }
}
function refreshAll(force = false, platform = currentTab, source = force ? 'manual' : 'automatic') {
  if (!force && (!canAutoRefresh() || statusRetryAt)) return Promise.resolve();
  const hot = source === 'on-open';
  const agents = agentsData.filter(a => hasQuota(a) && ((!force && !hot) || a.id === platform));
  return Promise.all(agents.map(agent => {
    let targets = refreshTargets(agent);
    if (hot) {
      const candidates = targets.filter(t => !t.live && t.switchable && Number.isFinite(t.hotRefreshAt));
      targets = targets.filter(t => t.live).concat(candidates.slice(0, 4));
    }
    if (!force) targets = targets.filter(t => canAutoRefresh(t) && (hot ? t.hotRefreshAt : t.deadline) <= Date.now());
    if (!targets.length) return;
    let batch = refreshBatches.get(agent.id);
    if (!batch) {
      batch = {requests:new Map(), manual:new Set(), completed:0};
      refreshBatches.set(agent.id, batch);
    }
    for (const t of targets) {
      if (force) batch.manual.add(t.key);
      // Completed rows stay in the pass; queued rows can be promoted by a later foreground action.
      if (batch.requests.has(t.key) && !refreshQueue.get(t.key)) continue;
      const priority = force ? (t.live ? 3 : 2) : hot ? 1.5 : t.live ? 1 : 0;
      const request = requestRefresh(t.id, t.profile, force || hot, priority, source);
      if (!batch.requests.has(t.key)) batch.requests.set(t.key, request.then(result => ({result}), error => ({error}))
        .then(outcome => { batch.completed++; syncRefreshUi(); return outcome; }));
    }
    if (!batch.promise) batch.promise = Promise.resolve().then(async () => {
      let count, outcomes;
      do {
        do {
          count = batch.requests.size;
          outcomes = await Promise.all(batch.requests.values());
        } while (batch.requests.size !== count);
        if (outcomes.some(o => !o.result?.skipped)) {
          if (loading) await loading;
          await loadStatus(!batch.manual.size);
        }
      } while (batch.requests.size !== count);
      if (batch.manual.size) {
        const done = (await Promise.all([...batch.manual].map(key => batch.requests.get(key)))).filter(o => !o.result?.skipped);
        const failed = done.filter(o => o.error || o.result?.state !== 'ok').length;
        if (done.length) showToast(failed ? `已检查 ${done.length} 个账号，${failed} 个未取得新额度` : `已检查 ${done.length} 个账号`, failed ? 'warn' : 'ok');
      }
    }).finally(() => {
      cancelAnimationFrame(batch.frame);
      refreshBatches.delete(agent.id);
      syncRefreshUi();
    });
    syncRefreshUi();
    return batch.promise;
  }));
}
async function handleSwitchProfile(id, name, source, decision) {
  if (switchingAccount) return;
  switchingAccount = true;
  syncTray();
  const tray = source === 'tray';
  let result;
  try {
    result = check(await window.api.useProfile(id, name, tray ? 'tray' : 'manual', decision));
    if (result.confirmation) return { confirmation: result.confirmation };
    if (result.canceled) return { canceled: true };
    if (!tray) showToast(result.clientRestartError || `已切换到 ${name}；已有终端会话请重新启动`, result.clientRestartError ? 'warn' : 'ok');
    if (tray && loading) await loading;
    await loadStatus();
  } finally { switchingAccount = false; syncTray(); }
  const refresh = !statusRetryAt && hasQuota(agentsData.find(a => a.id === id)) && settings.liveRefreshInterval !== 'manual'
    ? requestRefresh(id, name, false, 2, 'automatic').catch(() => {}) : undefined;
  if (tray) return { warning: [result.clientRestartError, ...(result.warnings || []), statusRetryAt && '账号已切换，暂时无法读取账号列表'].filter(Boolean).join('。') };
  await refresh;
}
async function handleDeleteProfile(id,name,target) {
  const dialog=target.closest('[data-account-details]');if(!dialog)return;
  const request={};dialog.deleteRequest=request;dialog.deletePreview=undefined;dialog.deleteLogout=false;
  dialog.dataset.deleteConfirm='';delete dialog.dataset.deleteError;
  updateAccountDetails();dialog.querySelector('[data-action="cancelDeleteProfile"]')?.focus();
  try {
    const preview=check(await window.api.previewDeleteProfile(id,name));
    if(dialog.isConnected&&dialog.deleteRequest===request)dialog.deletePreview=preview;
  } catch(error) {
    if(dialog.isConnected&&dialog.deleteRequest===request)dialog.dataset.deleteError=error.message;
  }
  if(dialog.isConnected&&dialog.deleteRequest===request)updateAccountDetails();
}
function cancelDeleteProfile(id,name,target) {
  const dialog=target.closest('[data-account-details]');if(!dialog||dialog.hasAttribute('data-deleting'))return;
  delete dialog.dataset.deleteConfirm;delete dialog.dataset.deleteError;
  delete dialog.deleteRequest;delete dialog.deletePreview;delete dialog.deleteLogout;
  updateAccountDetails();dialog.querySelector('[data-action="handleDeleteProfile"]')?.focus();
}
async function confirmDeleteProfile(id,name,target) {
  const dialog=target.closest('[data-account-details]');if(!dialog||!dialog.deletePreview||!dialog.hasAttribute('data-delete-confirm')||dialog.hasAttribute('data-deleting'))return;
  dialog.dataset.deleting='';dialog.setAttribute('aria-busy','true');
  dialog.querySelectorAll('button,input').forEach(el=>el.disabled=true);
  try {
    const result=check(await window.api.deleteProfile(id,name,{previewId:dialog.deletePreview.id,logout:dialog.deleteLogout===true}));
    if(result.canceled)return;
    for(const removed of result.removed)exportSelection.delete(profileKey(id,removed));
    await dialog.dismissAccountDialog(false);
    if(loading)await loading;
    await loadStatus();showToast(result.warning||(result.loggedOut?`已退出客户端并从 AGS 移除 ${name}`:`已从 AGS 移除 ${name}`),result.warning?'warn':'ok');
  } catch(error) {
    dialog.dataset.deleteError=error.message;
  } finally {
    delete dialog.dataset.deleting;dialog.removeAttribute('aria-busy');
    if(dialog.isConnected){dialog.querySelectorAll('button,input').forEach(el=>el.disabled=false);updateAccountDetails();dialog.querySelector('[data-action="cancelDeleteProfile"]')?.focus();}
  }
}
async function handleExportProfile(id,name) {
  const password=await askPassword();if(password===null)return;
  const result=check(await window.api.exportProfiles([{agent:id,profile:name}],password));
  if(!result.canceled)showToast(`已加密导出 ${name}`);
}
function installAccountNameEditor(dialog) {
  const title=dialog.querySelector('.account-dialog-head>strong');
  const heading=document.createElement('div');heading.className='account-name-heading';
  heading.innerHTML=`<div class="account-name-display"><strong></strong><button type="button" class="btn-icon-ghost" data-edit-account-name aria-label="重命名账号"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg></button></div><form class="account-name-editor" hidden novalidate><input class="account-name-input" name="name" aria-label="账号名称" maxlength="100" autocomplete="off" spellcheck="false"><button class="btn-icon-ghost" type="submit" aria-label="保存名称"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button><button class="btn-icon-ghost" type="button" data-cancel-name aria-label="取消重命名">${icon('close')}</button><p class="account-name-error" role="alert" hidden></p></form>`;
  const label=heading.querySelector('strong');label.textContent=title.textContent;title.replaceWith(heading);
  const view=heading.querySelector('.account-name-display'),form=heading.querySelector('form'),input=form.elements.name;
  const edit=heading.querySelector('[data-edit-account-name]'),errorBox=form.querySelector('.account-name-error'),close=dialog.querySelector('[data-close-dialog]');
  let saving=false,composing=false;
  const clearError=()=>{errorBox.hidden=true;errorBox.textContent='';input.removeAttribute('aria-invalid');};
  const finish=()=>{form.hidden=true;view.hidden=false;close.hidden=false;clearError();if(dialog.isConnected&&!dialog.hasAttribute('data-closing'))edit.focus({preventScroll:true});};
  const cancel=()=>{if(!saving)finish();};
  edit.addEventListener('click',()=>{input.value=label.textContent;clearError();view.hidden=true;form.hidden=false;close.hidden=true;input.focus();input.select();});
  form.querySelector('[data-cancel-name]').addEventListener('click',cancel);
  input.addEventListener('input',clearError);
  input.addEventListener('compositionstart',()=>{composing=true;});
  input.addEventListener('compositionend',()=>{composing=false;});
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape'&&!form.hidden){event.preventDefault();event.stopPropagation();if(!composing&&!event.isComposing)cancel();}});
  dialog.addEventListener('cancel',event=>{if(!form.hidden){event.preventDefault();event.stopImmediatePropagation();if(!composing)cancel();}},{capture:true});
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if(saving||composing)return;
    const id=dialog.dataset.agent,oldName=dialog.dataset.profile,newName=input.value.trim();
    if(!newName){errorBox.textContent='名称不能为空';errorBox.hidden=false;input.setAttribute('aria-invalid','true');input.focus();return;}
    if(newName===label.textContent){finish();return;}
    saving=true;form.setAttribute('aria-busy','true');
    for(const control of form.elements)control.disabled=true;
    try {
      check(await window.api.renameProfile(id,oldName,newName));
      dialog.dataset.profile=newName;dialog.setAttribute('aria-label',newName);label.textContent=newName;
      dialog.accountOrigin.name=newName;dialog.accountOrigin.trigger=undefined;
      if(exportSelection.delete(profileKey(id,oldName)))exportSelection.add(profileKey(id,newName));
      if(loading)await loading;
      await loadStatus();finish();showToast(`已重命名为 ${newName}`);
    } catch (error) { errorBox.textContent=error.message;errorBox.hidden=false;input.setAttribute('aria-invalid','true'); }
    finally { saving=false;form.removeAttribute('aria-busy');for(const control of form.elements)control.disabled=false;if(!form.hidden&&dialog.isConnected&&!dialog.hasAttribute('data-closing'))input.focus({preventScroll:true}); }
  });
}
async function handleRestartClient(id) {
  const result = check(await window.api.restartClient(id));
  if (!result.canceled) showToast(result.message);
}
async function handleOfficialLogin(id) {
  const result=check(await window.api.launchLogin(id));
  showToast(result.message);
  await loadStatus();
}
function showAddError(error) { $('addAccountError').textContent = error?.message || error || ''; }
const SESSION_INSTRUCTIONS = {
  codex: {
    label: 'Codex',
    file: '~/.codex/auth.json',
    mac: 'cat ~/.codex/auth.json | pbcopy',
    win: 'Get-Content ~\\.codex\\auth.json | Set-Clipboard',
    linux: 'cat ~/.codex/auth.json',
  },
  agy: {
    label: 'Antigravity',
    file: '个人 Google 账号凭据 JSON',
    mac: null, win: null, linux: null,
    hint: '导入后账号会加入账号池，点击「切换」可在本机使用。',
  },
};

function updateSessionGuide() {
  const agentId = activeDialog.agent || 'codex';
  const info = SESSION_INSTRUCTIONS[agentId] || SESSION_INSTRUCTIONS.codex;
  if ($('sessionGuideFile')) $('sessionGuideFile').textContent = info.file;
  if ($('sessionCmdMac')) $('sessionCmdMac').textContent = info.mac;
  if ($('sessionCmdWin')) $('sessionCmdWin').textContent = info.win;
  if ($('sessionCmdLinux')) $('sessionCmdLinux').textContent = info.linux;
  for(const [id,command] of [['sessionCmdMac',info.mac],['sessionCmdWin',info.win],['sessionCmdLinux',info.linux]]) $(id).closest('.session-guide-row').hidden=!command;
  document.querySelector('.session-extract-summary-title').textContent=agentId==='codex'?'对方机器如何提取凭据？查看终端指令':'凭据格式与来源';
  document.querySelector('.session-guide-hint').textContent=info.hint||'在对应系统终端运行后，复制凭据并粘贴到上方输入框即可。';
  $('sessionImportHint').hidden=agentId==='codex';
  $('sessionImportHint').textContent=agentId==='agy'?(canSaveLocal(agentsData.find(a=>a.id==='agy'))?'支持个人 Google 账号凭据；也可从「本地登录」保存账号。':'仅导入旧版文件凭据作为备份。'):'';
}

function updateAddAction() {
  const hasPreview = !!activeDialog.preview;
  const agent=agentsData.find(a=>a.id===activeDialog.agent);
  const isolatedLocal = hasIsolatedLogin(activeDialog.agent) && activeDialog.tab === 'local' && !hasPreview;
  const officialOnly=activeDialog.tab==='local'&&!canSaveLocal(agent)&&!isolatedLocal&&!hasPreview;
  const batch = hasPreview && activeDialog.preview.kind === 'credentials' && !activeDialog.updateTarget;
  const count = $('addImportPreview').querySelectorAll('[name="account"]:checked').length;
  $('modalProfileInput').required = activeDialog.tab === 'local' && !hasPreview && !officialOnly && !activeDialog.updateTarget;
  $('modalProfileInput').readOnly = activeDialog.login.updatable;
  $('modalProfileInput').hidden=officialOnly||!!activeDialog.updateTarget;
  document.querySelector('[for="modalProfileInput"]').hidden=officialOnly||!!activeDialog.updateTarget;
  $('localLoginHint').hidden=!agent?.management?.loginHint;
  $('localLoginHint').textContent=agent?.management?.loginHint||'';
  $('btnModalLaunch').textContent=activeDialog.updateTarget?'重新登录':agent?.management?.loginLabel||'登录其他账号';
  $('btnModalLaunch').disabled = activeDialog.busy;
  $('btnCopyLoginLink').hidden = !isolatedLocal;
  $('btnCopyLoginLink').disabled = activeDialog.busy;
  $('btnCopyLoginLink').setAttribute('aria-label', settings.openPrivateLogin !== false ? '无痕登录' : '复制登录链接');
  $('btnCopyLoginLink').dataset.tooltip = settings.openPrivateLogin !== false ? '在默认浏览器的无痕窗口中登录' : '复制登录链接，在本机无痕窗口中打开';
  $('btnDetectLogin').disabled = activeDialog.busy || activeDialog.login.betweenAccounts || (!!activeDialog.updateTarget && !activeDialog.login.isolated);
  $('addMoreOption').hidden = !isolatedLocal || !!activeDialog.updateTarget;
  $('keepAdding').disabled = activeDialog.busy;
  $('btnConfirmSave').hidden=officialOnly;
  $('sessionCredentials').required = activeDialog.tab === 'session' && !hasPreview;
  $('backupPassword').required = activeDialog.tab === 'backup' && !!activeDialog.encryptedImportId;
  $('backupPasswordField').hidden = !activeDialog.encryptedImportId;
  $('addPlatformField').hidden = !!activeDialog.updateTarget || activeDialog.tab === 'backup' || hasPreview;
  $('addAccountTitle').textContent = activeDialog.updateTarget ? '更新凭据' : '添加账号';
  $('saveModalOverlay').classList.toggle('credential-update-dialog',!!activeDialog.updateTarget);
  document.querySelector('.add-account-tabs').setAttribute('aria-label',activeDialog.updateTarget?'更新凭据方式':'添加账号方式');
  document.querySelector('.add-dialog-header [data-action="closeSaveModal"]').setAttribute('aria-label',activeDialog.updateTarget?'关闭更新凭据':'关闭添加账号');
  $('addTab-local').hidden = !!activeDialog.updateTarget && !hasIsolatedLogin(activeDialog.agent);
  $('addTab-local').textContent=activeDialog.updateTarget?'重新登录':'本地登录';
  $('addTab-session').textContent=activeDialog.updateTarget?'Session 更新':'Session 导入';
  $('addTab-backup').hidden=!!activeDialog.updateTarget;
  document.querySelector('.add-local-account .input-label').textContent=activeDialog.updateTarget?'登录状态':'检测到的账号';
  $('credentialUpdateTarget').hidden = !activeDialog.updateTarget;
  $('credentialUpdateTarget').textContent = activeDialog.updateTarget ? `${activeDialog.updateTarget.profile}${activeDialog.updateTarget.email?' · '+activeDialog.updateTarget.email:''}` : '';
  $('saveModalOverlay').classList.toggle('credential-import-dialog',!!batch);
  $('sessionCredentials').placeholder = activeDialog.updateTarget ? '粘贴完整的客户端凭据 JSON' : '粘贴客户端凭据 JSON（单个 / 多个账号）';
  $('btnAddBack').textContent = batch ? '重新选择' : activeDialog.login.betweenAccounts ? '完成' : '取消';
  $('btnAddBack').dataset.action = batch ? 'resetAddImport' : 'closeSaveModal';
  document.querySelectorAll('[data-add-tab]').forEach(el => { el.disabled = activeDialog.busy; el.setAttribute('aria-selected', el.dataset.addTab === activeDialog.tab); el.tabIndex = el.dataset.addTab === activeDialog.tab ? 0 : -1; });
  for (const tab of ['local', 'session', 'backup']) $(`addPanel-${tab}`).hidden = tab !== activeDialog.tab || hasPreview;
  $('addImportPreview').hidden = !hasPreview;

  const currentInputName = $('modalProfileInput')?.value.trim();
  const isDuplicateName = !activeDialog.updateTarget && !activeDialog.login.updatable && activeDialog.tab === 'local' && activeDialog.login.existingProfile && currentInputName && currentInputName !== activeDialog.login.existingProfile;
  const isUpdatingExisting = activeDialog.tab === 'local' && activeDialog.login.existingProfile && currentInputName === activeDialog.login.existingProfile;

  let confirmText = '保存账号';
  if (activeDialog.updateTarget) {
    const canCommit = hasPreview || activeDialog.tab === 'local';
    confirmText = activeDialog.busy ? (canCommit?'处理中…':'校验中…') : canCommit?'更新凭据':'校验凭据';
  }
  else if (hasPreview) {
    const selectable = activeDialog.preview.items.some(item=>['ready','update'].includes(item.state));
    const selectedUpdates = $('addImportPreview').querySelectorAll('[data-state="update"] [name="account"]:checked').length;
    confirmText = batch && !selectable ? '完成' : batch && count && selectedUpdates === count ? `更新 ${count} 个账号` : `导入 ${count} 个账号`;
  }
  else if (activeDialog.tab === 'local') confirmText = isUpdatingExisting ? '更新账号凭据' : '保存账号';
  else if (activeDialog.tab === 'session') confirmText = '解析凭据';
  else if (activeDialog.encryptedImportId) confirmText = '解锁备份';
  else confirmText = '选择备份';
  if (isolatedLocal && !activeDialog.updateTarget && $('keepAdding').checked) confirmText = isUpdatingExisting ? '更新并继续' : '保存并继续';
  $('btnConfirmSave').textContent = confirmText;

  let saveDisabled = activeDialog.busy;
  if (hasPreview) saveDisabled = saveDisabled || (!activeDialog.updateTarget && !count && (!batch || activeDialog.preview.items.some(item=>['ready','update'].includes(item.state))));
  else if (activeDialog.tab === 'local') saveDisabled = saveDisabled || !activeDialog.login.ready || !!isDuplicateName;
  $('btnConfirmSave').disabled = saveDisabled;
  $('modalPlatformSelect').disabled = activeDialog.busy;
  $('btnChooseBackup').disabled = activeDialog.busy;
  $('btnChooseSessionFile').disabled = activeDialog.busy;
  $('addImportPreview').querySelectorAll('button,input[type="checkbox"]').forEach(el=>{el.disabled=activeDialog.busy||el.hasAttribute('data-unavailable');});
  if (batch) {
    const invalid = updateCredentialImportSummary();
    $('btnConfirmSave').disabled = saveDisabled || !!invalid;
  }
  if (activeDialog.tab === 'session') updateSessionGuide();
}
function clearAddImport() {
  activeDialog.preview = undefined; activeDialog.encryptedImportId = undefined;
  $('addImportPreview').replaceChildren(); $('backupPassword').value = '';
  $('backupFileName').textContent = '支持 .ags 加密备份和 .zip 备份';
  if ($('sessionExtractDetails')) $('sessionExtractDetails').open = false;
}
function pollLocalAccount() {
  clearInterval(activeDialog.pollTimer); activeDialog.pollTimer = null;
  if (activeDialog.tab !== 'local' || !$('saveModalOverlay').open || activeDialog.login.betweenAccounts || (activeDialog.updateTarget && !activeDialog.login.isolated)) return;
  handleModalDetect().catch(showAddError);
  if (!canSaveLocal(agentsData.find(a=>a.id===activeDialog.agent)) && !activeDialog.login.isolated) return;
  activeDialog.pollTimer = setInterval(() => handleModalDetect().catch(showAddError), 2500);
}
function resetLocalDraft(label) {
  activeDialog.login = {};
  $('modalProfileInput').value = '';
  $('modalAccountEmail').textContent = label;
}
async function selectAddTab(tab) {
  if (activeDialog.busy || tab === activeDialog.tab || !['local','session','backup'].includes(tab) || $(`addTab-${tab}`).hidden) return;
  const session = ++activeDialog.generation;
  activeDialog.busy = true;
  clearInterval(activeDialog.pollTimer);
  const cleanup = activeDialog.tab === 'local' && hasIsolatedLogin(activeDialog.agent) ? window.api.cancelLogin(activeDialog.agent) : undefined;
  const clearPreview = activeDialog.preview || activeDialog.encryptedImportId ? window.api.cancelImport() : undefined;
  clearAddImport(); showAddError(''); activeDialog.tab = tab;
  resetLocalDraft(activeDialog.updateTarget?'等待重新登录':'检测中…');
  updateAddAction();
  try {
    await Promise.all([cleanup,clearPreview].filter(Boolean).map(p=>p.then(check)));
  } finally {
    if (session === activeDialog.generation) { activeDialog.busy = false; updateAddAction(); pollLocalAccount(); }
  }
}
function openSaveModal(id, updateTarget) {
  if (!agentEnabled(id)) return;
  clearInterval(activeDialog.pollTimer);
  activeDialog = newAccountDialog(activeDialog.generation + 1);
  const list = agentsData.length ? agentsData : DEFAULT_AGENTS;
  activeDialog.agent = list.some(a => a.id === id) ? id : (list.some(a => a.id === lastAgentTab) ? lastAgentTab : list[0].id);
  $('modalPlatformSelect').innerHTML = platformOptions(list, activeDialog.agent);
  $('modalPlatformSelect').value = activeDialog.agent;
  resetLocalDraft('检测中…'); $('sessionCredentials').value = '';
  $('keepAdding').checked = false;
  activeDialog.updateTarget = updateTarget;
  if (activeDialog.updateTarget) $('modalAccountEmail').textContent='等待重新登录';
  clearAddImport(); showAddError('');
  const local = hasIsolatedLogin(activeDialog.agent) || (!updateTarget && canSaveLocal(list.find(a=>a.id===activeDialog.agent)));
  activeDialog.tab = local ? 'local' : 'session';
  $('saveModalOverlay').showModal(); updateAddAction(); pollLocalAccount();
  $(activeDialog.tab==='session'?'sessionCredentials':activeDialog.updateTarget?'btnModalLaunch':'modalProfileInput').focus();
}
async function openCredentialUpdate(id,name,target) {
  const {p,status}=detailAccount(id,name);
  if(!p||!canUpdateCredentials(p, status))throw new Error('此账号当前没有认证异常');
  await target?.closest('[data-account-details]')?.dismissAccountDialog(false);
  openSaveModal(id,{profile:name,email:p.meta.email||status?.account});
}
async function closeSaveModal() {
  if (!$('saveModalOverlay').open) return;
  clearInterval(activeDialog.pollTimer);
  activeDialog = newAccountDialog(activeDialog.generation + 1);
  $('saveModalOverlay').close(); clearAddImport(); $('sessionCredentials').value = '';
  await Promise.all([window.api.cancelLogin(), window.api.cancelImport()].map(p => p.then(check)));
}
async function handleModalDetect() {
  if (!activeDialog.agent || activeDialog.tab !== 'local' || !$('saveModalOverlay').open || activeDialog.busy || activeDialog.login.betweenAccounts || (activeDialog.updateTarget && !activeDialog.login.isolated)) return;
  const id = activeDialog.agent, session = activeDialog.generation;
  try {
    const res = await window.api.loginStatus(id);
    const status = check(res);
    if (session !== activeDialog.generation || activeDialog.busy || activeDialog.login.betweenAccounts) return;
    if (activeDialog.login.isolated && !status.isolated) {
      activeDialog.login.ready = false;
      $('modalAccountEmail').textContent = '等待重新登录';
      updateAddAction();
      return;
    }
    activeDialog.login.ready = status.ready;
    activeDialog.login.existingProfile = status.existingProfile;
    activeDialog.login.updatable = !!status.existingProfileUpdatable;
    activeDialog.login.attempt = status.ready ? status.attempt : undefined;
    if (activeDialog.updateTarget) {
      activeDialog.login.ready = !!status.ready && status.isolated && status.updateProfile === activeDialog.updateTarget.profile && status.matchesTarget === true;
      $('modalAccountEmail').textContent = status.account || '等待重新登录';
      if (status.ready && !activeDialog.login.ready) showAddError('登录的账号或工作区与待更新账号不一致，请重新登录对应账号。');
      else showAddError(status.errorMessage || '');
      updateAddAction();
      return;
    }
    const email = status.email || (status.account?.includes('@') ? status.account : '');
    const suggestion = status.existingProfile || (status.ready ? email.replace(/[@.]/g, '-') : '');
    const input = $('modalProfileInput');
    if (activeDialog.login.updatable || !input.value || input.value === activeDialog.login.suggestedName) input.value = suggestion || '';
    activeDialog.login.suggestedName = suggestion || '';

    if (status.existingProfile) {
      const emailText = status.account || '已检测到凭据';
      $('modalAccountEmail').innerHTML = `${escapeHTML(emailText)} <span class="pill-badge pill-standby">${activeDialog.login.updatable?'将更新':'已添加为'}「${escapeHTML(status.existingProfile)}」</span>`;
      const currentName = $('modalProfileInput').value.trim();
      if (!activeDialog.login.updatable && currentName !== status.existingProfile) {
        showAddError(`该账号已存在于「${status.existingProfile}」，不能重复添加。可在「本地登录」中登录其他账号。`);
      } else if ($('addAccountError').textContent.includes('已存在于')) {
        showAddError('');
      }
    } else {
      $('modalAccountEmail').textContent = status.account || '等待登录';
      if ($('addAccountError').textContent.includes('已存在于')) showAddError('');
      if (status.errorMessage) showAddError(status.errorMessage);
    }
  } catch (err) {
    if (session === activeDialog.generation && !activeDialog.busy && !activeDialog.login.betweenAccounts) {
      activeDialog.login.ready = false;
      $('modalAccountEmail').textContent = '等待登录';
      showAddError(err);
    }
  }
  updateAddAction();
}
async function handleLaunchLogin(id, mode = 'open') {
  if (!$('saveModalOverlay').open) openSaveModal(id);
  if (activeDialog.busy || activeDialog.tab !== 'local') return;
  const session = ++activeDialog.generation;
  const seenAttempt = activeDialog.login.attempt;
  activeDialog.login.isolated = hasIsolatedLogin(activeDialog.agent);
  activeDialog.busy = true; activeDialog.login.betweenAccounts = false; activeDialog.login.ready = false;
  activeDialog.login.attempt = undefined; activeDialog.login.existingProfile = undefined; activeDialog.login.updatable = false;
  if ($('modalProfileInput').value === activeDialog.login.suggestedName) $('modalProfileInput').value = '';
  activeDialog.login.suggestedName = '';
  $('modalAccountEmail').textContent = hasIsolatedLogin(activeDialog.agent) ? '正在准备登录链接…' : '正在打开登录…';
  showAddError(''); updateAddAction();
  try {
    const result = check(await window.api.launchLogin(activeDialog.agent, mode, seenAttempt, activeDialog.updateTarget?.profile));
    if (session !== activeDialog.generation || result.canceled) return;
    activeDialog.loginMode = mode; showToast(result.message);
  } catch (error) {
    if (session === activeDialog.generation) showAddError(error);
  } finally {
    if (session === activeDialog.generation) { activeDialog.busy = false; updateAddAction(); pollLocalAccount(); }
  }
}
async function reloginAccount(id,name) {
  openSaveModal(id);
  $('modalProfileInput').value=name;
  await handleLaunchLogin(id);
}
async function confirmSaveProfile() {
  const id = activeDialog.agent, session = activeDialog.generation;
  const name = $('modalProfileInput').value.trim();
  if (!name) throw new Error('请输入账号名称');
  const keepAdding = hasIsolatedLogin(id) && $('keepAdding').checked;
  const result = check(await window.api.saveProfile(id, name, activeDialog.login.attempt));
  const savedName = result.profile || name;
  if (session === activeDialog.generation) {
    if (keepAdding) {
      activeDialog.generation++; activeDialog.busy = false;
      resetLocalDraft('请登录下一个账号');
      activeDialog.login.betweenAccounts = true;
      showAddError(''); updateAddAction(); pollLocalAccount();
      $(activeDialog.loginMode === 'open' ? 'btnModalLaunch' : 'btnCopyLoginLink').focus();
    } else await closeSaveModal();
  }
  if (result.warnings?.length) { await loadStatus(); showToast(result.warnings.join(' '),'warn'); return; }
  showToast(`已${result.updated?'更新':'保存'} ${savedName}`); await loadStatus();
  if (!hasQuota(agentsData.find(a=>a.id===id)) || accountRefreshInterval(id, savedName) === 'manual') return;
  if (keepAdding) void requestRefresh(id, savedName, true, 2).catch(() => {});
  else await refreshSelected(id, savedName, true, undefined, 'automatic');
}
function credentialImportDrafts() {
  return new Map([...$('addImportPreview').querySelectorAll('.credential-import-row')].map(row=>[
    row.dataset.key, { name:row.querySelector('[name="import-name"]')?.value ?? activeDialog.preview.items.find(item=>item.key===row.dataset.key)?.profile, selected:row.querySelector('[name="account"]')?.checked },
  ]));
}
function updateCredentialImportSummary() {
  const inputs = [...$('addImportPreview').querySelectorAll('[name="import-name"]')];
  const names = new Map();
  let error = '';
  const count = $('addImportPreview').querySelectorAll('[name="account"]:checked').length;
  const updating = $('addImportPreview').querySelectorAll('[data-state="update"] [name="account"]:checked').length;
  for (const input of inputs) {
    const row=input.closest('.credential-import-row'), selected=row.querySelector('[name="account"]').checked;
    input.disabled=activeDialog.busy||!selected; input.removeAttribute('aria-invalid');
    if (!selected) continue;
    const value=input.value.trim(), key=`${row.dataset.agent}/${value.normalize('NFC').toLowerCase()}`;
    const nameError=profileNameError(value);
    let invalid=!!nameError;
    if(invalid)error ||= nameError;
    if(names.has(key)){names.get(key).setAttribute('aria-invalid','true');invalid=true;error ||= '所选账号名称重复，请修改后导入';}
    names.set(key,input);
    if(agentsData.find(a=>a.id===row.dataset.agent)?.profiles.some(p=>p.name.normalize('NFC').toLowerCase()===value.normalize('NFC').toLowerCase())) {invalid=true;error ||= `名称「${value}」已被使用`;}
    if(invalid)input.setAttribute('aria-invalid','true');
  }
  const drafts=credentialImportDrafts();
  for(const row of $('addImportPreview').querySelectorAll('[data-state="duplicate"]')) {
    const item=activeDialog.preview.items.find(item=>item.key===row.dataset.key);
    if(item.duplicate.source==='batch') {
      const label=`本次重复 · ${drafts.get(item.duplicate.key)?.name||item.duplicate.profile}`;
      const state=row.querySelector('.credential-import-state');state.textContent=label;state.title=label;
    }
  }
  const skipped=activeDialog.preview.items.filter(item=>item.state==='duplicate').length, failed=activeDialog.preview.items.filter(item=>item.state==='error').length;
  const summary=$('credentialImportSummary');
  const selectedSummary=updating?[count-updating?`${count-updating} 个待新增`:null,`${updating} 个待更新`].filter(Boolean).join(' · '):`${count} 个待导入`;
  summary.textContent=error||[selectedSummary,skipped?`${skipped} 个重复`:null,failed?`${failed} 个无法导入`:null].filter(Boolean).join(' · ');
  summary.classList.toggle('import-error',!!error);
  const checks=[...$('addImportPreview').querySelectorAll('[name="account"]:not([data-unavailable])')], all=$('importSelectAll');
  all.checked=checks.length>0&&checks.every(check=>check.checked);all.indeterminate=count>0&&count<checks.length;
  return error;
}
function credentialImportContent(preview, drafts) {
  const rows=preview.items.map((item,i)=>{
    const ready=['ready','update'].includes(item.state),draft=drafts.get(item.key);
    const selected=ready&&(draft?.selected??true), name=draft?.name??item.profile;
    const duplicate=item.duplicate;
    const state=duplicate?(duplicate.source==='pool'?`已存在 · ${duplicate.profile}`:`本次重复 · ${drafts.get(duplicate.key)?.name||duplicate.profile}`):item.error||'格式无法识别';
    const identity=item.email||item.profile||(item.sourceIndex?`第 ${item.sourceIndex} 项`:item.fileName||'客户端凭据');
    return `<div class="credential-import-row" data-key="${escapeHTML(item.key)}" data-agent="${escapeHTML(item.agent||'')}" data-state="${escapeHTML(item.state)}">
      <input type="checkbox" name="account" value="${i}" ${selected?'checked':''} ${ready?'':'disabled data-unavailable'} aria-label="导入 ${escapeHTML(identity)}">
      <div class="credential-import-identity"><span title="${escapeHTML(identity)}">${escapeHTML(identity)}</span></div>
      ${item.state==='update'?`<span class="credential-import-state" title="更新凭据，保留原名称 ${escapeHTML(item.profile)}">更新 · ${escapeHTML(item.profile)}</span>`:ready?`<input name="import-name" class="modal-input credential-import-name" aria-label="${escapeHTML(item.email||item.fileName||name)} 的账号名称" maxlength="100" value="${escapeHTML(name)}" ${selected?'':'disabled'}>`:`<span class="credential-import-state" title="${escapeHTML(state)}">${escapeHTML(state)}</span>`}
    </div>`;
  }).join('');
  const fileName=preview.items.find(item=>item.fileName)?.fileName, recognized=preview.items.filter(item=>item.state!=='error').length;
  return `<div class="credential-import-heading"><span>${recognized?`已识别 ${recognized} 个账号`:'未识别到账号'}</span>${fileName?`<span class="credential-import-source" title="${escapeHTML(fileName)}">${escapeHTML(fileName)}</span>`:''}</div>
    <div class="credential-import-list"><div class="credential-import-head"><input type="checkbox" id="importSelectAll" aria-label="选择全部可导入账号"><span>账号</span><span>名称</span></div>${rows}</div><p id="credentialImportSummary" class="credential-import-summary" aria-live="polite"></p>`;
}
function showAddPreview(preview, drafts = new Map()) {
  if (!preview || preview.canceled) return;
  if (!$('saveModalOverlay').open) { window.api.cancelImport(); return; }
  activeDialog.encryptedImportId = undefined; activeDialog.preview = preview;
  $('backupPassword').value = ''; $('sessionCredentials').value = '';
  $('addImportPreview').innerHTML = activeDialog.updateTarget
    ? `<p class="detail-note">账号身份一致，将替换凭据并保留原账号信息。</p><button class="btn btn-sm" type="button" data-action="resetAddImport">重新选择</button>`
    : preview.kind==='credentials' ? credentialImportContent(preview,drafts)
    : `<label class="import-select-all"><input type="checkbox" id="importSelectAll" checked>全选</label><div class="import-list">${preview.items.map((item, i) => `<label class="import-row"><input type="checkbox" name="account" value="${i}" checked><span><strong>${escapeHTML(item.profile)}</strong><small>${escapeHTML(agentsData.find(a => a.id === item.agent)?.label || item.agent)}${item.email ? ' · ' + escapeHTML(item.email) : ''}</small></span></label>`).join('')}</div><p class="detail-note">同一账号凭据失效时更新，正常时跳过；仅名称相同的新账号另存。</p><button class="btn btn-sm" type="button" data-action="resetAddImport">重新选择</button>`;
  if (preview.skippedProfiles > 0) {
    const note = document.createElement('p');
    note.className = 'detail-note';
    note.textContent = `已跳过 ${preview.skippedProfiles} 个不受支持的平台账号`;
    $('addImportPreview').prepend(note);
  }
  updateAddAction();
}
async function chooseImportFile(kind = activeDialog.tab === 'session' ? 'credentials' : 'backup') {
  if(activeDialog.busy)return;
  const session=activeDialog.generation;
  showAddError(''); activeDialog.busy = true; updateAddAction();
  try {
    const preview = check(await (activeDialog.updateTarget ? window.api.previewCredentialUpdate(activeDialog.agent,activeDialog.updateTarget.profile) : window.api.previewImport(kind,kind==='credentials'?activeDialog.agent:undefined)));
    if(session!==activeDialog.generation)return;
    if (preview.canceled) return;
    if (!$('saveModalOverlay').open) { await window.api.cancelImport(); return; }
    clearAddImport();
    if (preview.needsPassword) {
      activeDialog.tab = 'backup'; activeDialog.encryptedImportId = preview.id;
      $('backupFileName').textContent = preview.fileName || '已选择加密备份';
      $('backupPassword').value = '';
    } else showAddPreview(preview);
  } finally { if(session===activeDialog.generation){activeDialog.busy = false; updateAddAction();} }
  if (activeDialog.encryptedImportId) $('backupPassword').focus();
}
async function resetAddImport() {
  if(activeDialog.busy)return;
  check(await window.api.cancelImport()); clearAddImport(); showAddError(''); updateAddAction();
}
async function submitAddAccount(event) {
  event.preventDefault();
  if (activeDialog.busy || (activeDialog.tab === 'local' && !activeDialog.login.ready)) return;
  const session = activeDialog.generation;
  showAddError(''); activeDialog.busy = true; updateAddAction();
  if (activeDialog.tab === 'local') $('btnConfirmSave').textContent = activeDialog.updateTarget || activeDialog.login.updatable ? '更新中…' : '保存中…';
  try {
    if (activeDialog.updateTarget && (activeDialog.preview || activeDialog.tab === 'local')) {
      const result = check(await (activeDialog.tab === 'local'
        ? window.api.updateFromLogin(activeDialog.agent,activeDialog.updateTarget.profile,activeDialog.login.attempt)
        : window.api.commitCredentialUpdate(activeDialog.preview.id)));
      if (session === activeDialog.generation) await closeSaveModal();
      if (result.warning) { await loadStatus(); showToast(result.warning,'warn'); return; }
      await loadStatus();
      if (!hasQuota(agentsData.find(a=>a.id===result.agent))) {
        showToast(result.staged ? '凭据已暂存，启用官方 CLI 后可验证' : '凭据已更新'); return;
      }
      if (accountRefreshInterval(result.agent, result.profile) === 'manual') {
        showToast(result.staged ? '凭据已暂存，可刷新此账号验证' : '凭据已更新'); return;
      }
      showToast(result.staged ? '凭据已暂存，正在验证归属与额度' : '凭据已更新，正在查询额度');
      try {
        const status = await requestRefresh(result.agent,result.profile,true,2);
        if (status.skipped) return;
        if(status.state==='ok')showToast(status.extra || '凭据已更新，额度已刷新',status.extra?'warn':'ok');
        else if(result.staged){await loadStatus();showToast(status.extra||'未能验证新凭据，已保留原凭据；请使用「重新登录」更新','warn');}
        else showToast(credentialsExpired(status)?'已替换凭据，但验证仍未通过，请使用最新的凭据':`凭据已更新；${status.extra||'暂未取得额度'}`,'warn');
      } catch (error) { showToast(error.message || '暂未取得验证结果，请刷新账号状态','warn'); }
    } else if (activeDialog.preview) {
      const keys = [...$('addImportPreview').querySelectorAll('[name="account"]:checked')].map(c => activeDialog.preview.items[Number(c.value)].key);
      const names=activeDialog.preview.kind==='credentials'?Object.fromEntries([...credentialImportDrafts()].filter(([key,draft])=>keys.includes(key)).map(([key,draft])=>[key,draft.name.trim()])):undefined;
      if(activeDialog.preview.kind==='credentials'&&updateCredentialImportSummary())return;
      const result = check(await window.api.commitImport(activeDialog.preview.id, keys, names));
      if (session === activeDialog.generation) await closeSaveModal();
      showToast(`导入完成：新增 ${result.imported.length} 个${result.updated?.length?`，更新 ${result.updated.length} 个`:''}，跳过重复 ${result.skipped?.length||0} 个${result.failed?.length?`，无法导入 ${result.failed.length} 个`:''}`,result.failed?.length?'warn':'ok'); await loadStatus();
      const changed = [...new Set([...result.imported,...(result.updated||[])])].filter(key=>{
        const [agentId, profileName] = [key.split('/')[0], key.slice(key.indexOf('/')+1)];
        return hasQuota(agentsData.find(a=>a.id===agentId)) && accountRefreshInterval(agentId, profileName) !== 'manual';
      });
      await Promise.allSettled(changed.map(key=>requestRefresh(key.split('/')[0],key.slice(key.indexOf('/')+1),true,1)));
    } else if (activeDialog.tab === 'local') await confirmSaveProfile();
    else if (activeDialog.tab === 'session' || activeDialog.encryptedImportId) {
      const preview = check(await (activeDialog.tab === 'backup'
        ? window.api.unlockImport(activeDialog.encryptedImportId, $('backupPassword').value)
        : activeDialog.updateTarget
          ? window.api.previewCredentialUpdate(activeDialog.agent,activeDialog.updateTarget.profile,$('sessionCredentials').value)
          : window.api.previewCredentials($('sessionCredentials').value, activeDialog.agent)));
      if (session === activeDialog.generation) showAddPreview(preview);
    }
    else { activeDialog.busy = false; await chooseImportFile('backup'); }
  } catch (error) { if (session === activeDialog.generation) showAddError(error); }
  finally { if (session === activeDialog.generation) { activeDialog.busy = false; updateAddAction(); } }
}
$('addAccountForm').addEventListener('submit', submitAddAccount);
$('saveModalOverlay').addEventListener('cancel', event => { event.preventDefault(); closeSaveModal().catch(error => showToast(error.message, 'error')); });
document.querySelector('.add-account-tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-add-tab]');
  if (tab) selectAddTab(tab.dataset.addTab).catch(showAddError);
});
document.querySelector('.add-account-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...document.querySelectorAll('[data-add-tab]:not([hidden])')].map(el=>el.dataset.addTab);
  const next = tabs[(tabs.indexOf(activeDialog.tab) + (event.key === 'ArrowRight' ? 1 : tabs.length-1)) % tabs.length];
  selectAddTab(next).then(() => $(`addTab-${next}`).focus()).catch(showAddError);
});
$('keepAdding').addEventListener('change', updateAddAction);
$('modalPlatformSelect').addEventListener('change', () => {
  if (!agentEnabled($('modalPlatformSelect').value)) { $('modalPlatformSelect').value = activeDialog.agent; return; }
  if (hasIsolatedLogin(activeDialog.agent) && activeDialog.tab === 'local') window.api.cancelLogin(activeDialog.agent).then(check).catch(showAddError);
  activeDialog.generation++;
  activeDialog.agent = $('modalPlatformSelect').value || 'codex';
  resetLocalDraft('检测中…'); showAddError(''); updateAddAction(); pollLocalAccount();
});
$('modalProfileInput').addEventListener('input', () => {
  if (activeDialog.login.existingProfile) {
    const val = $('modalProfileInput').value.trim();
    if (val && val !== activeDialog.login.existingProfile) {
      showAddError(`该账号已存在于「${activeDialog.login.existingProfile}」，不能使用其他名称重复添加`);
    } else {
      showAddError('');
    }
  }
  updateAddAction();
});
$('addImportPreview').addEventListener('change', event => {
  const checks = [...$('addImportPreview').querySelectorAll('[name="account"]:not([data-unavailable])')], all = $('importSelectAll');
  if(!all)return;
  if (event.target === all) checks.forEach(c => { c.checked = all.checked; });
  const count = checks.filter(c => c.checked).length;
  all.checked = count === checks.length; all.indeterminate = count > 0 && count < checks.length;
  updateAddAction();
});
$('addImportPreview').addEventListener('input',event=>{if(event.target.matches('[name="import-name"]')){showAddError('');updateAddAction();}});
function askPassword() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'password-dialog';
    dialog.innerHTML = `<form><strong>加密导出</strong><div class="detail-note">备份包含账号登录凭据。请设置至少 6 个字符的密码。</div><input class="modal-input" type="password" name="password" autocomplete="new-password" aria-label="备份密码" required minlength="6"><input class="modal-input" type="password" name="repeat" autocomplete="new-password" aria-label="再次输入密码" placeholder="再次输入密码" required><div class="detail-actions"><button class="btn" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit">选择保存位置</button></div></form>`;
    const done = value => { dialog.close(); dialog.remove(); resolve(value); };
    dialog.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); done(null); });
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget, password = form.elements.password.value;
      if (password !== form.elements.repeat.value) { form.elements.repeat.setCustomValidity('两次密码不一致'); form.elements.repeat.reportValidity(); return; }
      done(password);
    });
    dialog.addEventListener('input', () => dialog.querySelector('[name="repeat"]').setCustomValidity(''));
    document.body.appendChild(dialog); dialog.showModal();
  });
}
async function handleDeleteSelected() {
  if (!exportSelection.size) return;
  const items = [...exportSelection].map(key => { const [agent, profile] = key.split('/'); return { agent, profile }; });
  const previews=[],covered=new Set();
  for(const item of items) {
    if(covered.has(profileKey(item.agent,item.profile)))continue;
    const preview=check(await window.api.previewDeleteProfile(item.agent,item.profile));
    previews.push({...item,preview});
    for(const name of preview.profiles)covered.add(profileKey(item.agent,name));
  }
  if (!confirm(`从 AGS 移除以下 ${covered.size} 份备份及其缓存？\n${[...covered].join('\n')}\n\n客户端登录、历史记录和项目文件将保留。`)) return;
  let removed=0;
  try {
    for(const {agent,profile,preview} of previews) {
      const result=check(await window.api.deleteProfile(agent,profile,{previewId:preview.id,logout:false}));
      for(const name of result.removed){exportSelection.delete(profileKey(agent,name));removed++;}
    }
    selecting=false;
    showToast(`已从 AGS 移除 ${removed} 份备份`);
  } catch(error) { throw new Error(`已移除 ${removed} 份备份；${error.message}`); }
  finally { await loadStatus(); }
}
const actions = {
  selectTab, openSaveModal: id=>openSaveModal(id), openCredentialUpdate, closeSaveModal, handleModalDetect,
  handleLaunchLogin: id => handleLaunchLogin(id), privateLogin: id => handleLaunchLogin(id, 'private'), handleOfficialLogin, reloginAccount,
  handleSwitchProfile, handleDeleteProfile, cancelDeleteProfile, confirmDeleteProfile, handleExportProfile, handleDeleteSelected, handleRestartClient, chooseImportFile: (_id, _profile, target) => chooseImportFile(target.dataset.kind), resetAddImport,
  startSelection, endSelection, toggleExport, selectAllExport, exportSelected, toggleSidebar,
  setAccountLayout: (_id, _profile, target) => setAccountLayout(target.dataset.layout), toggleAccountGroup, moveAccountGroup, openResetCards,
  copyCleanupPrompt: async () => { check(await window.api.copyCleanupPrompt());showToast('清理指令已复制，尚未执行清理'); },
  exportDiagnostics: async () => {
    const result = check(await window.api.exportDiagnostics());
    if (!result.canceled) showToast('故障报告已保存，可发给维护者');
  },
  refreshSelected: (id,profile,target) => refreshSelected(id,profile,true,target),
  openAntigravityInstall: () => window.api.openAntigravityInstall().then(check),
  recheckAntigravityCli: async (_id, _profile, target) => {
    target.disabled = true;
    if (loading) await loading;
    try { await loadStatus(false, window.api.recheckAntigravityCli); }
    finally { target.disabled = false; }
  },
  loadStatus: () => hasQuota(agentsData.find(a=>a.id===currentTab))?refreshAll(true):loadStatus(),
  copyInstruction: async (_id, _profile, target) => {
    const codeId = target.dataset.copyId;
    const el = $(codeId);
    if (!el) return;
    const text = el.textContent.trim();
    await navigator.clipboard.writeText(text);
    const copyBtn = target.tagName === 'BUTTON' ? target : target.parentElement?.querySelector('.btn-copy-cmd');
    if (copyBtn) {
      const oldText = copyBtn.textContent;
      copyBtn.textContent = '已复制';
      copyBtn.classList.add('btn-copied');
      setTimeout(() => {
        if (copyBtn.isConnected) {
          copyBtn.textContent = oldText;
          copyBtn.classList.remove('btn-copied');
        }
      }, 1500);
    }
    showToast('指令已复制到剪贴板');
  },
};
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
  if (target.dataset.action === 'appUpdate') { await handleAppUpdateAction(target.dataset.updateAction); return; }
  const action = actions[target.dataset.action];
  if (!action) return;
  if (target.tagName === 'BUTTON' && !target.matches('[data-refresh-account]')) target.disabled = true;
  try { await action(target.dataset.agent || currentTab, target.dataset.profile, target); }
  catch (error) { if (target.closest('#saveModalOverlay')) showAddError(error); else showToast(error.message, 'error'); }
  finally { if (target.isConnected && target.tagName === 'BUTTON') target.disabled = false; }
});
function openAccountContext(event) {
  if(selecting||event.defaultPrevented||document.querySelector('dialog[open]'))return;
  const card=event.target.closest('[data-account-context]');
  if(!card)return;
  event.preventDefault();
  inputModality=event.type==='keydown'?'keyboard':'pointer';
  const trigger=event.target.closest('button,[tabindex="0"]')||card;
  openAccountDetails(card.dataset.agent,card.dataset.profile,trigger);
}
document.addEventListener('pointerdown',event=>{
  inputModality='pointer';
  document.querySelectorAll('[data-keyboard-focus]').forEach(element=>element.removeAttribute('data-keyboard-focus'));
},true);
document.addEventListener('keydown',()=>{inputModality='keyboard';},true);
document.addEventListener('focusout',event=>{event.target.removeAttribute('data-keyboard-focus');});
document.addEventListener('contextmenu',openAccountContext);
document.addEventListener('input', event => {
  if (event.target.id === 'accountSearch') { filter = event.target.value; renderCards(); }
});
document.addEventListener('change', async event => {
  if (event.target.id === 'autoCheckUpdates') { await handleAppUpdateAction('auto', event.target.checked); return; }
  if(event.target.matches('[data-delete-logout]')) {
    const dialog=event.target.closest('[data-account-details]');
    if(dialog){dialog.deleteLogout=event.target.checked;updateAccountDetails();dialog.querySelector('[data-delete-logout]')?.focus();}
    return;
  }
  if (!event.target.matches('.setting-options input')) return;
  document.querySelectorAll('.setting-options input').forEach(input => { input.disabled = true; });
  const { name, value } = event.target;
  const isRefreshInterval = name === 'liveRefreshInterval' || name === 'spareRefreshInterval';
  try {
    settings = check(await window.api.saveSettings({ ...settings, [name]: isRefreshInterval ? value : value === 'true' }));
    if (name === 'showResetTimes') syncTray();
    if (isRefreshInterval) {
      if (loading) await loading;
      await loadStatus();
    }
  }
  catch (error) { showToast(error.message, 'error'); }
  finally {
    document.querySelectorAll('.setting-options input').forEach(input => {
      input.checked = String(settings[input.name]) === input.value; input.disabled = false;
    });
  }
});
document.addEventListener('keydown', event => {
  if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){openAccountContext(event);return;}
  if (event.target.matches('.active-session-card.selectable') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.click(); }
  else if(event.key==='Enter'&&event.target.matches('[data-account-context]'))openAccountContext(event);
});
async function resumeQuotaRefresh(platform) {
  if (!quotaInitialized || quotaPaused) return;
  await loadStatus(true);
  if (canAutoRefresh() && !statusRetryAt) return platform ? refreshAll(false, platform, 'on-open') : refreshAll(false);
}
window.api.onQuotaPower?.(paused => {
  quotaPaused = paused;
  clearTimeout(quotaRefreshTimer);
  if (!paused) void resumeQuotaRefresh();
});
window.api.onQuotaOpen?.(platform => {
  const selected = platform || currentTab;
  if (quotaInitialized) void resumeQuotaRefresh(selected);
  else initialOpenPlatform = selected;
});
// Age the tray snapshot and reset labels without another network request.
let mainWindowVisible = !document.hidden;
window.api.onMainVisibility?.(visible => { mainWindowVisible = visible; });
setInterval(() => {
  if (quotaPaused) return;
  const freshCount = freshTrayRows.length;
  freshTrayRows = freshTrayRows.filter(({row,status,agent,isLive}) => {
    if (!stale(status, agent, isLive)) return true;
    row.cached = true;
    return false;
  });
  syncTray(false, freshTrayRows.length !== freshCount);
  if (mainWindowVisible && currentTab !== 'settings' && !selecting && !document.querySelector('dialog[open], details[open]') && !$('accountSearch')?.matches(':focus')) renderWorkbench();
}, 30000);
const resizer = $('sidebarResizer');
let resizing = false;
function readLayout(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function writeLayout(key, value) { try { localStorage.setItem(key, value); } catch { /* Private storage may be unavailable. */ } }
function setSidebarWidth(width) {
  $('appSidebar').style.width = `${width}px`;
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
}
function applySidebar() {
  if(readLayout('sidebarLayoutVersion','')!=='3'){
    const previous=Number(readLayout('sidebarWidth','152'));
    writeLayout('sidebarWidth',Number.isFinite(previous)&&![176,216].includes(previous)?Math.max(144,Math.min(184,previous)):152);
    writeLayout('sidebarLayoutVersion','3');
  }
  const collapsed = readLayout('sidebarCollapsed', 'false') === 'true';
  $('appSidebar').classList.toggle('collapsed', collapsed);
  const storedWidth = Number(readLayout('sidebarWidth', '152'));
  setSidebarWidth(collapsed ? 56 : Number.isFinite(storedWidth) ? Math.max(144, Math.min(184, storedWidth)) : 152);
  $('sidebarToggle').setAttribute('aria-expanded', String(!collapsed));
  $('sidebarToggle').title = collapsed ? '展开侧边栏' : '收起侧边栏';
  $('sidebarToggle').setAttribute('aria-label', $('sidebarToggle').title);
  syncSidebarLabels();
  syncWindowLayout();
}
function syncSidebarLabels() {
  const collapsed=$('appSidebar').classList.contains('collapsed');
  DEFAULT_AGENTS.forEach(agent=>{
    const nav=$(`nav-${agent.id}`),count=$(`badge-count-${agent.id}`).textContent;
    const label=`${agent.label} · ${count} 个账号`;
    nav.setAttribute('aria-label',label);nav.removeAttribute('title');
    if(collapsed)nav.dataset.tooltip=label;else delete nav.dataset.tooltip;
  });
}
function syncWindowLayout() {
  const collapsed=$('appSidebar').classList.contains('collapsed');
  const width=parseInt($('appSidebar').style.width,10);
  window.api.setSidebarLayout(collapsed,width).then(check).catch(error=>showToast(error.message,'error'));
}
function toggleSidebar() {
  writeLayout('sidebarCollapsed', String(!$('appSidebar').classList.contains('collapsed')));
  applySidebar();
}
resizer.addEventListener('mousedown', event => { if (!$('appSidebar').classList.contains('collapsed')) { resizing = true; event.preventDefault(); } });
window.addEventListener('mousemove', event => { if (resizing) setSidebarWidth(Math.max(144, Math.min(184, event.clientX))); });
window.addEventListener('mouseup', () => {
  if(resizing){writeLayout('sidebarWidth',parseInt($('appSidebar').style.width,10));syncWindowLayout();}
  resizing=false;
});
// Bound card growth while letting the actual workspace determine how many fit.
new ResizeObserver(([entry])=>{
  const styles=getComputedStyle(entry.target),min=parseFloat(styles.getPropertyValue('--pool-card-min')),max=parseFloat(styles.getPropertyValue('--pool-card-max')),gap=parseFloat(styles.getPropertyValue('--pool-card-gap'));
  const columns=Math.max(1,Math.floor((entry.contentRect.width+gap)/(min+gap)));
  const cap=`${columns*max+(columns-1)*gap}px`;
  if(entry.target.style.getPropertyValue('--pool-max-width')!==cap)entry.target.style.setProperty('--pool-max-width',cap);
}).observe($('workspaceContent'));
applySidebar();
window.api.onAppUpdateState?.(state => {
  if (state.status !== appUpdateState.status || state.message !== appUpdateState.message) {
    appUpdateFeedback = ''; appUpdateFeedbackError = false;
  }
  appUpdateRevision++; appUpdateState = state; updateAppUpdatePanel();
});
window.api.onAppQuitState?.(state => {
  if (state?.waiting) showToast('正在完成凭据安全回存，完成后将自动退出…');
});
if (window.api.updateTray) {
  // A closed dialog may be removed before its deferred toggle event reaches the document.
  document.addEventListener('beforetoggle', event => {
    if (event.target instanceof HTMLDialogElement) queueMicrotask(() => syncTray());
  }, true);
}
window.api.onTrayCommand?.(async command => {
  let result;
  try {
    result = await handleTrayCommand(command);
  } catch (error) {
    if (command.action !== 'switch') return showToast(error.message,'error');
    result = { error: error.message };
  }
  if (command.action === 'switch') await window.api.replyTraySwitch(command.request, result || {});
});
Promise.all([window.api.getSettings(), window.api.getQuotaPaused?.() ?? false]).then(([prefs, paused]) => {
  settings = check(prefs);
  quotaPaused ??= paused;
}).catch(error => showToast(error.message, 'error')).then(() => loadStatus()).then(() => {
  quotaInitialized = true;
  selectTab(currentTab);
  window.api.trayReady?.();
  scheduleQuotaRefresh();
  if (canAutoRefresh()) {
    if (initialOpenPlatform) void refreshAll(false, initialOpenPlatform, 'on-open');
    return refreshAll(false);
  }
});
