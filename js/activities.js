import { state } from './state.js';
import { $, h, clear, getUser, toast, showModal, hideModal } from './util.js';
import { resolveMode, sendPayload, uploadAttachment } from './messages.js';
import { attachmentNode } from './media.js';
import { drawNode, startDraw } from './draw.js';

/* ---------- общее ---------- */
const SEEN_KEY = 'low:acts';
const seen = (() => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY)) || []); } catch { return new Set(); } })();
const markSeen = id => {
  seen.add(id);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-300))); } catch {}
};
const nonce = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
const randomIndex = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;

function currentChat() {
  const chat = state.chat;
  if (!chat) return null;
  if (chat.type === 'channel') {
    toast('Активности', 'В каналах активности недоступны', 'error');
    return null;
  }
  return chat;
}

// Активности едут внутри зашифрованного сообщения; без шифрования правила базы их не примут.
async function ensureEncrypted(chat) {
  const { mode } = await resolveMode(chat);
  if (mode !== 'enc') throw new Error('Активности работают только в зашифрованных чатах');
}

/* ---------- колесо рандома ---------- */
const COLORS = ['#6c5ce7', '#00b894', '#fdcb6e', '#ff6b81', '#3498db', '#a29bfe', '#ff9f43', '#1abc9c', '#e17055', '#74b9ff', '#fd79a8', '#55efc4'];
const TAU = Math.PI * 2;
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function makeCanvas() {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = canvas.height = Math.round(260 * dpr);
  canvas.className = 'wheel';
  return canvas;
}

function drawWheel(canvas, options, rot) {
  const ctx = canvas.getContext('2d');
  const k = canvas.width / 260;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, 260, 260);
  const cx = 130, cy = 138, r = 116, n = options.length, th = TAU / n;
  options.forEach((label, i) => {
    const a0 = -Math.PI / 2 + rot + i * th;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a0 + th);
    ctx.closePath();
    ctx.fillStyle = COLORS[i % COLORS.length];
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a0 + th / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = '600 13px sans-serif';
    ctx.fillText(shorten(label, n > 8 ? 10 : 14), r - 10, 0);
    ctx.restore();
  });
  ctx.beginPath();
  ctx.arc(cx, cy, 14, 0, TAU);
  ctx.fillStyle = '#12121f';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 11, 2);
  ctx.lineTo(cx + 11, 2);
  ctx.lineTo(cx, 30);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.stroke();
}

const restRotation = (n, result) => -(result + 0.5) * (TAU / n);

function spin(canvas, options, result, onDone) {
  const th = TAU / options.length;
  const target = TAU * 5 - (result + 0.5) * th + (Math.random() - 0.5) * th * 0.6;
  const t0 = performance.now(), ms = 4200;
  const frame = now => {
    const t = Math.min(1, (now - t0) / ms);
    drawWheel(canvas, options, target * (1 - Math.pow(1 - t, 4)));
    if (t < 1) requestAnimationFrame(frame);
    else { drawWheel(canvas, options, restRotation(options.length, result)); onDone?.(); }
  };
  requestAnimationFrame(frame);
}

function validWheel(act) {
  return Array.isArray(act.options) && act.options.length >= 2 && act.options.length <= 12
    && Number.isInteger(act.result) && act.result >= 0 && act.result < act.options.length;
}

function wheelNode(act, msg) {
  if (!validWheel(act)) return h('div', { class: 'act-error', text: '⚠ активность недоступна' });
  const options = act.options.map(o => String(o).slice(0, 30));
  const canvas = makeCanvas();
  const out = h('div', { class: 'wheel-result' });
  const finish = () => { out.textContent = '🎯 Выпало: ' + options[act.result]; };
  const play = () => { out.textContent = 'Крутим…'; spin(canvas, options, act.result, finish); };
  const key = act.nid || msg.id;
  if (!seen.has(key) && Date.now() - msg.at < 30000) { markSeen(key); drawWheel(canvas, options, 0); play(); }
  else { drawWheel(canvas, options, restRotation(options.length, act.result)); finish(); }
  canvas.addEventListener('click', play);
  return h('div', { class: 'act-wheel' },
    act.title ? h('div', { class: 'wheel-title', text: String(act.title).slice(0, 80) }) : null,
    canvas, out);
}

