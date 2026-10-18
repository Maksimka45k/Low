import { db } from './firebase.js';
import { state } from './state.js';
import { $, h, clear, avatar, getUser, initials, userColor, safeColor, isMobile, toast } from './util.js';
import { otherUid, resolveMode, startMessages, stopMessages, resetComposer } from './messages.js';
import { loadMoments } from './moments.js';

const chatCache = new Map();
const chatRefs = new Map();
let listRef = null;
let listHandler = null;
let requestsRef = null;
let requestsHandler = null;
let onlineRef = null;
let onlineHandler = null;
let renderToken = 0;
let frame = 0;

export const cachedChats = () => [...chatCache.values()];

export async function displayInfo(chat) {
  if (chat.type === 'dm') {
    const uid = otherUid(chat);
    const user = uid ? await getUser(uid) : null;
    if (!user) return { name: '?', initials: '?', color: '#888888' };
    return { name: user.name, initials: initials(user.name), color: userColor(user), uid, user };
  }
  return { name: chat.name || 'Без названия', initials: initials(chat.name || '?'), color: safeColor(chat.color) };
}

function scheduleRender() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(renderChatList);
}

function chatRow(chat, info) {
  const unread = chat.unread?.[state.me.uid] || 0;
  const hidden = (chat.cleared?.[state.me.uid] || 0) >= (chat.lastAt || 0);
  const preview = hidden ? 'Нет сообщений' : (chat.lastMsg || 'Нет сообщений');
  const time = hidden ? '' : (chat.lastMsgTime || '');
  return h('div', { class: 'chat-item' + (state.chat?.id === chat.id ? ' active' : ''), onclick: () => openChat(chat.id) },
    h('div', { class: 'avatar ' + (chat.type === 'dm' ? '' : chat.type), style: { background: info.color }, text: info.initials }),
    h('div', { class: 'chat-info' },
      h('div', { class: 'chat-name', text: info.name }),
      h('div', { class: 'chat-preview', text: preview })),
    h('div', { class: 'chat-meta' },
      h('div', { class: 'chat-time', text: time }),
      unread ? h('div', { class: 'unread-badge', text: String(unread) }) : null));
}

async function renderChatList() {
  if (state.tab !== 'chats') return;
  const token = ++renderToken;
  const chats = cachedChats().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const infos = await Promise.all(chats.map(displayInfo));
  if (token !== renderToken || state.tab !== 'chats') return;
  const query = state.search.trim().toLowerCase();
  const rows = chats.map((chat, i) => ({ chat, info: infos[i] })).filter(({ info }) => !query || info.name.toLowerCase().includes(query));
  const list = clear($('chats-list'));
  if (!rows.length) {
    list.append(h('div', { class: 'note', text: query ? 'Ничего не найдено' : 'Нет чатов' }));
    return;
  }
  for (const { chat, info } of rows) list.append(chatRow(chat, info));
}

export function filterChats(value) {
  state.search = value;
  scheduleRender();
}

function watchChat(id) {
  const ref = db.ref('chats/' + id);
  const handler = snap => {
    if (chatRefs.get(id)?.handler !== handler) return;
    if (snap.exists()) {
      const fresh = { id, ...snap.val() };
      chatCache.set(id, fresh);
      if (state.chat?.id === id) Object.assign(state.chat, fresh);
    } else {
      chatCache.delete(id);
      if (state.chat?.id === id) {
        closeChat();
        toast('Чат удалён', '', 'success');
      }
    }
    scheduleRender();
  };
  chatRefs.set(id, { ref, handler });
  ref.on('value', handler, () => {});
}

export function startChatList() {
  stopChatList();
  listRef = db.ref('userChats/' + state.me.uid);
  listHandler = snap => {
    const ids = Object.keys(snap.val() || {});
    for (const [id, entry] of chatRefs) {
      if (ids.includes(id)) continue;
      entry.ref.off('value', entry.handler);
      chatRefs.delete(id);
      chatCache.delete(id);
      if (state.chat?.id === id) closeChat();
    }
    for (const id of ids) if (!chatRefs.has(id)) watchChat(id);
    scheduleRender();
  };
  listRef.on('value', listHandler);
}

export function stopChatList() {
  listRef?.off('value', listHandler);
  listRef = null;
  for (const entry of chatRefs.values()) entry.ref.off('value', entry.handler);
  chatRefs.clear();
  chatCache.clear();
}

