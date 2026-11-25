'use strict';

const panel = window.trayPanel;
const $ = id => document.getElementById(id);
const tabs = [...document.querySelectorAll('[role=tab]')];
const choices = $('choices');
let snapshot = { groups: [] }, agent = 'codex', panelHeight;
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

function amount(value) {
  if (!Number.isFinite(value)) return '—';
  return (value > 0 && Math.round(value) === 0 ? '<1' : Math.round(value)) + '%';
}
function applyTone(el, value, cached) {
  if (Number.isFinite(value)) el.dataset.tone = cached ? 'cached' : value === 0 ? 'empty' :
    Math.round(value) <= 30 ? 'low' : Math.round(value) >= 80 ? 'ample' : 'normal';
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
      row.onclick = () => dispatch('switch', row.accountName);
    }
    rows.delete(account.name);
    row.disabled = !!snapshot.switching;
    const previous = accounts[index - 1];
    row.classList.toggle('boundary', agent === 'codex' && previous?.plan === 'Pro' && account.plan !== previous.plan);
    const identity = element('span', 'alt-identity');
    identity.append(element('span', 'alt-name', account.label));
    row.replaceChildren(identity);
    const cached = account.cached || snapshot.windowClosed;
    const slots = account.windows;
    if (account.weeklyPro) identity.append(element('span', 'plan', 'PRO'));
    const description = slots.map(w => w.label + ' ' + amount(w.remaining)).join(' · ');
    row.title = [account.label, description, cached && '上次记录'].filter(Boolean).join(' · ');
    if (hasQuota) {
      if (slots.some(w => !['5h','7d'].includes(w.label)) || new Set(slots.map(w => w.label)).size !== slots.length) {
        row.append(element('span', 'unusual', description));
      } else {
        for (const label of ['5h', '7d']) {
          const slot = slots.find(w => w.label === label);
          const unlimited = label === '5h' && account.weeklyPro;
          const chip = element('span', unlimited ? 'chip unlimited' : 'chip', unlimited ? '不限' : amount(slot?.remaining));
          applyTone(chip, slot?.remaining, cached);
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
  if (agent !== id) choices.scrollTop = 0;
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
  const cached = account?.cached || snapshot.windowClosed;
  if (account) {
    const identity = element('div', 'identity');
    const name = element('strong', 'nickname', account.label);
    name.title = account.label;
    identity.append(name);
    if (account.plan) identity.append(element('span', 'plan', account.weeklyPro ? 'PRO' : account.plan));
    if (cached && account.windows.length) identity.append(element('span', 'cached', '上次记录'));
    content.append(identity);
  }
  if (!account || account.expired) {
    const btn = element('button', 'recovery', account ? '更新凭据' : '保存当前登录');
    btn.onclick = () => account ? dispatch('update', account.name) : dispatch('save');
    content.append(btn);
    return;
  }
  if (!account.windows.length) {
    content.append(element('span', 'note', data.canRefresh ? '暂无额度数据' : '暂不支持额度查询'));
    return;
  }
  const quotas = element('div', account.windows.length > 2 ? 'quotas multiple' : 'quotas');
  for (const slot of account.windows) {
    const cell = element('div', 'period');
    applyTone(cell, slot.remaining, cached);
    const reset = element('span', 'period-reset');
    reset.dataset.at = slot.resetsAt ?? '';
    cell.append(element('span', 'period-label', slot.label + ' 剩余'), element('strong', 'amount', amount(slot.remaining)), reset);
    if (Number.isFinite(slot.remaining)) {
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

function render() {
  const data = group(), current = $('current');
  for (const tab of tabs) {
    tab.disabled = !!snapshot.groups.length && !snapshot.groups.some(g => g.id === tab.id);
    tab.setAttribute('aria-selected', String(agent === tab.id));
    tab.tabIndex = agent === tab.id ? 0 : -1;
  }
  $('content').setAttribute('aria-labelledby', agent);
  const restoreRecovery = document.activeElement.matches('#current .recovery');
  current.replaceChildren();
  renderHome(current, data);
  if (restoreRecovery) (current.querySelector('.recovery') || $(agent)).focus({ preventScroll:true });
  renderChoices(data);
  $('refresh').disabled = !!snapshot.refreshing || !snapshot.groups.some(g => g.canRefresh && (g.current || g.unmanaged));
  $('refresh').setAttribute('aria-busy', String(!!snapshot.refreshing));
}

$('refresh').onclick = () => dispatch('refresh');
$('add').onclick = () => dispatch('add');
$('open').onclick = () => dispatch('open');
$('quit').onclick = () => dispatch('quit');
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); panel.close(); return; }
  if (!['ArrowDown','ArrowUp'].includes(event.key) || choices.hidden || snapshot.switching) return;
  event.preventDefault();
  const row = document.activeElement, down = event.key === 'ArrowDown';
  const next = choices.contains(row) && (down ? row.nextElementSibling : row.previousElementSibling);
  (next || (down ? choices.firstElementChild : choices.lastElementChild)).focus();
});
const contentObserver = new ResizeObserver(fitPanel);
setInterval(() => { if (!document.hidden && snapshot.countdown) updateResetTimes(); }, 30000);
panel.onState((state, reset) => {
  if (reset) panelHeight = undefined;
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
panel.ready();
