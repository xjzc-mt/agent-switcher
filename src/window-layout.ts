import type { BrowserWindow } from 'electron';

export const { minimumWidth, defaultWidth } = require('../renderer/layout.js') as {
  minimumWidth: (sidebarWidth: number) => number;
  defaultWidth: number;
};

// Keep three minimum-width cards visible using the renderer's responsive padding.
export function updateWindowSidebarLayout(window: BrowserWindow | null, collapsed: boolean, sidebarWidth: number) {
  if (typeof collapsed !== 'boolean' || !Number.isFinite(sidebarWidth)) throw new Error('无效的侧边栏尺寸');
  const width = collapsed ? 56 : Math.max(144, Math.min(184, Math.round(sidebarWidth)));
  const minWidth = minimumWidth(width);
  if (window && !window.isDestroyed()) {
    const [currentWidth, currentHeight] = window.getSize();
    window.setMinimumSize(minWidth, 620);
    if (currentWidth < minWidth || currentHeight < 620) window.setSize(Math.max(currentWidth, minWidth), Math.max(currentHeight, 620));
  }
  return { minWidth, minHeight: 620 };
}