async function renderRequests() {
  const uids = Object.keys(state.requests);
  const users = await Promise.all(uids.map(getUser));
  if (state.tab !== 'requests') return;
  const list = clear($('chats-list'));
  if (!uids.length) {
    list.append(h('div', { class: 'note', text: 'Нет запросов в друзья' }));
    return;
  }
  uids.forEach((uid, i) => {
    const user = users[i];
    list.append(h('div', { class: 'chat-item' },
      avatar(user),
      h('div', { class: 'chat-info' },
        h('div', { class: 'chat-name', text: user.name }),
        h('div', { class: 'chat-preview', text: '@' + user.nick + ' хочет добавить вас' })),
      h('div', { class: 'chat-meta' },
        h('button', { class: 'btn btn-primary small-btn', 'data-act': 'acceptRequest', 'data-arg': uid, text: 'Принять' }),
        h('button', { class: 'btn btn-secondary small-btn', 'data-act': 'rejectRequest', 'data-arg': uid, text: 'Отклонить' }))));
  });
}

export function startRequests() {
  stopRequests();
  requestsRef = db.ref('friendRequests/' + state.me.uid);
  requestsHandler = snap => {
    state.requests = snap.val() || {};
    const count = Object.keys(state.requests).length;
    $('requests-tab').textContent = 'Запросы' + (count ? ' (' + count + ')' : '');
    if (state.tab === 'requests') renderRequests();
  };
  requestsRef.on('value', requestsHandler, () => {});
}

export function stopRequests() {
  requestsRef?.off('value', requestsHandler);
  requestsRef = null;
  state.requests = {};
}

export function updatePanels() {
  const moments = state.tab === 'moments';
  $('moments-view').classList.toggle('hidden', !moments);
  $('chat-view').classList.toggle('hidden', moments || !state.chat);
  $('empty-state').classList.toggle('hidden', moments || !!state.chat);
  $('sidebar').classList.toggle('hidden-mobile', isMobile() && (moments || !!state.chat));
}

export function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.sidebar-tab').forEach(el => el.classList.toggle('active', el.dataset.arg === tab));
  clear($('chats-list'));
  updatePanels();
  if (tab === 'chats') renderChatList();
  else if (tab === 'requests') renderRequests();
  else loadMoments();
}

function updateStatus(online) {
  const chat = state.chat;
  if (!chat) return;
  const el = $('chat-status');
  const lock = state.encrypted ? ' · 🔒 шифрование' : ' · 🔓 без шифрования';
  if (chat.type === 'dm') {
    el.textContent = (online ? 'онлайн' : 'не в сети') + lock;
    el.className = 'chat-header-status' + (online ? ' online' : '');
    return;
  }
  const count = Object.keys(chat.members || {}).length;
  el.textContent = (chat.type === 'channel' ? '📢 ' + count + ' подписчиков' : '👥 ' + count + ' участников') + (chat.type === 'group' ? lock : '');
  el.className = 'chat-header-status';
}

function stopOnline() {
  onlineRef?.off('value', onlineHandler);
  onlineRef = null;
}

export async function openChat(id) {
  if (state.tab !== 'chats') setTab('chats');
  const snap = await db.ref('chats/' + id).once('value');
  if (!snap.exists()) return;
  stopMessages();
  stopOnline();
  resetComposer();
  const chat = { id, ...snap.val() };
  state.chat = chat;
  db.ref('chats/' + id + '/unread/' + state.me.uid).set(0);
  const [info, resolved] = await Promise.all([displayInfo(chat), resolveMode(chat)]);
  if (state.chat !== chat) return;
  state.encrypted = resolved.mode === 'enc';
  const av = $('chat-avatar');
  av.className = 'avatar small ' + (chat.type === 'dm' ? '' : chat.type);
  av.style.background = info.color;
  av.textContent = info.initials;
  $('chat-name').textContent = info.name;
  const dm = chat.type === 'dm';
  $('call-audio-btn').classList.toggle('hidden', !dm);
  $('call-video-btn').classList.toggle('hidden', !dm);
  $('input-area').classList.toggle('hidden', chat.type === 'channel' && chat.ownerId !== state.me.uid);
  updateStatus(false);
  if (dm && info.uid) {
    onlineRef = db.ref('users/' + info.uid + '/online');
    onlineHandler = s => updateStatus(!!s.val());
    onlineRef.on('value', onlineHandler);
  }
  updatePanels();
  startMessages();
  scheduleRender();
}

export function closeChat() {
  stopMessages();
  stopOnline();
  state.chat = null;
  state.encrypted = false;
  updatePanels();
  scheduleRender();
}

export function goBack() {
  if (state.tab === 'moments') setTab('chats');
  else closeChat();
}
