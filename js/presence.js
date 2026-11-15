import { db } from './firebase.js';
import { state } from './state.js';
import { $, h, clear, getUser } from './util.js';

// Режимы: all — виден всем, some — только выбранным контактам, none — никому.
// "Все" пишется в публичное users/{я}/online, "выбранные" — в presence/{я}/{они}: правила БД
// отдают каждому читателю только его собственную ячейку, так что скрытие настоящее, а не косметическое.
const DEFAULT = () => ({ online: 'all', allow: {} });
let cfg = DEFAULT();
let opened = new Set();
let getChats = () => [];

const slot = (owner, viewer) => db.ref('presence/' + owner + '/' + viewer);
const quiet = p => p?.catch?.(() => {});

function apply() {
  const me = state.me.uid;
  const pub = db.ref('users/' + me + '/online');
  quiet(pub.set(cfg.online === 'all'));
  quiet(pub.onDisconnect().set(false));
  const allowed = cfg.online === 'some' ? Object.keys(cfg.allow) : [];
  for (const uid of new Set([...allowed, ...opened])) {
    const ref = slot(me, uid);
    quiet(ref.set(allowed.includes(uid)));
    quiet(ref.onDisconnect().set(false));
  }
  opened = new Set(allowed);
}

function save() {
  quiet(db.ref('privacy/' + state.me.uid).set({ online: cfg.online, allow: Object.keys(cfg.allow).length ? cfg.allow : null }));
  apply();
}

async function renderList() {
  const box = $('presence-list');
  if (!box) return;
  clear(box);
  if (cfg.online !== 'some') return;
  const uids = [...new Set(getChats()
    .filter(c => c.type === 'dm')
    .map(c => Object.keys(c.participants || {}).find(u => u !== state.me.uid))
    .filter(Boolean))];
  if (!uids.length) {
    box.append(h('div', { class: 'settings-label' }, h('div', { class: 'desc', text: 'Пока нет личных чатов' })));
    return;
  }
  const users = await Promise.all(uids.map(u => getUser(u).catch(() => null)));
  users.forEach((user, i) => {
    if (!user) return;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!cfg.allow[uids[i]];
    input.addEventListener('change', () => {
      if (input.checked) cfg.allow[uids[i]] = true;
      else delete cfg.allow[uids[i]];
      save();
    });
    box.append(h('label', { class: 'settings-row' },
      h('div', { class: 'settings-label' },
        h('div', { class: 'title', text: user.name }),
        h('div', { class: 'desc', text: '@' + user.nick })),
      input));
  });
}

function buildUI() {
  const section = $('privacy-section');
  if (!section || $('presence-ui')) return;
  const select = h('select', { id: 'presence-mode' },
    new Option('Все', 'all'), new Option('Только выбранные', 'some'), new Option('Никто', 'none'));
  select.addEventListener('change', () => {
    cfg.online = select.value;
    save();
    renderList();
  });
  section.prepend(h('div', { id: 'presence-ui' },
    h('div', { class: 'settings-row' },
      h('div', { class: 'settings-label' },
        h('div', { class: 'title', text: 'Кто видит, что я в сети' }),
        h('div', { class: 'desc', text: 'Остальным вместо «онлайн» будет показано «не в сети». Сами сообщения по-прежнему видны.' })),
      select),
    h('div', { id: 'presence-list' })));
  document.querySelector('[data-arg="privacy"]')?.addEventListener('click', renderList);
}

export async function startPresence(chatsGetter) {
  getChats = chatsGetter;
  cfg = DEFAULT();
  try {
    const v = (await db.ref('privacy/' + state.me.uid).once('value')).val();
    if (v) cfg = { online: ['all', 'some', 'none'].includes(v.online) ? v.online : 'all', allow: v.allow || {} };
  } catch {}
  buildUI();
  const select = $('presence-mode');
  if (select) select.value = cfg.online;
  apply();
  renderList();
}

export function stopPresence() {
  const me = state.me?.uid;
  if (me) {
    quiet(db.ref('users/' + me + '/online').set(false));
    for (const uid of opened) quiet(slot(me, uid).set(false));
  }
  opened = new Set();
  cfg = DEFAULT();
}

// Для зрителя: онлайн, если человек открыт всем или лично мне.
export function watchOnline(uid, cb) {
  let pub = false, mine = false;
  const a = db.ref('users/' + uid + '/online');
  const b = slot(uid, state.me.uid);
  const ha = s => { pub = !!s.val(); cb(pub || mine); };
  const hb = s => { mine = !!s.val(); cb(pub || mine); };
  a.on('value', ha);
  b.on('value', hb, () => {});
  return () => { a.off('value', ha); b.off('value', hb); };
}
