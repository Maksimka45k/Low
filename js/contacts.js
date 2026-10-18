import { db, TS } from './firebase.js';
import { state } from './state.js';
import { COLORS, $, h, clear, avatar, getUser, toast, showModal, hideModal, colorFromNick, getCurrentTime } from './util.js';
import { hasKeys, createGroupKeys, wrapGroupKeyFor, cacheChatKey, safetyNumber } from './crypto.js';
import { cachedChats, displayInfo, openChat, setTab, closeChat } from './chats.js';

const cleanNick = value => value.trim().toLowerCase().replace('@', '');
const dmId = (a, b) => 'dm_' + [a, b].sort().join('_');

async function uidByNick(nick) {
  if (!/^[a-z0-9_]{3,20}$/.test(nick)) return null;
  const snap = await db.ref('nickToUid/' + nick).once('value');
  return snap.val();
}

async function findDm(uid) {
  const hit = cachedChats().find(c => c.type === 'dm' && c.participants?.[uid]);
  if (hit) return hit.id;
  const id = dmId(state.me.uid, uid);
  const own = await db.ref('userChats/' + state.me.uid + '/' + id).once('value');
  if (own.exists()) return id;
  try {
    const chat = await db.ref('chats/' + id).once('value');
    if (!chat.exists() || !chat.child('participants/' + state.me.uid).exists()) return null;
    await db.ref('userChats/' + state.me.uid + '/' + id).set(true);
    return id;
  } catch {
    return null;
  }
}

export async function sendRequest(uid) {
  if (!uid || uid === state.me.uid) {
    toast('Ошибка', 'Нельзя добавить себя', 'error');
    return false;
  }
  const existing = await findDm(uid);
  if (existing) {
    openChat(existing);
    return true;
  }
  await db.ref('friendRequests/' + uid + '/' + state.me.uid).set({
    fromUid: state.me.uid,
    fromNick: state.me.nick,
    fromName: state.me.name,
    createdAt: TS
  });
  toast('Запрос отправлен', 'Пользователь увидит его во вкладке запросов', 'success');
  return true;
}

export async function createDM() {
  const input = $('dm-nick');
  const error = $('dm-error');
  error.textContent = '';
  const nick = cleanNick(input.value);
  if (!nick) { error.textContent = 'Введите никнейм'; return; }
  if (nick === state.me.nick) { error.textContent = 'Нельзя создать чат с самим собой'; return; }
  try {
    const uid = await uidByNick(nick);
    if (!uid) { error.textContent = 'Пользователь не найден'; return; }
    if (await sendRequest(uid)) {
      input.value = '';
      hideModal('dm-modal');
    }
  } catch (e) {
    error.textContent = 'Ошибка: ' + e.message;
  }
}

export async function acceptRequest(fromUid) {
  try {
    let id = await findDm(fromUid);
    if (!id) {
      id = dmId(state.me.uid, fromUid);
      const user = await getUser(fromUid);
      await db.ref('chats/' + id).set({
        type: 'dm',
        participants: { [state.me.uid]: true, [fromUid]: true },
        color: colorFromNick(user.nick),
        createdAt: TS,
        lastAt: TS
      });
      await db.ref('userChats/' + state.me.uid + '/' + id).set(true);
      await db.ref('userChats/' + fromUid + '/' + id).set(true);
    }
    await db.ref('friendRequests/' + state.me.uid + '/' + fromUid).remove();
    toast('Запрос принят', 'Чат создан', 'success');
    setTab('chats');
    openChat(id);
  } catch (e) {
    toast('Ошибка', e.message, 'error');
  }
}

export async function rejectRequest(fromUid) {
  await db.ref('friendRequests/' + state.me.uid + '/' + fromUid).remove();
  toast('Запрос отклонён', '', 'success');
}

export function setGroupType(type, el) {
  state.groupType = type;
  document.querySelectorAll('#group-modal .tab').forEach(t => t.classList.toggle('active', t === el));
  $('members-section').classList.toggle('hidden', type !== 'group');
}

function renderMembers() {
  clear($('members-list')).append(...state.members.map(m =>
    h('span', { class: 'member-chip' }, '@' + m.nick, h('span', { class: 'remove', 'data-act': 'removeMember', 'data-arg': m.uid, text: '✕' }))));
}

export function removeMember(uid) {
  state.members = state.members.filter(m => m.uid !== uid);
  renderMembers();
}

