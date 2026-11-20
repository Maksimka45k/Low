import { db, TS } from './firebase.js';
import { state } from './state.js';
import { $, h, clear, toast, showModal, hideModal } from './util.js';
import { chatKey, encryptJson, decryptJson, messageAad } from './crypto.js';
import { resolveMode, sendPayload, uploadAttachment } from './messages.js';

/*
 * Рисовалка. Рисунок хранится как журнал событий в activities/{чат}/{рисунок}/:
 *   s — кусок штриха (кисть, ластик, линия, рамка, овал), u — скрыть штрих (отмена), r — вернуть (повтор).
 * Каждое событие шифруется ключом чата. Отмена и повтор работают только со своими штрихами.
 * Ластик — это штрих цвета фона, поэтому его тоже можно отменить.
 */
const W = 1200, H = 800, TAU = Math.PI * 2;
const TOOLS = [['pen', '✏️', 'Кисть'], ['eraser', '🧽', 'Ластик'], ['line', '╱', 'Линия'], ['rect', '▭', 'Прямоугольник'], ['ellipse', '◯', 'Овал']];
const TOOL_IDS = new Set(TOOLS.map(t => t[0]));
const SHAPES = new Set(['line', 'rect', 'ellipse']);
const PALETTE = ['#111111', '#ffffff', '#ff4757', '#ff9f43', '#feca57', '#2ed573', '#1e90ff', '#6c5ce7', '#ff6b9d', '#8b5a2b'];
const BGS = [['Белый', '#ffffff'], ['Тёмный', '#14141f'], ['Крафт', '#e9d8b4'], ['Небо', '#cfe8ff']];
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[0-9a-f]{16}$/;

const num = v => typeof v === 'number' && Number.isFinite(v);
const nonce = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
const clamp = (v, max) => Math.max(0, Math.min(max, v));

let D = null;
let queue = Promise.resolve();
const enqueue = fn => { queue = queue.then(fn).catch(() => {}); return queue; };

function sane(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.k === 's') {
    return typeof d.sid === 'string' && d.sid.length <= 24 && TOOL_IDS.has(d.tool) && HEX.test(d.color)
      && num(d.size) && d.size >= 1 && d.size <= 80
      && Array.isArray(d.pts) && d.pts.length >= 1 && d.pts.length <= 200
      && d.pts.every(p => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]) && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H);
  }
  if (d.k === 'u' || d.k === 'r') return Array.isArray(d.sids) && d.sids.length <= 50 && d.sids.every(s => typeof s === 'string' && s.length <= 24);
  return false;
}

/* ---------- рисование ---------- */
function drawShape(ctx, tool, a, b) {
  ctx.beginPath();
  if (tool === 'line') { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
  else if (tool === 'rect') ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  else ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, TAU);
  ctx.stroke();
}

