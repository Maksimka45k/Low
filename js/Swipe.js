import { state } from './state.js';
import { isMobile } from './util.js';
import { goBack } from './chats.js';

// Свайп вправо внутри открытого чата возвращает к списку чатов (только на телефонах).
const SKIP = 'input, textarea, select, pre, #gif-panel, #media-modal, .modal-overlay:not(.hidden)';
let start = null;

export function initSwipeBack() {
  document.addEventListener('touchstart', e => {
    const t = e.touches[0];
    if (!isMobile() || !state.chat || e.touches.length !== 1 || e.target.closest?.(SKIP)) { start = null; return; }
    start = { x: t.clientX, y: t.clientY, at: Date.now() };
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    const quick = Date.now() - start.at < 600;
    start = null;
    if (quick && dx > 80 && Math.abs(dy) < 60 && dx > Math.abs(dy) * 2) goBack();
  }, { passive: true });
}
