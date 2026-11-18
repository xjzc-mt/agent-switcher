/* Shared card and workspace dimensions for the renderer and native window. */
(function (root) {
  const cardMin = 180, cardMax = 208, cardGap = 8;
  const paddingWide = 24, paddingCompact = 20, paddingNarrow = 12;

  function widthForContent(contentWidth, sidebarWidth) {
    const contentAndSidebar = contentWidth + sidebarWidth;
    const narrow = contentAndSidebar + 2 * paddingNarrow;
    if (narrow <= 660) return narrow;
    const compact = contentAndSidebar + 2 * paddingCompact;
    return compact <= 1000 ? compact : contentAndSidebar + 2 * paddingWide;
  }

  function minimumWidth(sidebarWidth) {
    return widthForContent(3 * cardMin + 2 * cardGap, sidebarWidth);
  }
  const defaultWidth = Math.max(widthForContent(3 * cardMax + 2 * cardGap, 152), widthForContent(4 * cardMin + 3 * cardGap, 56));

  const layout = { cardMin, cardMax, cardGap, paddingWide, paddingCompact, paddingNarrow, minimumWidth, defaultWidth };
  if (typeof module === 'object' && module.exports) module.exports = layout;
  else {
    root.AccountLayout = layout;
    const properties = {
      '--pool-card-min': cardMin,
      '--pool-card-max': cardMax,
      '--pool-card-gap': cardGap,
      '--workspace-padding-wide': paddingWide,
      '--workspace-padding-compact': paddingCompact,
      '--workspace-padding-narrow': paddingNarrow,
    };
    for (const [name, value] of Object.entries(properties)) document.documentElement.style.setProperty(name, `${value}px`);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