function paintStroke(ctx, st, from = 0) {
  const p = st.pts;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = st.color;
  ctx.lineWidth = st.size;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (SHAPES.has(st.tool)) {
    if (from === 0 && p.length >= 2) drawShape(ctx, st.tool, p[0], p[p.length - 1]);
  } else if (p.length === 1) {
    ctx.beginPath();
    ctx.arc(p[0][0], p[0][1], st.size / 2, 0, TAU);
    ctx.fill();
  } else if (p.length > 1) {
    const s = Math.max(0, from - 1);
    ctx.beginPath();
    ctx.moveTo(p[s][0], p[s][1]);
    for (let i = s + 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.stroke();
  }
  ctx.restore();
}

function redraw() {
  D.main.fillStyle = D.bg;
  D.main.fillRect(0, 0, W, H);
  for (const sid of D.order) if (!D.hidden.has(sid)) paintStroke(D.main, D.strokes.get(sid), 0);
  if (D.cur && !SHAPES.has(D.cur.tool)) paintStroke(D.main, D.cur, 0);
}

/* ---------- журнал событий ---------- */
function applyOne(e, paint = D.ready) {
  const d = e.d;
  if (d.k === 's') {
    let st = D.strokes.get(d.sid);
    if (!st) {
      st = { sid: d.sid, user: e.from, tool: d.tool, color: d.color, size: d.size, pts: [] };
      D.strokes.set(d.sid, st);
      D.order.push(d.sid);
    }
    if (st.user !== e.from) return;
    const from = st.pts.length;
    st.pts.push(...d.pts);
    if (paint && !D.local.has(d.sid) && !D.hidden.has(d.sid)) paintStroke(D.main, st, from);
  } else {
    for (const sid of d.sids) {
      const st = D.strokes.get(sid);
      if (!st || st.user !== e.from) continue;
      if (d.k === 'u') D.hidden.add(sid); else D.hidden.delete(sid);
    }
    if (paint) redraw();
  }
}

function rebuild() {
  D.strokes.clear();
  D.order = [];
  D.hidden.clear();
  for (const e of D.log) applyOne(e, false);
  redraw();
}

function addEntry(entry) {
  const last = D.log[D.log.length - 1];
  D.log.push(entry);
  if (!last || entry.key > last.key) applyOne(entry);
  else { D.log.sort((a, b) => (a.key < b.key ? -1 : 1)); rebuild(); }
}

// Стеки отмены и повтора считаются из журнала, поэтому восстанавливаются и после перезахода.
function recompute() {
  const me = state.me.uid, mine = [], redo = [], seen = new Set();
  for (const e of D.log) {
    if (e.from !== me) continue;
    const d = e.d;
    if (d.k === 's') {
      if (!seen.has(d.sid)) { seen.add(d.sid); mine.push(d.sid); redo.length = 0; }
      continue;
    }
    for (const sid of d.sids) {
      if (D.strokes.get(sid)?.user !== me) continue;
      if (d.k === 'u') { const i = mine.indexOf(sid); if (i >= 0) { mine.splice(i, 1); redo.push(sid); } }
      else { const i = redo.indexOf(sid); if (i >= 0) { redo.splice(i, 1); mine.push(sid); } }
    }
  }
  D.mine = mine;
  D.redo = redo;
  syncUI();
}

function emit(d) {
  const ref = D.ref.push();
  const me = state.me.uid;
  D.keys.add(ref.key);
  addEntry({ key: ref.key, from: me, d });
  recompute();
  encryptJson(D.key, d, messageAad(D.chat.id + ':' + D.id, me))
    .then(enc => ref.set({ from: me, at: TS, enc }))
    .catch(() => toast('Рисовалка', 'Не удалось отправить штрих', 'error'));
}

function onChild(snap) {
  const session = D, key = snap.key, val = snap.val();
  if (!session || session.keys.has(key) || !val?.enc || typeof val.from !== 'string') return;
  enqueue(async () => {
    if (D !== session || session.keys.has(key)) return;
    let d;
    try { d = await decryptJson(session.key, val.enc, messageAad(session.chat.id + ':' + session.id, val.from)); } catch { return; }
    if (!sane(d)) return;
    session.keys.add(key);
    addEntry({ key, from: val.from, d });
  });
}

const undo = () => { const sid = D?.mine[D.mine.length - 1]; if (sid) emit({ k: 'u', sids: [sid] }); };
const redo = () => { const sid = D?.redo[D.redo.length - 1]; if (sid) emit({ k: 'r', sids: [sid] }); };

/* ---------- ввод ---------- */
function pos(e) {
  const r = D.topEl.getBoundingClientRect();
  return [clamp(Math.round(((e.clientX - r.left) * W) / r.width), W), clamp(Math.round(((e.clientY - r.top) * H) / r.height), H)];
}

function flush() {
  const c = D?.cur;
  if (!c) return;
  const pts = c.pts.slice(c.sent);
  if (!pts.length) return;
  c.sent = c.pts.length;
  D.local.add(c.sid);
  emit({ k: 's', sid: c.sid, tool: c.tool, color: c.color, size: c.size, pts });
}

function onDown(e) {
  if (!D || !e.isPrimary || e.button > 0) return;
  D.topEl.setPointerCapture(e.pointerId);
  D.cur = { sid: nonce(), tool: D.tool, color: D.tool === 'eraser' ? D.bg : D.color, size: D.size, pts: [pos(e)], sent: 0 };
  if (!SHAPES.has(D.tool)) {
    paintStroke(D.main, D.cur, 0);
    D.timer = setInterval(flush, 150);
  }
}

function onMove(e) {
  const c = D?.cur;
  if (!c) return;
  const p = pos(e);
  if (SHAPES.has(c.tool)) {
    c.pts = [c.pts[0], p];
    D.preview.clearRect(0, 0, W, H);
    paintStroke(D.preview, c, 0);
    return;
  }
  const last = c.pts[c.pts.length - 1];
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2) return;
  c.pts.push(p);
  paintStroke(D.main, c, c.pts.length - 1);
  if (c.pts.length - c.sent >= 40) flush();
}

