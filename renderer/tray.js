'use strict';

const panel = window.trayPanel;
const $ = id => document.getElementById(id);
const tabs = [...document.querySelectorAll('[role=tab]')];
const choices = $('choices'), trigger = $('switch');
const actions = document.querySelector('.panel-actions');
let snapshot = { groups: [] }, agent = 'codex', leaveTimer, panelHeight;
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

function renderChoices() {
  const rows = new Map([...choices.children].map(row => [row.accountName, row]));
  const focused = document.activeElement;
  const scroll = choices.scrollTop;
  group().alternates.forEach((account, index) => {
    let row = rows.get(account.name);
    if (!row) {
      row = element('button', 'alternative');
      row.accountName = account.name;
      row.append(element('span', 'alt-name'), element('span', 'alt-detail'));
      row.onclick = () => dispatch('switch', account.name);
    }
    rows.delete(account.name);
    row.disabled = !!snapshot.switching;
    row.firstChild.textContent = account.label;
    row.lastChild.textContent = account.windows.map(w => w.label + ' ' + (w.remaining === undefined ? '—' : w.remaining + '%')).join(' · ') || account.plan || '';
    row.title = account.cached || snapshot.windowClosed ? account.label + ' · 上次记录' : account.label;
    if (choices.children[index] !== row) choices.insertBefore(row, choices.children[index] || null);
  });
  rows.forEach(row => row.remove());
  if (focused?.classList.contains('alternative') && document.activeElement !== focused) {
    (focused.isConnected ? focused : trigger).focus({ preventScroll: true });
  }
  choices.scrollTop = scroll;
}

function expand(open) {
  clearTimeout(leaveTimer);
  open = !!(open && group()?.alternates.length);
  if (open === !choices.hidden) return;
  choices.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    renderChoices();
  } else {
    if (choices.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    choices.replaceChildren();
    choices.scrollTop = 0;
  }
  fitPanel();
}

function selectPlatform(id) {
  expand(false);
  agent = id;
  render();
  $(id).focus({ preventScroll: true });
}
for (const tab of tabs) {
  tab.insertAdjacentHTML('afterbegin', LOGOS[tab.id]);
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
  if (account) {
    const identity = element('div', 'identity');
    const name = element('strong', 'nickname', account.label);
    name.title = account.label;
    identity.append(name);
    if (account.plan) identity.append(element('span', 'plan', account.plan));
    content.append(identity);
  }
  if (!account || account.expired) {
    const btn = element('button', 'recovery', account ? '更新凭据' : '保存当前登录');
    btn.onclick = () => account ? dispatch('update', account.name) : dispatch('save');
    content.append(btn);
    return;
  }
  if (!account.windows.length && !data.canRefresh) return;
  const quotas = element('div', 'quotas');
  if (account.windows.length) quotas.append(element('span', '', '剩余'));
  for (const slot of account.windows) {
    const cell = element('span','period',slot.label + ' ');
    cell.append(element('b', '', Number.isFinite(slot.remaining) ? slot.remaining + '%' : '—'));
    cell.setAttribute('aria-label',slot.label + ' 剩余 ' + cell.lastChild.textContent);
    quotas.append(cell);
  }
  if (!quotas.childElementCount) quotas.textContent = '暂无额度数据';
  else if (account.cached || snapshot.windowClosed) quotas.append(element('span', 'cached', '上次记录'));
  content.append(quotas);
}

function render() {
  const data = group(), content = $('content');
  for (const tab of tabs) {
    tab.disabled = !!snapshot.groups.length && !snapshot.groups.some(g => g.id === tab.id);
    tab.setAttribute('aria-selected', String(agent === tab.id));
    tab.tabIndex = agent === tab.id ? 0 : -1;
  }
  content.setAttribute('aria-labelledby', agent);
  const restoreRecovery = document.activeElement.matches('#content .recovery');
  content.replaceChildren();
  renderHome(content, data);
  if (restoreRecovery) (content.querySelector('.recovery') || $(agent)).focus({ preventScroll:true });
  const hasChoices = !!data?.alternates.length;
  $('switchLabel').textContent = snapshot.switching ? '切换中…' : hasChoices ? '切换账号' : data?.total ? '暂无可切换账号' : '添加账号';
  trigger.disabled = !!snapshot.switching || !data || (!hasChoices && !!data.total);
  trigger.setAttribute('aria-busy', String(!!snapshot.switching));
  trigger.querySelector('svg').toggleAttribute('hidden', !hasChoices);
  if (!hasChoices) expand(false);
  else if (!choices.hidden) renderChoices();
  $('refresh').disabled = !!snapshot.refreshing || !snapshot.groups.some(g => g.canRefresh && (g.current || g.unmanaged));
  $('refresh').setAttribute('aria-busy', String(!!snapshot.refreshing));
}

trigger.onpointerenter = event => { if (event.pointerType !== 'touch') expand(true); };
$('switcher').onpointerenter = () => clearTimeout(leaveTimer);
$('switcher').onpointerleave = () => {
  leaveTimer = setTimeout(() => { if (!choices.contains(document.activeElement)) expand(false); }, 120);
};
$('switcher').onfocusout = event => {
  if (event.relatedTarget && !$('switcher').contains(event.relatedTarget)) expand(false);
};
trigger.onclick = event => {
  if (!group()?.alternates.length) return dispatch('add');
  expand(true);
  if (event.detail === 0) choices.firstElementChild?.focus();
};
$('switcher').onkeydown = event => {
  if (actions.contains(event.target) || !['ArrowDown','ArrowUp'].includes(event.key) || !group()?.alternates.length) return;
  event.preventDefault();
  expand(true);
  const row = document.activeElement;
  const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
  (choices.contains(row) && next || (event.key === 'ArrowDown' ? choices.firstElementChild : choices.lastElementChild)).focus();
};
$('refresh').onclick = () => dispatch('refresh');
actions.onpointerenter = actions.onfocusin = () => expand(false);
$('open').onclick = () => dispatch('open');
$('quit').onclick = () => dispatch('quit');
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  if (!choices.hidden) { expand(false); trigger.focus(); }
  else panel.close();
});
const contentObserver = new ResizeObserver(fitPanel);
panel.onState((state, reset) => {
  const previousGroup = group();
  if (reset) panelHeight = undefined;
  snapshot = state || { groups: [] };
  if (reset || !group()) agent = snapshot.groups.find(g => g.id === snapshot.selectedAgent)?.id || snapshot.groups[0]?.id || 'codex';
  if (reset || previousGroup?.current?.name !== group()?.current?.name) expand(false);
  render();
  if (reset) {
    contentObserver.observe($('panel'));
    document.activeElement?.blur();
    fitPanel();
  }
});
panel.ready();
