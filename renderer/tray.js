'use strict';

const panel = window.trayPanel;
const $ = id => document.getElementById(id);
const tabs = [...document.querySelectorAll('[role=tab]')];
const choices = $('choices');
let snapshot = { groups: [] }, agent = 'codex', panelHeight;
let switching;
const group = () => snapshot.groups.find(g => g.id === agent);
const dispatch = (action, name) => panel.action({ action, ...(group() ? { agent } : {}), ...(name === undefined ? {} : { name }) });

function element(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function fitPanel() {
  const height = Math.ceil($('panel').getBoundingClientRect().height);
  if (height === panelHeight) return;
  panelHeight = height;
  panel.resize(height);
}

let nextQuotaReset = Infinity;
function quotaView(slot) {
  const view = AccountPolicy.quotaWindowView(slot, slot.invalidated);
  if (!view.invalidated && Number.isFinite(slot.resetsAt)) nextQuotaReset = Math.min(nextQuotaReset, slot.resetsAt * 1000);
  return { label: slot.label, resetsAt: slot.resetsAt, ...view };
}
function renderChoices(data) {
  const accounts = data?.alternates || [], hasQuota = !!data?.canRefresh;
  $('content').classList.toggle('no-quota', !hasQuota);
  $('choiceHeading').hidden = choices.hidden = !accounts.length;
  $('choiceCount').textContent = '点选切换 (' + accounts.length + ')';
  $('add').hidden = !data || !!data.total;
  $('add').disabled = !!snapshot.switching;
  $('empty').hidden = !data?.total || !!accounts.length;
  const rows = new Map([...choices.children].map(row => [row.accountName, row]));
  const focused = document.activeElement, scroll = choices.scrollTop;
  accounts.forEach((account, index) => {
    let row = rows.get(account.name);
    if (!row) {
      row = element('button', 'alternative choice-grid');
      row.accountName = account.name;
      row.onclick = () => switchAccount(row);
    }
    rows.delete(account.name);
    row.disabled = !!snapshot.switching;
    const previous = accounts[index - 1];
    row.classList.toggle('boundary', agent === 'codex' && previous?.plan === 'Pro' && account.plan !== previous.plan);
    const identity = element('span', 'alt-identity');
    identity.append(element('span', 'alt-name', account.label));
    row.replaceChildren(identity);
    const slots = account.windows.map(quotaView);
    if (account.weeklyPro || (!hasQuota && account.plan)) identity.append(element('span', 'plan', account.weeklyPro ? 'PRO' : account.plan));
    const description = slots.map(w => w.label + ' ' + w.text).join(' · ');
    row.title = [account.label, description, (account.cached || slots.some(w => w.invalidated)) && '上次记录'].filter(Boolean).join(' · ');
    if (hasQuota) {
      if (slots.some(w => !['5h','7d'].includes(w.label)) || new Set(slots.map(w => w.label)).size !== slots.length) {
        const summary = element('span', 'unusual');
        for (const slot of slots) {
          if (summary.childNodes.length) summary.append(' · ');
          const part = element('span', '', slot.label + ' ' + slot.text);
          if (slot.tone) part.dataset.tone = slot.tone;
          summary.append(part);
        }
        row.append(summary);
      } else {
        for (const label of ['5h', '7d']) {
          const slot = slots.find(w => w.label === label);
          const unlimited = label === '5h' && account.weeklyPro;
          const chip = element('span', unlimited ? 'chip unlimited' : 'chip', unlimited ? '不限' : (slot?.text || '—'));
          if (!unlimited && slot?.tone) chip.dataset.tone = slot.tone;
          chip.title = unlimited ? '无 5h 窗口限制' : label + ' 剩余 ' + chip.textContent;
          chip.setAttribute('aria-label', chip.title);
          row.append(chip);
        }
      }
    }
    if (choices.children[index] !== row) choices.insertBefore(row, choices.children[index] || null);
  });
  rows.forEach(row => row.remove());
  if (focused?.classList.contains('alternative') && document.activeElement !== focused) {
    (focused.isConnected && !focused.disabled ? focused : $(agent)).focus({ preventScroll: true });
  }
  choices.scrollTop = scroll;
}

function selectPlatform(id) {
  if (agent !== id) { switching = undefined; choices.scrollTop = 0; }
  agent = id;
  render();
  $(id).focus({ preventScroll: true });
}
for (const tab of tabs) {
  tab.insertAdjacentHTML('afterbegin', agentLogo(tab.id, 'tray'));
  tab.querySelector('svg').setAttribute('aria-hidden', 'true');
  tab.onclick = () => selectPlatform(tab.id);
  tab.onkeydown = event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = tabs.filter(t => !t.disabled);
    const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled.find(t => t !== tab);
    if (next) selectPlatform(next.id);
  };
}