function ensureWheelModal() {
  if ($('wheel-modal')) return;
  const title = h('input', { id: 'wheel-title', placeholder: 'Вопрос (необязательно): во что играем?', maxlength: '80', autocomplete: 'off' });
  const list = h('textarea', { id: 'wheel-options', rows: '5', placeholder: 'Варианты, каждый с новой строки (от 2 до 12)' });
  const preview = makeCanvas();
  const go = h('button', { class: 'btn btn-primary', text: 'Крутить и отправить' });
  const cancel = h('button', { class: 'btn btn-secondary', text: 'Отмена', onclick: () => { if (!go.disabled) hideModal('wheel-modal'); } });
  const parse = () => list.value.split('\n').map(s => s.trim().slice(0, 30)).filter(Boolean);
  const redraw = () => { const o = parse(); drawWheel(preview, o.length >= 2 ? o.slice(0, 12) : ['?', '?', '?'], 0); };
  list.addEventListener('input', redraw);
  go.addEventListener('click', async () => {
    const options = parse();
    if (options.length < 2 || options.length > 12) return toast('Колесо', 'Нужно от 2 до 12 вариантов', 'error');
    const chat = state.chat;
    if (!chat) return;
    go.disabled = true;
    try {
      await ensureEncrypted(chat);
      const act = { type: 'wheel', options, result: randomIndex(options.length), nid: nonce() };
      if (title.value.trim()) act.title = title.value.trim().slice(0, 80);
      markSeen(act.nid);
      await new Promise(done => spin(preview, options, act.result, done));
      await sendPayload(chat, { act });
      hideModal('wheel-modal');
    } catch (e) {
      toast('Ошибка', e.message || 'Не удалось отправить', 'error');
    } finally {
      go.disabled = false;
    }
  });
  document.body.append(h('div', { class: 'modal-overlay hidden', id: 'wheel-modal' },
    h('div', { class: 'modal' }, h('h3', { text: 'Колесо рандома' }), title, list,
      h('div', { class: 'wheel-preview' }, preview),
      h('div', { class: 'modal-actions' }, cancel, go))));
  redraw();
}

function startWheel() {
  if (!currentChat()) return;
  ensureWheelModal();
  showModal('wheel-modal');
}

/* ---------- стирашка ---------- */
async function startScratch() {
  const chat = currentChat();
  if (!chat) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    toast('Стирашка', 'Загружаю…');
    try {
      await ensureEncrypted(chat);
      const meta = await uploadAttachment(file, true);
      meta.name = 'scratch' + ((file.name.match(/\.[a-z0-9]{1,5}$/i) || [''])[0]);
      await sendPayload(chat, { file: meta, act: { type: 'scratch' } });
      toast('Стирашка', 'Отправлено', 'success');
    } catch (e) {
      toast('Ошибка', e.message || 'Не удалось отправить', 'error');
    }
  });
  input.click();
}