export async function addMember() {
  const input = $('member-nick');
  const error = $('group-error');
  error.textContent = '';
  const nick = cleanNick(input.value);
  if (!nick) return;
  const uid = await uidByNick(nick);
  if (!uid) { error.textContent = 'Пользователь не найден'; return; }
  if (uid === state.me.uid || state.members.some(m => m.uid === uid)) return;
  if (!(await hasKeys(uid))) { error.textContent = 'У пользователя ещё нет ключей шифрования: пусть зайдёт в аккаунт'; return; }
  state.members.push({ uid, nick });
  input.value = '';
  renderMembers();
}

export async function createGroup() {
  const error = $('group-error');
  error.textContent = '';
  const name = $('group-name').value.trim();
  if (!name) { error.textContent = 'Введите название'; return; }
  const type = state.groupType;
  const uids = type === 'group' ? [state.me.uid, ...state.members.map(m => m.uid)] : [state.me.uid];
  const id = db.ref('chats').push().key;
  const data = {
    type,
    name,
    desc: $('group-desc').value.trim(),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    members: Object.fromEntries(uids.map(uid => [uid, true])),
    ownerId: state.me.uid,
    createdAt: TS,
    lastAt: TS,
    lastMsg: type === 'channel' ? '📢 Канал создан' : '🔒 Группа создана',
    lastMsgTime: getCurrentTime()
  };
  try {
    let groupKey = null;
    if (type === 'group') {
      if (!state.privKey) throw new Error('Ключи шифрования не загружены');
      const made = await createGroupKeys(uids);
      data.keys = made.keys;
      groupKey = made.key;
    }
    await db.ref('chats/' + id).set(data);
    if (groupKey) cacheChatKey(id, groupKey);
    await db.ref().update(Object.fromEntries(uids.map(uid => ['userChats/' + uid + '/' + id, true])));
  } catch (e) {
    error.textContent = e.message;
    return;
  }
  state.members = [];
  $('group-name').value = '';
  $('group-desc').value = '';
  clear($('members-list'));
  hideModal('group-modal');
  openChat(id);
}

export async function invite() {
  const chat = state.chat;
  const nick = cleanNick(prompt('Введите никнейм пользователя:') || '');
  if (!chat || !nick) return;
  try {
    const uid = await uidByNick(nick);
    if (!uid) { toast('Ошибка', 'Пользователь не найден', 'error'); return; }
    if (chat.members?.[uid]) { toast('Уже в группе', '', 'error'); return; }
    const updates = {
      ['chats/' + chat.id + '/members/' + uid]: true,
      ['userChats/' + uid + '/' + chat.id]: true
    };
    if (chat.keys) {
      if (!(await hasKeys(uid))) { toast('Ошибка', 'У пользователя нет ключей шифрования', 'error'); return; }
      updates['chats/' + chat.id + '/keys/' + uid] = await wrapGroupKeyFor(chat, uid);
    }
    await db.ref().update(updates);
    toast('Готово', 'Пользователь добавлен', 'success');
    hideModal('info-modal');
  } catch (e) {
    toast('Ошибка', e.message, 'error');
  }
}

export async function leaveGroup() {
  const chat = state.chat;
  if (!chat || !confirm('Вы уверены, что хотите покинуть группу?')) return;
  await db.ref('chats/' + chat.id + '/members/' + state.me.uid).remove();
  await db.ref('userChats/' + state.me.uid + '/' + chat.id).remove();
  hideModal('info-modal');
  closeChat();
}

export function askDeleteChat() {
  if (state.chat?.type !== 'dm') return;
  hideModal('info-modal');
  showModal('delete-modal');
}

export async function deleteChatSelf() {
  const chat = state.chat;
  if (chat?.type !== 'dm') return;
  hideModal('delete-modal');
  closeChat();
  try {
    await db.ref().update({
      ['chats/' + chat.id + '/cleared/' + state.me.uid]: TS,
      ['chats/' + chat.id + '/unread/' + state.me.uid]: 0,
      ['userChats/' + state.me.uid + '/' + chat.id]: null
    });
    toast('Чат удалён', 'Он исчез только у вас', 'success');
  } catch (e) {
    toast('Ошибка', e.message, 'error');
  }
}

export async function deleteChatBoth() {
  const chat = state.chat;
  if (chat?.type !== 'dm') return;
  const other = Object.keys(chat.participants || {}).find(uid => uid !== state.me.uid);
  hideModal('delete-modal');
  closeChat();
  try {
    const update = {
      ['messages/' + chat.id]: null,
      ['chats/' + chat.id]: null,
      ['userChats/' + state.me.uid + '/' + chat.id]: null
    };
    if (other) update['userChats/' + other + '/' + chat.id] = null;
    await db.ref().update(update);
    toast('Чат удалён', 'Переписка стёрта у обоих', 'success');
  } catch (e) {
    toast('Ошибка', e.message, 'error');
  }
}

