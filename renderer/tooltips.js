// Supplementary details appear only at their labeled trigger, never at card level.
(() => {
  let active, timer, popup;
  function close() {
    clearTimeout(timer);
    if (active) active.removeAttribute('aria-describedby');
    popup?.remove(); popup = undefined; active = undefined;
  }
  function open(trigger) {
    close(); if (!trigger.isConnected || !trigger.dataset.tooltip) return;
    if (trigger.hasAttribute('data-tooltip-overflow') && trigger.scrollWidth <= trigger.clientWidth + 1) return;
    active = trigger;
    popup = document.createElement('div'); popup.className = 'app-tooltip';
    popup.id = 'account-tooltip'; popup.setAttribute('role', 'tooltip');
    popup.textContent = trigger.dataset.tooltip;
    (trigger.closest('dialog[open]') || document.body).append(popup);
    trigger.setAttribute('aria-describedby', popup.id);
    const r = trigger.getBoundingClientRect(), p = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(innerWidth-p.width-8, r.x+r.width/2-p.width/2))}px`;
    popup.style.top = `${r.top-p.height-8 >= 8 ? r.top-p.height-8 : Math.min(innerHeight-p.height-8, r.bottom+8)}px`;
  }
  document.addEventListener('pointerover', e => {
    if (e.pointerType === 'touch') return;
    const trigger = e.target.closest('[data-tooltip]');
    if (!trigger || trigger.contains(e.relatedTarget)) return;
    close();
    if (trigger.hasAttribute('data-tooltip-instant')) open(trigger);
    else timer = setTimeout(() => open(trigger), 500);
  });
  document.addEventListener('pointerout', e => {
    const trigger = e.target.closest('[data-tooltip]');
    if (trigger && !trigger.contains(e.relatedTarget)) close();
  });
  document.addEventListener('focusin', e => {
    const trigger = e.target.closest('[data-tooltip]');
    if (trigger?.matches(':focus-visible')) open(trigger);
  });
  document.addEventListener('focusout', close);
  document.addEventListener('click', close);
  document.addEventListener('contextmenu', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  new MutationObserver(() => { if (active && !active.isConnected) close(); }).observe(document.body, { childList:true, subtree:true });
})();