function scratchNode(payload, msg) {
  const wrap = h('div', { class: 'scratch' }, attachmentNode(payload.file));
  const key = 'scratch:' + msg.id;
  if (msg.from === state.me.uid || seen.has(key)) return wrap;
  const canvas = h('canvas', { class: 'scratch-cover' });
  wrap.append(canvas, h('div', { class: 'scratch-hint', text: '👆 Сотрите, чтобы открыть' }));
  let down = false, last = null, lastCheck = 0, size = '';
  const ctx = () => canvas.getContext('2d', { willReadFrequently: true });

  const paint = () => {
    const w = wrap.clientWidth, hgt = wrap.clientHeight;
    if (!w || !hgt || size === w + 'x' + hgt) return;
    size = w + 'x' + hgt;
    canvas.width = w;
    canvas.height = hgt;
    const c = ctx();
    c.globalCompositeOperation = 'source-over';
    const g = c.createLinearGradient(0, 0, w, hgt);
    g.addColorStop(0, '#7c5cff');
    g.addColorStop(1, '#b388ff');
    c.fillStyle = g;
    c.fillRect(0, 0, w, hgt);
    for (let i = 0; i < (w * hgt) / 350; i++) {
      c.fillStyle = 'rgba(255,255,255,' + Math.random() * 0.2 + ')';
      c.fillRect(Math.random() * w, Math.random() * hgt, 2, 2);
    }
  };
  new ResizeObserver(paint).observe(wrap);

  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
  };
  const erase = (a, b) => {
    const c = ctx();
    c.globalCompositeOperation = 'destination-out';
    c.lineWidth = 38;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
  };
  const reveal = () => {
    markSeen(key);
    canvas.classList.add('gone');
    wrap.querySelector('.scratch-hint')?.remove();
    setTimeout(() => canvas.remove(), 500);
  };
  const check = () => {
    lastCheck = Date.now();
    const { width: w, height: hgt } = canvas;
    if (!w || !hgt) return;
    const px = ctx().getImageData(0, 0, w, hgt).data;
    let total = 0, clear = 0;
    for (let y = 0; y < hgt; y += 10) for (let x = 0; x < w; x += 10) { total++; if (px[(y * w + x) * 4 + 3] < 128) clear++; }
    if (total && clear / total > 0.5) reveal();
  };
  canvas.addEventListener('pointerdown', e => { down = true; canvas.setPointerCapture(e.pointerId); last = pos(e); erase(last, last); });
  canvas.addEventListener('pointermove', e => {
    if (!down) return;
    const p = pos(e);
    erase(last, p);
    last = p;
    if (Date.now() - lastCheck > 400) check();
  });
  const up = () => { if (down) { down = false; check(); } };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  return wrap;
}

