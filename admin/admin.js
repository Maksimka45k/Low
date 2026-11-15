import { FIREBASE_CONFIG } from '../js/config.js';

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth(), db = firebase.database(), TS = firebase.database.ServerValue.TIMESTAMP;
const $ = id => document.getElementById(id);
const FOREVER = 253402300799000, IDLE = 10 * 60 * 1000;
const fresh = () => ({ users: {}, chats: {}, moments: {}, bans: {}, mutes: {}, chatBans: {}, log: {} });
const S = { ...fresh(), tab: 'users', q: '', me: null };

// Весь пользовательский текст попадает в DOM только через textContent: XSS через ники/названия невозможен.
function h(tag, p = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(p)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter(Boolean));
  return n;
}
const live = m => !!m && m.until > Date.now();
const when = t => t >= FOREVER ? 'навсегда' : 'до ' + new Date(t).toLocaleString('ru');
const who = uid => S.users[uid] ? '@' + S.users[uid].nick : String(uid).slice(0, 8) + '…';
const tag = (t, c) => h('span', { class: 'tag ' + c, text: t });
const btn = (t, fn, c = '') => h('button', { class: 'btn ' + c, text: t, onclick: fn });
const row = (title, sub, tags, acts) => h('div', { class: 'row' },
  h('div', { class: 'info' }, h('b', { text: title }), h('small', { text: sub }), h('div', { class: 'tags' }, tags)),
  h('div', { class: 'acts' }, acts));

let toastTimer;
function toast(text, bad) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

/* ---------- вход, доступ, авто-выход ---------- */
let fails = 0, lockUntil = 0, idleTimer;
const loginErr = t => { $('login-err').textContent = t; };
const bump = () => { clearTimeout(idleTimer); if (S.me) idleTimer = setTimeout(() => auth.signOut(), IDLE); };
['click', 'keydown', 'mousemove', 'touchstart'].forEach(e => addEventListener(e, bump, { passive: true }));