function renderHome(content, data) {
  const account = data?.current;
  if (!account && !data?.unmanaged) {
    content.append(element('span', 'note', data ? data.unavailable || '尚未登录' : '正在读取账号…'));
    return;
  }
  const slots = account?.windows.map(quotaView) || [];
  if (account) {
    const identity = element('div', 'identity');
    const name = element('strong', 'nickname', account.label);
    name.title = account.label;
    identity.append(name);
    if (account.plan) identity.append(element('span', 'plan', account.weeklyPro ? 'PRO' : account.plan));
    if (slots.length && (account.cached || slots.some(w => w.invalidated))) identity.append(element('span', 'cached', '上次记录'));
    content.append(identity);
  }
  if (!account || account.expired) {
    const btn = element('button', 'recovery', account ? '更新凭据' : '保存当前登录');
    btn.onclick = () => account ? dispatch('update', account.name) : dispatch('save');
    content.append(btn);
    return;
  }
  if (!slots.length) {
    if (data.canRefresh) content.append(element('span', 'note', '暂无额度数据'));
    return;
  }
  const quotas = element('div', slots.length > 2 ? 'quotas multiple' : 'quotas');
  for (const slot of slots) {
    const cell = element('div', 'period');
    if (slot.tone) cell.dataset.tone = slot.tone;
    const reset = element('span', 'period-reset');
    reset.dataset.at = slot.resetsAt ?? '';
    cell.append(element('span', 'period-label', slot.label + ' 剩余'), element('strong', 'amount', slot.text), reset);
    if (slot.remaining !== undefined) {
      const meter = element('progress', 'meter');
      meter.max = 100; meter.value = slot.remaining;
      meter.setAttribute('aria-hidden', 'true');
      cell.append(meter);
    }
    quotas.append(cell);
  }
  content.append(quotas);
  updateResetTimes();
}
function updateResetTimes() {
  for (const reset of document.querySelectorAll('.period-reset')) {
    const text = AccountPolicy.resetText(Number(reset.dataset.at), snapshot.countdown);
    reset.textContent = '↻ ' + text;
    reset.title = text === '—' ? '未提供重置时间' : '重置时间：' + text;
  }
}