/* ---------- кто я? ---------- */
const ROLES = {
  'Животные': ['Кошка', 'Собака', 'Слон', 'Жираф', 'Пингвин', 'Дельфин', 'Лиса', 'Медведь', 'Волк', 'Попугай', 'Хамелеон', 'Панда', 'Капибара', 'Осьминог', 'Сова', 'Ёжик', 'Кенгуру', 'Акула', 'Бобёр', 'Лягушка', 'Улитка', 'Енот', 'Зебра', 'Лама'],
  'Профессии': ['Повар', 'Пилот', 'Врач', 'Учитель', 'Программист', 'Космонавт', 'Пожарный', 'Музыкант', 'Художник', 'Таксист', 'Фотограф', 'Строитель', 'Детектив', 'Библиотекарь', 'Курьер', 'Блогер', 'Архитектор', 'Фермер', 'Хирург', 'Почтальон', 'Тренер', 'Режиссёр', 'Моряк', 'Судья'],
  'Персонажи': ['Шерлок Холмс', 'Гарри Поттер', 'Шрек', 'Микки Маус', 'Бэтмен', 'Пикачу', 'Марио', 'Винни-Пух', 'Чебурашка', 'Волк из «Ну, погоди!»', 'Дарт Вейдер', 'Человек-паук', 'Губка Боб', 'Элза', 'Джек Воробей', 'Балу', 'Карлсон', 'Кот Леопольд', 'Масяня', 'Тони Старк', 'Йода', 'Лунтик', 'Соник', 'Незнайка'],
  'Знаменитости': ['Эйнштейн', 'Пушкин', 'Моцарт', 'Леонардо да Винчи', 'Илон Маск', 'Гагарин', 'Чарли Чаплин', 'Мэрилин Монро', 'Наполеон', 'Тесла', 'Пабло Пикассо', 'Фредди Меркьюри', 'Цезарь', 'Ломоносов', 'Мария Кюри', 'Майкл Джексон', 'Бетховен', 'Клеопатра', 'Эдисон', 'Цой', 'Высоцкий', 'Дали', 'Тетрис-Пажитнов', 'Стив Джобс'],
  'Предметы': ['Чайник', 'Зонтик', 'Велосипед', 'Холодильник', 'Гитара', 'Очки', 'Телевизор', 'Лампочка', 'Рюкзак', 'Часы', 'Зеркало', 'Утюг', 'Микроволновка', 'Книга', 'Подушка', 'Кактус', 'Пылесос', 'Компас', 'Палатка', 'Свеча', 'Пианино', 'Фонарик', 'Самокат', 'Тостер']
};
const ANY = 'Любая категория';

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = randomIndex(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Завершение игры: первое событие «конец» для каждой игры запоминается и обновляет все показанные карточки.
const whoamiEnd = new Map();
const whoamiViews = new Map();
function endWhoami(nid, info) {
  if (!nid || whoamiEnd.has(nid)) return;
  whoamiEnd.set(nid, info);
  [...(whoamiViews.get(nid) || [])].forEach(fn => fn());
}
const nameOf = async uid => (uid === state.me.uid ? 'Вы' : (await getUser(uid).catch(() => null))?.name || '?');

const norm = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
// Принимается полное название, любое слово из него (от 4 букв) и небольшие опечатки.
function guessMatches(guess, role) {
  const g = norm(guess), r = norm(role);
  if (!g) return false;
  const near = (x, y) => lev(x, y) <= Math.floor(y.length / 6);
  return near(g, r) || r.split(' ').some(w => w.length >= 4 && near(g, w));
}

function whoamiEndNode(act) {
  const info = { how: act.how === 'guess' ? 'guess' : 'reveal', by: String(act.by || ''), role: String(act.role || '').slice(0, 40) };
  endWhoami(String(act.ref || ''), info);
  const el = h('div', { class: 'whoami-end', text: '…' });
  nameOf(info.by).then(name => {
    el.textContent = info.how === 'guess'
      ? '🏆 Игра окончена. Победитель: ' + name + ' (роль: ' + info.role + ')'
      : '🏳️ Игра окончена: ' + name + ' посмотрел(а) роль «' + info.role + '»';
  });
  return el;
}

function whoamiNode(act, msg) {
  const entries = act.roles && typeof act.roles === 'object' ? Object.entries(act.roles).slice(0, 12) : [];
  if (entries.length < 2) return h('div', { class: 'act-error', text: '⚠ активность недоступна' });
  const me = state.me.uid;
  const nid = String(act.nid || msg.id);
  const key = 'whoami:' + nid;
  const myRole = act.roles[me] ? String(act.roles[me]) : null;
  let revealed = seen.has(key), armed = false, guessing = false, busy = false, built = false;
  const body = h('div', { class: 'whoami-list' });
  const card = h('div', { class: 'act-whoami' },
    h('div', { class: 'wheel-title', text: '🎭 Кто я?' }),
    h('div', { class: 'whoami-hint', text: 'Свою роль не видно. Задавайте вопросы в чате: отвечать можно только «да» или «нет».' }),
    body);

  async function finish(how) {
    if (busy) return;
    busy = true;
    try {
      await sendPayload(state.chat, { act: { type: 'whoami-end', ref: nid, by: me, how, role: myRole.slice(0, 40) } });
      revealed = true;
      markSeen(key);
      endWhoami(nid, { how, by: me, role: myRole.slice(0, 40) });
    } catch (e) {
      toast('Ошибка', e.message || 'Не удалось отправить', 'error');
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    if (built && !card.isConnected) { whoamiViews.get(nid)?.delete(render); return; }
    built = true;
    const end = whoamiEnd.get(nid);
    const open = revealed || !!end;
    clear(body);
    for (const [uid, role] of entries) {
      const mine = uid === me;
      const name = h('span', { class: 'whoami-name', text: mine ? 'Вы' : '…' });
      if (!mine) nameOf(uid).then(n => { name.textContent = n; });
      body.append(h('div', { class: 'whoami-row' }, name, h('b', { text: mine && !open ? '❓ ???' : String(role).slice(0, 40) })));
    }
    if (end) {
      const status = h('div', { class: 'whoami-end', text: '🏁 Игра окончена' });
      nameOf(end.by).then(n => { status.textContent = end.how === 'guess' ? '🏆 Игра окончена. Победитель: ' + n : '🏳️ Игра окончена: ' + n + ' посмотрел(а) свою роль'; });
      body.append(status);
      return;
    }
    if (!myRole) return;
    if (guessing) {
      const input = h('input', { class: 'whoami-input', placeholder: 'Кто вы по-вашему?', maxlength: '60', autocomplete: 'off' });
      const submit = () => {
        if (!input.value.trim()) return;
        if (guessGood(input.value)) finish('guess');
        else { toast('Кто я?', 'Не угадали, попробуйте ещё', 'error'); input.select(); }
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
      body.append(h('div', { class: 'whoami-guess' }, input,
        h('button', { class: 'btn btn-primary', text: 'Проверить', onclick: submit }),
        h('button', { class: 'btn btn-secondary', text: '✕', onclick: () => { guessing = false; render(); } })));
      setTimeout(() => input.focus(), 0);
      return;
    }
    body.append(h('div', { class: 'whoami-actions' },
      h('button', { class: 'btn btn-primary', text: 'Угадать', onclick: () => { guessing = true; render(); } }),
      h('button', {
        class: 'btn btn-secondary',
        text: armed ? 'Точно? Игра закончится' : 'Показать мою роль',
        onclick: () => {
          if (!armed) { armed = true; render(); setTimeout(() => { armed = false; if (!whoamiEnd.has(nid)) render(); }, 3000); return; }
          finish('reveal');
        }
      })));
  }
  const guessGood = text => guessMatches(text, myRole);
  if (!whoamiViews.has(nid)) whoamiViews.set(nid, new Set());
  whoamiViews.get(nid).add(render);
  render();
  return card;
}

function ensureWhoamiModal() {
  if ($('whoami-modal')) return;
  const select = h('select', { id: 'whoami-cat' }, [ANY, ...Object.keys(ROLES)].map(c => new Option(c, c)));
  const players = h('div', { id: 'whoami-players' });
  const go = h('button', { class: 'btn btn-primary', text: 'Раздать роли' });
  go.addEventListener('click', async () => {
    const chat = state.chat;
    if (!chat) return;
    const uids = [...players.querySelectorAll('input:checked')].map(i => i.dataset.uid);
    if (uids.length < 2) return toast('Кто я?', 'Нужно минимум 2 игрока', 'error');
    if (uids.length > 12) return toast('Кто я?', 'Максимум 12 игроков', 'error');
    go.disabled = true;
    try {
      await ensureEncrypted(chat);
      const pool = shuffled(select.value === ANY ? Object.values(ROLES).flat() : ROLES[select.value]);
      const roles = {};
      uids.forEach((uid, i) => { roles[uid] = pool[i]; });
      const act = { type: 'whoami', roles, nid: nonce(), cat: select.value };
      markSeen('whoami-sent:' + act.nid);
      await sendPayload(chat, { act });
      hideModal('whoami-modal');
    } catch (e) {
      toast('Ошибка', e.message || 'Не удалось отправить', 'error');
    } finally {
      go.disabled = false;
    }
  });
  document.body.append(h('div', { class: 'modal-overlay hidden', id: 'whoami-modal' },
    h('div', { class: 'modal' }, h('h3', { text: 'Кто я?' }),
      h('p', { class: 'whoami-hint', text: 'Каждому достанется случайная роль. Её видят все, кроме самого игрока.' }),
      select, h('div', { class: 'act-cat', text: 'Игроки' }), players,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn btn-secondary', text: 'Отмена', onclick: () => hideModal('whoami-modal') }), go))));
}

async function startWhoAmI() {
  const chat = currentChat();
  if (!chat) return;
  const uids = Object.keys(chat.members || chat.participants || {});
  if (uids.length < 2) return toast('Кто я?', 'Нужен хотя бы один собеседник', 'error');
  ensureWhoamiModal();
  const box = clear($('whoami-players'));
  const users = await Promise.all(uids.map(u => getUser(u).catch(() => null)));
  users.forEach((user, i) => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.uid = uids[i];
    input.checked = i < 12;
    box.append(h('label', { class: 'forward-opt' }, input, h('span', { text: uids[i] === state.me.uid ? 'Вы' : (user?.name || '?') })));
  });
  showModal('whoami-modal');
}

/* ---------- отображение в чате ---------- */
export function activityNode(payload, msg) {
  const act = payload.act || {};
  if (act.type === 'wheel') return wheelNode(act, msg);
  if (act.type === 'draw') return drawNode(act);
  if (act.type === 'whoami') return whoamiNode(act, msg);
  if (act.type === 'whoami-end') return whoamiEndNode(act);
  if (act.type === 'scratch' && payload.file?.url) return scratchNode(payload, msg);
  return h('div', { class: 'act-error', text: '⚠ активность не поддерживается этой версией' });
}

/* ---------- меню активностей ---------- */
const CATEGORIES = [
  { icon: '🎨', title: 'Творчество', items: [
    { icon: '🖌️', title: 'Рисовалка', desc: 'Рисуйте на одном холсте', run: () => { const chat = currentChat(); if (chat) startDraw(chat); } },
    { icon: '🎟️', title: 'Стирашка', desc: 'Спрячьте картинку под покрытием', run: startScratch }
  ] },
  { icon: '🎲', title: 'Случайности', items: [
    { icon: '🎡', title: 'Колесо рандома', desc: 'Крутите и выбирайте', run: startWheel },
    { icon: '✨', title: 'Кнопка движухи', desc: 'Что-нибудь интересное' }
  ] },
  { icon: '🕹️', title: 'Игры', items: [
    { icon: '🔤', title: 'Wordle', desc: 'Угадайте слово друга' },
    { icon: '⚔️', title: 'Дуэль', desc: 'Сразитесь друг с другом' }
  ] },
  { icon: '💬', title: 'Общение', items: [
    { icon: '🎭', title: 'Кто я?', desc: 'Угадайте свою роль', run: startWhoAmI },
    { icon: '🗳️', title: 'Голосование', desc: 'Решайте вместе' }
  ] }
];

function ensureSheet() {
  if ($('act-modal')) return;
  const card = it => h('button', {
    class: 'act-card' + (it.run ? '' : ' soon'),
    ...(it.run ? {} : { disabled: '' }),
    onclick: () => { hideModal('act-modal'); it.run(); }
  }, h('span', { class: 'act-ico', text: it.icon }), h('b', { text: it.title }), h('small', { text: it.run ? it.desc : 'Скоро' }));
  document.body.append(h('div', { class: 'modal-overlay hidden', id: 'act-modal' },
    h('div', { class: 'act-sheet' },
      h('div', { class: 'act-head' },
        h('div', {}, h('h2', { text: 'Активности' }), h('p', { text: 'Развлекайтесь вместе прямо в чате' })),
        h('button', { class: 'act-close', text: '✕', onclick: () => hideModal('act-modal') })),
      CATEGORIES.map(cat => h('section', {},
        h('div', { class: 'act-cat', text: cat.icon + ' ' + cat.title }),
        h('div', { class: 'act-grid' }, cat.items.map(card)))))));
}

export function initActivities() {
  const anchor = $('gif-btn') || document.querySelector('[data-act="pickFile"]');
  if (!anchor || $('act-btn')) return;
  anchor.after(h('button', {
    id: 'act-btn', class: 'btn-icon', title: 'Активности', text: '🎮',
    onclick: e => { e.stopPropagation(); if (!currentChat()) return; ensureSheet(); showModal('act-modal'); }
  }));
}