function onUp() {
  const c = D?.cur;
  if (!c) return;
  clearInterval(D.timer);
  if (SHAPES.has(c.tool)) {
    D.preview.clearRect(0, 0, W, H);
    const a = c.pts[0], b = c.pts[c.pts.length - 1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 3) {
      paintStroke(D.main, c, 0);
      D.local.add(c.sid);
      emit({ k: 's', sid: c.sid, tool: c.tool, color: c.color, size: c.size, pts: [a, b] });
    }
  } else {
    flush();
  }
  D.cur = null;
}

/* ---------- окно ---------- */
function syncUI() {
  if (!D) return;
  document.querySelectorAll('.draw-tool').forEach(b => b.classList.toggle('on', b.dataset.tool === D.tool));
  document.querySelectorAll('.draw-swatch').forEach(b => b.classList.toggle('on', b.dataset.color === D.color && D.tool !== 'eraser'));
  $('draw-undo').disabled = !D.mine.length;
  $('draw-redo').disabled = !D.redo.length;
  $('draw-size-label').textContent = D.size + ' px';
}

async function exportBlob() {
  return new Promise(resolve => D.mainEl.toBlob(resolve, 'image/png'));
}

async function saveToChat() {
  const chat = D.chat;
  try {
    const blob = await exportBlob();
    toast('Рисовалка', 'Отправляю в чат…');
    const meta = await uploadAttachment(new File([blob], 'drawing.png', { type: 'image/png' }), true);
    await sendPayload(chat, { file: meta });
    toast('Рисовалка', 'Рисунок отправлен в чат', 'success');
  } catch (e) {
    toast('Ошибка', e.message || 'Не удалось отправить', 'error');
  }
}

