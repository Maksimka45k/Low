import { db, TS } from './firebase.js';
import { state } from './state.js';
import { $, h, clear, getUser, toast, showModal, hideModal } from './util.js';
import { chatKey, encryptJson, decryptJson, messageAad } from './crypto.js';
import { resolveMode, sendPayload } from './messages.js';
import { feedback, deriveTtt, deriveWordle, norm, validWord } from './game-logic.js';

/*
 * Игры на двоих (Wordle, крестики-нолики). Ходы хранятся в activities/{чат}/{игра}/ как журнал
 * зашифрованных событий (то же хранилище, что у рисовалки); состояние каждый раз считается из журнала.
 */
const ID = /^[0-9a-f]{16}$/;
const RU_ROWS = ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'];
const nonce = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
const nameOf = async uid => (uid === state.me.uid ? 'Вы' : (await getUser(uid).catch(() => null))?.name || '?');

async function requireEnc(chat) {
  const { mode } = await resolveMode(chat).catch(() => ({}));
  if (mode === 'enc') return true;
  toast('Игры', 'Игры работают только в зашифрованных чатах', 'error');
  return false;
}

// Подписка на журнал игры: события расшифровываются по очереди, журнал всегда отсортирован по ключу.
async function openLog(chat, id, onChange) {
  const key = await chatKey(chat);
  if (!key) throw new Error('Ключи не загружены. Войдите заново.');
  const ref = db.ref('activities/' + chat.id + '/' + id);
  const log = [], keys = new Set();
  let queue = Promise.resolve(), closed = false;
  const aadOf = from => messageAad(chat.id + ':' + id, from);
  const add = entry => {
    log.push(entry);
    log.sort((a, b) => (a.key < b.key ? -1 : 1));
    onChange(log);
  };
  ref.on('child_added', snap => {
    const k = snap.key, v = snap.val();
    if (closed || keys.has(k) || !v?.enc || typeof v.from !== 'string') return;
    queue = queue.then(async () => {
      if (closed || keys.has(k)) return;
      let d;
      try { d = await decryptJson(key, v.enc, aadOf(v.from)); } catch { return; }
      if (!d || typeof d !== 'object' || typeof d.k !== 'string') return;
      keys.add(k);
      add({ key: k, from: v.from, d });
    }).catch(() => {});
  }, () => toast('Игра', 'Нет доступа к игре', 'error'));
  return {
    send(d) {
      const me = state.me.uid, r = ref.push();
      keys.add(r.key);
      add({ key: r.key, from: me, d });
      encryptJson(key, d, aadOf(me)).then(enc => r.set({ from: me, at: TS, enc })).catch(() => toast('Игра', 'Не удалось отправить ход', 'error'));
    },
    close() { closed = true; ref.off(); }
  };
}

/* ---------- выбор соперника ---------- */
let startCtx = null;

function finishStart(go) {
  const c = startCtx;
  startCtx = null;
  hideModal('game-start');
  if (!c) return;
  if (!go) return c.res(null);
  const opp = c.fixed || document.querySelector('#gs-list input:checked')?.dataset.uid;
  c.res(opp ? { opp, random: !!$('gs-rand')?.checked } : null);
}

async function askOpponent(chat, { title, hint, random }) {
  const me = state.me.uid;
  const others = Object.keys(chat.members || chat.participants || {}).filter(u => u !== me);
  if (!others.length) { toast('Игра', 'Нужен хотя бы один собеседник', 'error'); return null; }
  if (others.length === 1 && !random) return { opp: others[0], random: false };
  if (!$('game-start')) {
    document.body.append(h('div', { class: 'modal-overlay hidden', id: 'game-start' },
      h('div', { class: 'modal' }, h('h3', { id: 'gs-title' }), h('p', { id: 'gs-hint', class: 'whoami-hint' }),
        h('div', { id: 'gs-random' }), h('div', { id: 'gs-list' }),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn btn-secondary', text: 'Отмена', onclick: () => finishStart(false) }),
          h('button', { class: 'btn btn-primary', text: 'Начать', onclick: () => finishStart(true) })))));
  }
  $('gs-title').textContent = title;
  $('gs-hint').textContent = hint;
  const rnd = clear($('gs-random'));
  if (random) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'gs-rand';
    rnd.append(h('label', { class: 'forward-opt' }, cb, h('span', { text: 'Случайно выбрать, кто загадывает слово' })),
      h('p', { class: 'whoami-hint', text: 'Если не отмечено, слово загадывает собеседник.' }));
  }
  const list = clear($('gs-list'));
  if (others.length > 1) {
    const names = await Promise.all(others.map(nameOf));
    others.forEach((u, i) => {
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'gs-opp';
      r.dataset.uid = u;
      r.checked = i === 0;
      list.append(h('label', { class: 'forward-opt' }, r, h('span', { text: names[i] })));
    });
  }
  return new Promise(res => {
    startCtx = { res, fixed: others.length === 1 ? others[0] : null };
    showModal('game-start');
  });
}