const channelLink = id => location.origin + location.pathname + '?channel=' + id;

export function copyChannelLink() {
  if (state.chat?.type !== 'channel') return;
  navigator.clipboard.writeText(channelLink(state.chat.id)).then(() => toast('Ссылка скопирована', '', 'success'), () => {});
}

export async function joinChannel(id) {
  if (!id || !state.me) return;
  try {
    const snap = await db.ref('chats/' + id).once('value');
    if (!snap.exists() || snap.val().type !== 'channel') {
      toast('Канал не найден', '', 'error');
      return;
    }
    await db.ref().update({
      ['chats/' + id + '/members/' + state.me.uid]: true,
      ['userChats/' + state.me.uid + '/' + id]: true
    });
    toast('Вы подписались на канал', '', 'success');
    openChat(id);
  } catch {
    toast('Канал не найден', '', 'error');
  }
}

const head = (info, cls, nick, desc) => h('div', { class: 'info-head' },
  h('div', { class: 'avatar large ' + cls, style: { background: info.color }, text: info.initials }),
  h('div', { class: 'info-name', text: info.name }),
  nick ? h('div', { class: 'info-nick', text: nick }) : null,
  desc ? h('div', { class: 'info-sub', text: desc }) : null);

async function memberRow(uid, owner) {
  const user = await getUser(uid);
  const mine = uid === state.me.uid;
  const tail = mine
    ? h('span', { class: 'tail', text: owner ? 'Вы (администратор)' : 'Вы' })
    : (owner ? h('button', { class: 'btn btn-secondary', text: '＋ В друзья', onclick: () => sendRequest(uid) }) : null);
  return h('div', { class: 'member-row' }, avatar(user, 'avatar small'),
    h('div', {}, h('div', { class: 'who', text: user.name }), h('div', { class: 'nick', text: '@' + user.nick })), tail);
}

export async function showChatInfo() {
  const chat = state.chat;
  if (!chat) return;
  const info = await displayInfo(chat);
  const box = clear($('info-content'));
  if (chat.type === 'dm') {
    box.append(head(info, '', '@' + (info.user?.nick || ''), info.user?.status || ''));
    box.append(h('div', { class: 'divider' }), h('div', { class: 'section-title', text: 'Шифрование' }));
    if (state.encrypted) {
      box.append(h('div', { class: 'info-sub', text: 'Сверьте номер с собеседником по другому каналу:' }),
        h('div', { class: 'info-link', text: await safetyNumber(info.uid) }));
    } else {
      box.append(h('div', { class: 'info-sub', text: 'Чат не зашифрован: у собеседника нет ключей.' }));
    }
    box.append(h('div', { class: 'divider' }),
      h('button', { class: 'btn btn-danger', 'data-act': 'deleteChat', text: 'Удалить чат' }));
  } else {
    const members = Object.keys(chat.members || {});
    const owner = chat.ownerId === state.me.uid;
    box.append(head(info, chat.type, '', chat.desc || ''));
    if (chat.type === 'channel') {
      box.append(h('div', { class: 'divider' }), h('div', { class: 'section-title', text: 'КАНАЛ' }));
      if (owner) {
        box.append(
          h('div', { class: 'info-sub', text: 'Поделитесь ссылкой, чтобы другие могли подписаться:' }),
          h('div', { class: 'info-link', text: channelLink(chat.id) }),
          h('button', { class: 'btn btn-secondary mb16', 'data-act': 'copyChannelLink', text: 'Скопировать ссылку' }));
      }
      box.append(h('div', { class: 'info-sub', text: '📢 Подписчиков: ' + members.length }));
      if (owner) {
        box.append(h('div', { class: 'section-title', text: 'ПОДПИСЧИКИ (' + members.length + ')' }));
        box.append(...await Promise.all(members.map(uid => memberRow(uid, true))));
      }
    } else {
      box.append(h('div', { class: 'divider' }), h('div', { class: 'section-title', text: 'УЧАСТНИКИ (' + members.length + ')' }));
      box.append(...await Promise.all(members.map(uid => memberRow(uid, false))));
      box.append(h('div', { class: 'divider' }),
        h('button', { class: 'btn btn-secondary mb16', 'data-act': 'invite', text: '＋ Добавить участника' }),
        h('button', { class: 'btn btn-danger', 'data-act': 'leaveGroup', text: 'Покинуть группу' }));
    }
  }
  showModal('info-modal');
}