async function login() {
  if (Date.now() < lockUntil) return loginErr('Слишком много попыток. Подождите минуту.');
  loginErr('');
  try {
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION); // сессия живёт только до закрытия вкладки
    await auth.signInWithEmailAndPassword($('email').value.trim(), $('pass').value);
  } catch {
    if (++fails >= 5) { lockUntil = Date.now() + 60000; fails = 0; }
    loginErr('Неверные данные');
  }
  $('pass').value = '';
}
$('login-btn').onclick = login;
$('pass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('logout').onclick = () => auth.signOut();

auth.onAuthStateChanged(async user => {
  if (!user) {
    S.me = null;
    Object.assign(S, fresh());
    $('list').replaceChildren();
    $('app').hidden = true;
    $('login').hidden = false;
    return;
  }
  let ok = false;
  try { ok = (await db.ref('admins/' + user.uid).once('value')).val() === true; } catch {}
  if (!ok) { await auth.signOut(); loginErr('Нет доступа'); return; }
  S.me = user.uid;
  $('login').hidden = true;
  $('app').hidden = false;
  bump();
  load();
});

/* ---------- данные ---------- */
const read = async p => (await db.ref(p).once('value')).val() || {};
async function load() {
  try {
    [S.users, S.chats, S.moments, S.bans, S.mutes, S.chatBans] =
      await Promise.all(['users', 'chats', 'moments', 'bans', 'mutes', 'chatBans'].map(read));
    for (const k of ['users', 'chats', 'moments']) for (const [id, v] of Object.entries(S[k])) v[k === 'users' ? 'uid' : 'id'] = id;
    if (S.tab === 'log') S.log = await db.ref('adminLog').limitToLast(100).once('value').then(s => s.val() || {});
    render();
  } catch (e) { toast('Ошибка загрузки: ' + e.message, 1); }
}
const log = (action, target, note = '') => db.ref('adminLog').push({ by: S.me, at: TS, action, target, note: String(note).slice(0, 200) });
async function run(fn, ok) {
  try { await fn(); toast(ok); await load(); } catch (e) { toast('Ошибка: ' + e.message, 1); }
}

/* ---------- диалог ---------- */
function ask(title, o = {}) {
  return new Promise(res => {
    const d = $('dlg');
    $('dlg-title').textContent = title;
    $('dlg-dur').hidden = !o.dur;
    $('dlg-reason').hidden = !(o.dur || o.input);
    $('dlg-reason').placeholder = o.input || 'причина (необязательно)';
    $('dlg-reason').value = '';
    $('dlg-word').hidden = !o.word;
    $('dlg-word').value = '';
    $('dlg-word').placeholder = o.word ? 'введите «' + o.word + '» для подтверждения' : '';
    const done = v => { d.onclose = null; d.close(); res(v); };
    d.onclose = () => res(null);
    $('dlg-no').onclick = () => done(null);
    $('dlg-ok').onclick = () => {
      if (o.word && $('dlg-word').value.trim() !== o.word) return toast('Подтверждение не совпало', 1);
      const s = Number($('dlg-dur').value);
      done({ until: s ? Date.now() + s * 1000 : FOREVER, reason: $('dlg-reason').value.trim().slice(0, 200) });
    };
    d.showModal();
  });
}

/* ---------- действия ---------- */
async function flag(node, id, title) {
  const r = await ask(title, { dur: true });
  if (!r) return;
  run(async () => {
    await db.ref(node + '/' + id).set({ until: r.until, reason: r.reason, by: S.me, at: TS });
    await log(node, id, r.reason);
  }, 'Готово');
}
const drop = (node, id) => run(async () => { await db.ref(node + '/' + id).remove(); await log('un-' + node, id); }, 'Снято');

const chatPaths = (c, skip) => {
  const o = { ['chats/' + c.id]: null, ['messages/' + c.id]: null, ['chatBans/' + c.id]: null };
  for (const m of Object.keys(c.members || c.participants || {})) if (m !== skip) o['userChats/' + m + '/' + c.id] = null;
  return o;
};

async function wipeUser(u) {
  if (!await ask('Удалить @' + u.nick + ' и все его данные? Необратимо.', { word: u.nick })) return;
  run(async () => {
    const up = { ['bans/' + u.uid]: { until: FOREVER, deleted: true, reason: 'account deleted', by: S.me, at: TS } };
    const mine = Object.keys(await read('userChats/' + u.uid));
    for (const id of mine) {
      const c = S.chats[id];
      if (!c) continue;
      if (c.type === 'dm' || c.ownerId === u.uid) Object.assign(up, chatPaths(c, u.uid));
      else { up['chats/' + id + '/members/' + u.uid] = null; up['chats/' + id + '/keys/' + u.uid] = null; }
    }
    for (const m of Object.values(S.moments)) if (m.userId === u.uid) up['moments/' + m.id] = null;
    for (const p of ['users/' + u.uid, 'nickToUid/' + u.nick, 'keyBackups/' + u.uid, 'friendRequests/' + u.uid, 'calls/' + u.uid, 'userChats/' + u.uid]) up[p] = null;
    await db.ref().update(up);
    await log('delete-user', u.uid, u.nick);
  }, 'Аккаунт удалён');
}

async function wipeChat(c, name) {
  if (!await ask('Удалить «' + name + '» вместе с сообщениями?', { word: 'удалить' })) return;
  run(async () => { await db.ref().update(chatPaths(c)); await log('delete-chat', c.id, name); }, 'Чат удалён');
}

async function giveChannel(c, name) {
  const r = await ask('Новый владелец «' + name + '»', { input: 'ник нового владельца (без @)' });
  if (!r || !r.reason) return;
  const nick = r.reason.toLowerCase().replace('@', '');
  const u = Object.values(S.users).find(x => x.nick === nick);
  if (!u) return toast('Такого ника нет', 1);
  run(async () => {
    await db.ref().update({
      ['chats/' + c.id + '/ownerId']: u.uid,
      ['chats/' + c.id + '/members/' + u.uid]: true,
      ['userChats/' + u.uid + '/' + c.id]: true
    });
    await log('transfer-channel', c.id, nick);
  }, 'Владелец изменён');
}

async function delMoment(m) {
  if (!await ask('Удалить момент @' + m.userNick + '?')) return;
  run(async () => { await db.ref('moments/' + m.id).remove(); await log('delete-moment', m.id, m.userNick); }, 'Момент удалён');
}

/* ---------- отрисовка ---------- */
const MEDIA = /^https:\/\/(files|litter)\.catbox\.moe\/[\w.\-/]+$/;
const ICON = { dm: '💬', group: '👥', channel: '📢' };

const usersRows = q => Object.values(S.users)
  .filter(u => !q || `${u.nick} ${u.name} ${u.uid}`.toLowerCase().includes(q))
  .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100)
  .map(u => {
    const b = S.bans[u.uid], m = S.mutes[u.uid];
    return row((u.online ? '🟢 ' : '') + (u.name || '?'), '@' + u.nick + ' · ' + u.uid,
      [live(b) && tag('БАН ' + when(b.until) + (b.reason ? ' · ' + b.reason : ''), 'bad'), live(m) && tag('МУТ ' + when(m.until) + (m.reason ? ' · ' + m.reason : ''), 'warn')],
      [live(b) ? btn('Разбан', () => drop('bans', u.uid)) : btn('Бан', () => flag('bans', u.uid, 'Бан @' + u.nick), 'danger'),
       live(m) ? btn('Размут', () => drop('mutes', u.uid)) : btn('Мут', () => flag('mutes', u.uid, 'Мут @' + u.nick)),
       btn('Удалить', () => wipeUser(u), 'danger')]);
  });