const cardError = () => h('div', { class: 'act-error', text: '⚠ игра недоступна' });
const goodAct = (act, a, b) => ID.test(act?.id || '') && typeof act[a] === 'string' && typeof act[b] === 'string' && act[a] !== act[b];

/* ---------- крестики-нолики ---------- */
let T = null;

function closeTtt() {
  if (!T) return;
  T.h?.close();
  hideModal('ttt-modal');
  T = null;
}

function renderTtt() {
  if (!T) return;
  const S = T.st = deriveTtt(T.act, T.log), me = state.me.uid, nm = u => T.names[u] || '?';
  const myIdx = S.players.indexOf(me), sign = p => (p === S.first ? 'X' : 'O');
  $('ttt-sub').textContent = nm(S.players[0]) + ' (' + sign(0) + ') — ' + nm(S.players[1]) + ' (' + sign(1) + ') · счёт '
    + S.score[S.players[0]] + ':' + S.score[S.players[1]] + ', ничьих ' + S.score.draw;
  let status;
  if (S.over) status = S.winner === null ? 'Ничья' : (S.players[S.winner] === me ? '🏆 Вы победили!' : 'Победил(а) ' + nm(S.players[S.winner]));
  else if (myIdx < 0) status = 'Ходит ' + nm(S.players[S.turn]);
  else status = myIdx === S.turn ? 'Ваш ход (' + sign(myIdx) + ')' : 'Ход соперника: ' + nm(S.players[S.turn]);
  $('ttt-status').textContent = status;
  const board = clear($('ttt-board'));
  S.board.forEach((c, i) => {
    const mark = c === null ? '' : sign(c);
    const cell = h('button', {
      class: 'ttt-cell' + (mark ? ' ' + mark.toLowerCase() : '') + (S.line?.includes(i) ? ' win' : ''),
      text: mark,
      ...(c !== null || S.over || myIdx !== S.turn ? { disabled: '' } : {}),
      onclick: () => T.h.send({ k: 'm', i })
    });
    board.append(cell);
  });
  const actions = clear($('ttt-actions'));
  if (S.over && myIdx >= 0) {
    const next = S.players[(S.round + 1) % 2];
    actions.append(h('button', { class: 'btn btn-primary', text: 'Играть ещё (первым ходит ' + nm(next) + ')', onclick: () => T.h.send({ k: 'new' }) }));
  }
}

export async function openTtt(chat, act) {
  if (T) return;
  if (!goodAct(act, 'a', 'b')) return toast('Игра', 'Игра недоступна', 'error');
  if (!$('ttt-modal')) {
    document.body.append(h('div', { class: 'modal-overlay hidden', id: 'ttt-modal' }, h('div', { class: 'game-sheet' },
      h('div', { class: 'game-head' }, h('h3', { text: 'Крестики-нолики' }), h('button', { class: 'act-close', text: '✕', onclick: closeTtt })),
      h('div', { id: 'ttt-sub', class: 'game-sub' }), h('div', { id: 'ttt-status', class: 'game-status' }),
      h('div', { id: 'ttt-board', class: 'ttt-board' }), h('div', { id: 'ttt-actions', class: 'game-actions' }))));
  }
  const session = T = { chat, act, log: [], names: {}, st: null, h: null };
  try {
    await Promise.all([act.a, act.b].map(async u => { session.names[u] = await nameOf(u); }));
    session.h = await openLog(chat, act.id, log => { session.log = log; if (T === session) renderTtt(); });
  } catch (e) {
    T = null;
    return toast('Игра', e.message || 'Не удалось открыть игру', 'error');
  }
  if (T !== session) { session.h.close(); return; }
  showModal('ttt-modal');
  renderTtt();
}