function renderSwitch() {
  $('switchPrompt').hidden = !switching;
  $('content').hidden = !!switching;
  if (!switching) return;
  const { label, confirmation, message, busy } = switching;
  $('switchName').textContent = '切换到 ' + label;
  $('switchName').title = label;
  $('switchDetail').textContent = busy ? '正在切换…' : message || [
    confirmation.clients.length && `将退出 ${confirmation.clients.join('、')}，切换后重新打开。请先结束正在进行的任务。`,
    confirmation.interrupted && '将先核对上次中断的切换。',
    confirmation.unmanaged && '当前登录尚未保存。直接切换后可能需要重新登录。',
    confirmation.migration && '完整凭据将存入桌面和 CLI 的私有登录文件，核对后移除旧钥匙串项。',
  ].filter(Boolean).join('\n');
  $('cancelSwitch').hidden = busy;
  $('cancelSwitch').textContent = message ? '返回' : '取消';
  $('skipSave').hidden = busy || !confirmation?.unmanaged;
  $('confirmSwitch').hidden = busy || !confirmation;
  if (confirmation) $('confirmSwitch').textContent = confirmation.unmanaged ? '保存并切换' : confirmation.clients.length ? '退出并切换' : '确认切换';
}
async function switchAccount(row, saveUnmanaged) {
  if (switching?.busy || (!row && !switching?.confirmation)) return;
  const draft = switching ||= { name: row.accountName, label: row.querySelector('.alt-name').textContent };
  const decision = draft.confirmation && { token: draft.confirmation.token, saveUnmanaged };
  draft.busy = true;
  render();
  let result;
  try { result = await panel.action({ action:'switch', agent, name:draft.name, decision }); }
  catch (error) { result = { error:error.message }; }
  if (switching !== draft) return;
  draft.busy = false;
  draft.confirmation = result?.confirmation;
  draft.message = result?.error || result?.warning;
  if (!draft.confirmation && !draft.message) {
    if (result?.canceled) return cancelSwitch();
    switching = undefined;
    return panel.close();
  }
  render();
  $(draft.confirmation ? 'confirmSwitch' : 'cancelSwitch').focus();
}
function cancelSwitch() {
  const name = switching?.name;
  switching = undefined;
  render();
  ([...choices.children].find(row => row.accountName === name && !row.disabled) || $(agent)).focus({ preventScroll:true });
}
function render() {
  nextQuotaReset = Infinity;
  const data = group(), current = $('current');
  for (const tab of tabs) {
    tab.disabled = !!switching?.busy || (!!snapshot.groups.length && !snapshot.groups.some(g => g.id === tab.id));
    tab.setAttribute('aria-selected', String(agent === tab.id));
    tab.tabIndex = agent === tab.id ? 0 : -1;
  }
  $('content').setAttribute('aria-labelledby', agent);
  const restoreRecovery = document.activeElement.matches('#current .recovery');
  current.replaceChildren();
  renderHome(current, data);
  if (restoreRecovery) (current.querySelector('.recovery') || $(agent)).focus({ preventScroll:true });
  renderChoices(data);
  renderSwitch();
  $('refresh').hidden = data?.canRefresh === false;
  $('refresh').disabled = !!switching || !!snapshot.switching || !!snapshot.menu?.blocked || !data?.hasTargets || !!data.bulkRefreshing;
  $('refresh').setAttribute('aria-busy', String(!!data?.refreshing));
}

$('refresh').onclick = () => dispatch('refresh');
panel.onRefresh(() => $('refresh').click());
$('add').onclick = () => dispatch('add');
$('open').onclick = () => dispatch('open');
$('quit').onclick = () => dispatch('quit');
$('confirmSwitch').onclick = () => switchAccount(null, true);
$('skipSave').onclick = () => switchAccount(null, false);
$('cancelSwitch').onclick = cancelSwitch;
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (switching && !switching.busy) cancelSwitch();
    else panel.close();
    return;
  }
  const button = event.target.closest('button');
  if (event.key === 'Enter' && (button?.classList.contains('alternative') ||
      (switching && !switching.busy && (!button || $('switchPrompt').contains(button))))) {
    event.preventDefault();
    if (!event.repeat) (button || $('confirmSwitch')).click();
    return;
  }
  if (!['ArrowDown','ArrowUp'].includes(event.key) || switching || choices.hidden || snapshot.switching) return;
  event.preventDefault();
  const row = document.activeElement, down = event.key === 'ArrowDown';
  const next = choices.contains(row) && (down ? row.nextElementSibling : row.previousElementSibling);
  (next || (down ? choices.firstElementChild : choices.lastElementChild)).focus();
});
const contentObserver = new ResizeObserver(fitPanel);
function updateQuotaClock() {
  if (document.hidden) return;
  if (Date.now() >= nextQuotaReset) render();
  else if (snapshot.countdown) updateResetTimes();
}
setInterval(updateQuotaClock, 30000);
panel.onState((state, reset) => {
  if (reset) { panelHeight = undefined; switching = undefined; }
  snapshot = state || { groups: [] };
  if (reset || !group()) agent = snapshot.groups.find(g => g.id === snapshot.selectedAgent)?.id || snapshot.groups[0]?.id || 'codex';
  if (reset) choices.scrollTop = 0;
  render();
  if (reset) {
    contentObserver.observe($('panel'));
    document.activeElement?.blur();
    fitPanel();
  }
});
window.addEventListener('blur', () => { switching = undefined; });
panel.ready();
