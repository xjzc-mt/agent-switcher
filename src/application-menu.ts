import { Menu, type MenuItemConstructorOptions } from 'electron';

export type MenuAction = 'settings' | 'add' | 'refresh' | 'restart' | 'codex' | 'agy' | 'sidebar' | 'cards' | 'rows';
export interface MenuView { tab: string; layout: string; blocked: boolean }

export function installApplicationMenu(dispatch: (action: MenuAction) => void, open: () => void,
  project: (issues: boolean) => void, packaged: boolean) {
  const item = (id: MenuAction, label: string, accelerator?: string, radio = false): MenuItemConstructorOptions =>
    ({ id, label, accelerator, type: radio ? 'radio' : 'normal', click: () => dispatch(id) });
  const menu = Menu.buildFromTemplate([
    { label: 'AgentSwitcher', submenu: [
      { role: 'about', label: '关于 AgentSwitcher' }, { type: 'separator' }, item('settings','设置…','Cmd+,'),
      { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit', label: '退出 AgentSwitcher' },
    ] },
    { label: '账号', submenu: [
      item('add','添加账号…','Cmd+N'), item('refresh','刷新全部额度','Cmd+R'), item('restart','重启当前客户端','Cmd+Shift+R'),
      { type: 'separator' }, { role: 'close', label: '关闭窗口' },
    ] },
    { label: '编辑', role: 'editMenu' },
    { label: '视图', submenu: [
      item('codex','Codex','Cmd+1',true), item('agy','Antigravity','Cmd+2',true), { type: 'separator' },
      item('sidebar','收起或展开侧边栏','Cmd+Alt+S'), { type: 'separator' },
      item('cards','紧凑卡片视图',undefined,true), item('rows','单行比较视图',undefined,true),
      ...(packaged ? [] : [{ type: 'separator' as const }, { role: 'toggleDevTools' as const, label: '开发者工具' }]),
    ] },
    { label: '窗口', role: 'windowMenu', submenu: [
      { role: 'minimize' }, { role: 'zoom' }, { label: '打开主窗口', accelerator: 'Cmd+0', click: open }, { role: 'front' },
    ] },
    { label: '帮助', role: 'help', submenu: [
      { label: 'AgentSwitcher 项目主页', click: () => project(false) }, { label: '已知问题与反馈', click: () => project(true) },
    ] },
  ]);
  Menu.setApplicationMenu(menu);
  return (view: MenuView) => {
    for (const id of ['settings','add','refresh','restart','codex','agy','sidebar','cards','rows']) {
      const entry = menu.getMenuItemById(id)!;
      entry.enabled = !view.blocked && (view.tab !== 'settings' || !['refresh','restart','cards','rows'].includes(id));
      if (entry.type === 'radio') entry.checked = id === view.tab || id === view.layout;
    }
  };
}