export function tttNode(act) {
  if (!goodAct(act, 'a', 'b')) return cardError();
  const sub = h('div', { class: 'whoami-hint', text: '…' });
  Promise.all([nameOf(act.a), nameOf(act.b)]).then(([a, b]) => { sub.textContent = 'Играют: ' + a + ' и ' + b; });
  return h('div', { class: 'act-whoami' }, h('div', { class: 'wheel-title', text: '❌ Крестики-нолики' }), sub,
    h('button', { class: 'btn btn-primary draw-open', text: 'Открыть игру', onclick: () => state.chat && openTtt(state.chat, act) }));
}

export async function startTtt(chat) {
  if (!(await requireEnc(chat))) return;
  const r = await askOpponent(chat, { title: 'Крестики-нолики', hint: 'Выберите соперника. Первым ходит тот, кто начал игру.', random: false });
  if (!r) return;
  const act = { type: 'ttt', id: nonce(), a: state.me.uid, b: r.opp };
  try {
    await sendPayload(chat, { act });
    openTtt(chat, act);
  } catch (e) {
    toast('Ошибка', e.message || 'Не удалось начать игру', 'error');
  }
}

/* ---------- wordle ---------- */
let G = null;

const canGuess = S => !!S && S.guesser === state.me.uid && !!S.word && !S.over;

function closeWordle() {
  if (!G) return;
  G.h?.close();
  hideModal('wordle-modal');
  G = null;
}

function typeLetter(ch) {
  if (G && canGuess(G.st) && G.typed.length < 5) { G.typed += ch; renderWordle(); }
}

function backspace() {
  if (G && canGuess(G.st)) { G.typed = G.typed.slice(0, -1); renderWordle(); }
}

function submitGuess() {
  if (!G || !canGuess(G.st)) return;
  if (G.typed.length !== 5) return toast('Wordle', 'Нужно 5 букв', 'error');
  G.h.send({ k: 'g', w: G.typed });
  G.typed = '';
}

function buildKeyboard(S, box) {
  const best = {}, rank = { x: 1, y: 2, g: 3 };
  for (const g of S.guesses) feedback(g, S.word).forEach((c, i) => { if (!best[g[i]] || rank[c] > rank[best[g[i]]]) best[g[i]] = c; });
  const key = (label, cls, fn) => h('button', { class: 'wd-key ' + cls, text: label, onclick: fn });
  RU_ROWS.forEach((row, ri) => {
    const line = h('div', { class: 'wd-krow' });
    if (ri === 2) line.append(key('⏎', 'wide', submitGuess));
    for (const ch of row) line.append(key(ch, best[ch] || '', () => typeLetter(ch)));
    if (ri === 2) line.append(key('⌫', 'wide', backspace));
    box.append(line);
  });
}