async function download() {
  const url = URL.createObjectURL(await exportBlob());
  const a = h('a', { href: url, download: 'drawing.png' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function closeDraw() {
  if (!D) return;
  clearInterval(D.timer);
  D.ref.off();
  hideModal('draw-modal');
  D = null;
}

function ensureModal() {
  if ($('draw-modal')) return;
  const tools = TOOLS.map(([id, icon, title]) => h('button', {
    class: 'draw-btn draw-tool', title, text: icon, 'data-tool': id,
    onclick: () => { D.tool = id; syncUI(); }
  }));
  const swatches = PALETTE.map(c => {
    const b = h('button', { class: 'draw-swatch', title: c, 'data-color': c, onclick: () => { D.color = c; if (D.tool === 'eraser') D.tool = 'pen'; colorInput.value = c; syncUI(); } });
    b.style.background = c;
    return b;
  });
  const colorInput = h('input', { type: 'color', class: 'draw-color', title: 'Свой цвет' });
  colorInput.value = PALETTE[0];
  colorInput.addEventListener('input', () => { D.color = colorInput.value; if (D.tool === 'eraser') D.tool = 'pen'; syncUI(); });
  const size = h('input', { type: 'range', min: '2', max: '60', value: '6', class: 'draw-size', title: 'Толщина' });
  size.addEventListener('input', () => { D.size = Number(size.value); syncUI(); });
  const mainEl = h('canvas', { id: 'draw-main', width: String(W), height: String(H) });
  const topEl = h('canvas', { id: 'draw-top', width: String(W), height: String(H) });
  topEl.addEventListener('pointerdown', onDown);
  topEl.addEventListener('pointermove', onMove);
  topEl.addEventListener('pointerup', onUp);
  topEl.addEventListener('pointercancel', onUp);
  document.addEventListener('keydown', e => {
    if (!D || $('draw-modal').classList.contains('hidden') || !(e.ctrlKey || e.metaKey)) return;
    if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); redo(); }
  });
  document.body.append(h('div', { class: 'modal-overlay hidden', id: 'draw-modal' },
    h('div', { class: 'draw-sheet' },
      h('div', { class: 'draw-bar' }, tools,
        h('span', { class: 'draw-sep' }), swatches, colorInput,
        h('span', { class: 'draw-sep' }), size, h('span', { id: 'draw-size-label', class: 'draw-size-label' }),
        h('span', { class: 'draw-sep' }),
        h('button', { id: 'draw-undo', class: 'draw-btn', title: 'Отменить (Ctrl+Z)', text: '↶', onclick: undo }),
        h('button', { id: 'draw-redo', class: 'draw-btn', title: 'Повторить (Ctrl+Y)', text: '↷', onclick: redo }),
        h('span', { class: 'draw-grow' }),
        h('button', { class: 'draw-btn wide', title: 'Отправить рисунок в чат', text: '📤 В чат', onclick: saveToChat }),
        h('button', { class: 'draw-btn', title: 'Скачать PNG', text: '⬇', onclick: download }),
        h('button', { class: 'draw-btn', title: 'Закрыть', text: '✕', onclick: closeDraw })),
      h('div', { class: 'draw-stage' }, mainEl, topEl))));
}

export async function openDraw(chat, act) {
  if (D) return;
  if (!ID.test(act?.id || '') || !HEX.test(act?.bg || '')) return toast('Рисовалка', 'Рисунок недоступен', 'error');
  const key = await chatKey(chat);
  if (!key) return toast('Рисовалка', 'Ключи не загружены. Войдите заново.', 'error');
  ensureModal();
  const mainEl = $('draw-main'), topEl = $('draw-top');
  const session = D = {
    chat, id: act.id, bg: act.bg, key, ref: db.ref('activities/' + chat.id + '/' + act.id),
    log: [], keys: new Set(), strokes: new Map(), order: [], hidden: new Set(), local: new Set(),
    mine: [], redo: [], ready: false, tool: 'pen', color: PALETTE[0], size: 6, cur: null, timer: 0,
    mainEl, topEl, main: mainEl.getContext('2d'), preview: topEl.getContext('2d')
  };
  $('draw-modal').querySelector('.draw-size').value = '6';
  $('draw-modal').querySelector('.draw-color').value = PALETTE[0];
  redraw();
  recompute();
  showModal('draw-modal');
  session.ref.on('child_added', onChild, () => toast('Рисовалка', 'Нет доступа к рисунку', 'error'));
  session.ref.once('value', () => enqueue(() => {
    if (D !== session) return;
    session.ready = true;
    redraw();
    recompute();
  }));
}

/* ---------- в чате ---------- */
export function drawNode(act) {
  if (!ID.test(act.id || '') || !HEX.test(act.bg || '')) return h('div', { class: 'act-error', text: '⚠ активность недоступна' });
  return h('div', { class: 'act-whoami' },
    h('div', { class: 'wheel-title', text: '🎨 Рисовалка' }),
    h('div', { class: 'whoami-hint', text: 'Общий холст: рисуйте вместе в реальном времени.' }),
    h('button', { class: 'btn btn-primary draw-open', text: 'Открыть холст', onclick: () => state.chat && openDraw(state.chat, act) }));
}

function ensureStartModal() {
  if ($('draw-start')) return;
  document.body.append(h('div', { class: 'modal-overlay hidden', id: 'draw-start' },
    h('div', { class: 'modal' },
      h('h3', { text: 'Рисовалка' }),
      h('p', { class: 'whoami-hint', text: 'Выберите фон холста. Рисовать смогут все участники чата.' }),
      h('div', { class: 'draw-bgs', id: 'draw-bgs' }),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-secondary', text: 'Отмена', onclick: () => hideModal('draw-start') })))));
}

export async function startDraw(chat) {
  const { mode } = await resolveMode(chat).catch(() => ({}));
  if (mode !== 'enc') return toast('Активности', 'Активности работают только в зашифрованных чатах', 'error');
  ensureStartModal();
  const box = clear($('draw-bgs'));
  for (const [name, color] of BGS) {
    const b = h('button', {
      class: 'draw-bg', text: name,
      onclick: async () => {
        hideModal('draw-start');
        const act = { type: 'draw', id: nonce(), bg: color };
        try {
          await sendPayload(chat, { act });
          openDraw(chat, act);
        } catch (e) {
          toast('Ошибка', e.message || 'Не удалось создать рисунок', 'error');
        }
      }
    });
    b.style.background = color;
    b.style.color = color === '#14141f' ? '#fff' : '#111';
    box.append(b);
  }
  showModal('draw-start');
}