const chatsRows = q => Object.values(S.chats)
  .map(c => {
    const mem = Object.keys(c.members || c.participants || {});
    return { c, mem, name: c.type === 'dm' ? mem.map(who).join(' ↔ ') : (c.name || 'Без названия') };
  })
  .filter(x => !q || `${x.name} ${x.c.id}`.toLowerCase().includes(q))
  .sort((a, b) => (b.c.lastAt || 0) - (a.c.lastAt || 0)).slice(0, 100)
  .map(({ c, mem, name }) => {
    const cb = S.chatBans[c.id];
    return row((ICON[c.type] || '?') + ' ' + name,
      c.id + ' · участников: ' + mem.length + (c.ownerId ? ' · владелец ' + who(c.ownerId) : ''),
      [live(cb) && tag('ЗАБЛОКИРОВАН ' + when(cb.until) + (cb.reason ? ' · ' + cb.reason : ''), 'bad')],
      [live(cb) ? btn('Разбан', () => drop('chatBans', c.id)) : btn('Бан чата', () => flag('chatBans', c.id, 'Бан: ' + name), 'danger'),
       c.type === 'channel' && btn('Новый владелец', () => giveChannel(c, name)),
       btn('Удалить', () => wipeChat(c, name), 'danger')]);
  });

const momentsRows = q => Object.values(S.moments)
  .filter(m => !q || `${m.userNick} ${m.userName}`.toLowerCase().includes(q))
  .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100)
  .map(m => row('@' + m.userNick + ' · ' + m.type, 'истекает ' + new Date(m.expiresAt).toLocaleString('ru'), [],
    [MEDIA.test(m.url) && h('a', { class: 'btn', href: m.url, target: '_blank', rel: 'noopener noreferrer', text: 'Открыть' }),
     btn('Удалить', () => delMoment(m), 'danger'),
     S.users[m.userId] && btn('Бан автора', () => flag('bans', m.userId, 'Бан @' + m.userNick), 'danger')]));

const logRows = () => Object.values(S.log).sort((a, b) => b.at - a.at)
  .map(l => row(l.action + ' → ' + l.target, who(l.by) + ' · ' + new Date(l.at).toLocaleString('ru') + (l.note ? ' · ' + l.note : ''), [], []));

function render() {
  const us = Object.values(S.users);
  $('stats').textContent = `👤 ${us.length} · 🟢 ${us.filter(u => u.online).length} · 💬 ${Object.keys(S.chats).length} · 🚫 ${Object.values(S.bans).filter(live).length}`;
  const q = S.q.trim().toLowerCase().replace('@', '');
  const rows = { users: usersRows, chats: chatsRows, moments: momentsRows, log: logRows }[S.tab](q);
  $('list').replaceChildren(...(rows.length ? rows : [h('div', { class: 'note', text: 'Пусто' })]));
}

document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
  S.tab = b.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  load();
}));
$('q').addEventListener('input', e => { S.q = e.target.value; render(); });