function renderWordle() {
  if (!G) return;
  const S = G.st = deriveWordle(G.act, G.log), me = state.me.uid, nm = u => G.names[u] || '?';
  const a = G.act.setter, b = G.act.guesser;
  const role = S.guesser === me ? 'Вы отгадываете' : S.setter === me ? 'Вы загадываете' : 'Вы наблюдаете';
  $('wd-sub').textContent = role + ' · счёт ' + nm(a) + ' ' + S.score[a] + ' : ' + S.score[b] + ' ' + nm(b);
  const board = clear($('wd-board'));
  for (let i = 0; i < 6; i++) {
    const guess = S.guesses[i];
    const typing = !guess && i === S.guesses.length && canGuess(S) ? G.typed : '';
    const fb = guess ? feedback(guess, S.word) : [];
    const row = h('div', { class: 'wd-row' });
    for (let j = 0; j < 5; j++) {
      row.append(h('div', { class: 'wd-cell' + (fb[j] ? ' ' + fb[j] : (typing[j] ? ' filled' : '')), text: (guess || typing)[j] || '' }));
    }
    board.append(row);
  }
  const info = clear($('wd-info')), keys = clear($('wd-keys')), actions = clear($('wd-actions'));
  if (!S.word) {
    if (S.setter === me) {
      info.textContent = 'Загадайте слово из 5 букв (ё считается как е).';
      const input = h('input', { class: 'whoami-input', placeholder: 'Слово из 5 букв', maxlength: '5', autocomplete: 'off' });
      input.value = G.secret;
      input.addEventListener('input', () => { G.secret = input.value; });
      const go = () => {
        const w = input.value.trim();
        if (!validWord(w)) return toast('Wordle', 'Нужно слово из 5 русских букв', 'error');
        G.secret = '';
        G.h.send({ k: 'word', w: norm(w) });
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      actions.append(h('div', { class: 'whoami-guess' }, input, h('button', { class: 'btn btn-primary', text: 'Загадать', onclick: go })));
    } else {
      info.textContent = 'Ждём, пока ' + nm(S.setter) + ' загадает слово…';
    }
  } else if (!S.over) {
    if (S.guesser === me) {
      info.textContent = 'Попытка ' + (S.guesses.length + 1) + ' из 6';
      buildKeyboard(S, keys);
    } else {
      info.textContent = S.setter === me ? 'Вы загадали «' + S.word.toUpperCase() + '». Отгадывает ' + nm(S.guesser) + '…' : 'Идёт игра';
    }
  } else {
    info.textContent = S.won ? '🎉 Слово отгадано: ' + S.word.toUpperCase() : 'Попытки закончились. Слово: ' + S.word.toUpperCase();
    if (me === a || me === b) actions.append(h('button', { class: 'btn btn-primary', text: 'Играть ещё (роли меняются)', onclick: () => G.h.send({ k: 'new' }) }));
  }
}

export async function openWordle(chat, act) {
  if (G) return;
  if (!goodAct(act, 'setter', 'guesser')) return toast('Игра', 'Игра недоступна', 'error');
  if (!$('wordle-modal')) {
    document.body.append(h('div', { class: 'modal-overlay hidden', id: 'wordle-modal' }, h('div', { class: 'game-sheet' },
      h('div', { class: 'game-head' }, h('h3', { text: 'Wordle' }), h('button', { class: 'act-close', text: '✕', onclick: closeWordle })),
      h('div', { id: 'wd-sub', class: 'game-sub' }), h('div', { id: 'wd-board', class: 'wd-board' }),
      h('div', { id: 'wd-info', class: 'game-status' }), h('div', { id: 'wd-actions' }), h('div', { id: 'wd-keys', class: 'wd-keys' }))));
    document.addEventListener('keydown', e => {
      if (!G || $('wordle-modal').classList.contains('hidden') || e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
      if (e.key === 'Enter') { e.preventDefault(); submitGuess(); }
      else if (e.key === 'Backspace') { e.preventDefault(); backspace(); }
      else if (/^[а-яё]$/i.test(e.key)) typeLetter(norm(e.key));
    });
  }
  const session = G = { chat, act, log: [], names: {}, st: null, typed: '', secret: '', h: null };
  try {
    await Promise.all([act.setter, act.guesser].map(async u => { session.names[u] = await nameOf(u); }));
    session.h = await openLog(chat, act.id, log => { session.log = log; if (G === session) renderWordle(); });
  } catch (e) {
    G = null;
    return toast('Игра', e.message || 'Не удалось открыть игру', 'error');
  }
  if (G !== session) { session.h.close(); return; }
  showModal('wordle-modal');
  renderWordle();
}

export function wordleNode(act) {
  if (!goodAct(act, 'setter', 'guesser')) return cardError();
  const sub = h('div', { class: 'whoami-hint', text: '…' });
  Promise.all([nameOf(act.setter), nameOf(act.guesser)]).then(([s, g]) => { sub.textContent = 'Загадывает: ' + s + ' · Отгадывает: ' + g; });
  return h('div', { class: 'act-whoami' }, h('div', { class: 'wheel-title', text: '🔤 Wordle' }), sub,
    h('button', { class: 'btn btn-primary draw-open', text: 'Открыть игру', onclick: () => state.chat && openWordle(state.chat, act) }));
}

export async function startWordle(chat) {
  if (!(await requireEnc(chat))) return;
  const r = await askOpponent(chat, { title: 'Wordle', hint: 'Один загадывает слово из 5 букв, другой отгадывает его за 6 попыток.', random: true });
  if (!r) return;
  const me = state.me.uid;
  const iSet = r.random && crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0;
  const act = { type: 'wordle', id: nonce(), setter: iSet ? me : r.opp, guesser: iSet ? r.opp : me };
  try {
    await sendPayload(chat, { act });
    openWordle(chat, act);
  } catch (e) {
    toast('Ошибка', e.message || 'Не удалось начать игру', 'error');
  }
}
