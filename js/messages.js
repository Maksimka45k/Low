import { db, TS } from './firebase.js';
import { state } from './state.js';
import { LIMITS } from './config.js';
import { $, h, clear, avatar, getUser, linkify, toast, formatTime, getCurrentTime } from './util.js';
import { chatKey, hasKeys, encryptJson, decryptJson, encryptFile, messageAad } from './crypto.js';
import { uploadFile, attachmentNode } from './media.js';

let query = null;
let handlers = null;

export const otherUid = chat => Object.keys(chat.participants || {}).find(uid => uid !== state.me.uid);

export async function resolveMode(chat) {
  if (chat.type === 'channel') return { mode: 'plain' };
  if (chat.type === 'dm') {
    const other = otherUid(chat);
    if (!other || !(await hasKeys(other))) return { mode: 'plain' };
  } else if (!chat.keys) {
    return { mode: 'plain' };
  }
  const key = await chatKey(chat);
  return key ? { mode: 'enc', key } : { mode: 'blocked' };
}

export function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

export function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function scrollBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function findNode(id) {
  return $('messages').querySelector('[data-id="' + CSS.escape(id) + '"]');
}

async function decode(chat, msg) {
  if (msg.v !== 2) return { text: msg.text || '', file: msg.file || null, replyTo: msg.replyTo || null };
  const key = await chatKey(chat);
  const data = key && msg.enc ? await decryptJson(key, msg.enc, messageAad(chat.id, msg.from)) : null;
  return data || { text: '🔒 не удалось расшифровать', failed: true };
}

async function replyNode(reply) {
  const user = await getUser(reply.from);
  return h('div', { class: 'reply-to', onclick: () => jumpTo(reply.id) },
    h('div', { class: 'reply-to-title', text: 'В ответ ' + user.name }),
    h('div', { class: 'reply-to-text', text: String(reply.text || '') }));
}

async function buildNode(chat, msg, payload) {
  const isMe = msg.from === state.me.uid;
  const user = isMe ? state.me : await getUser(msg.from);
  const bubble = h('div', { class: 'message-bubble' });
  if (!isMe && chat.type !== 'dm') bubble.append(h('div', { class: 'message-sender', text: user.name }));
  if (payload.replyTo) bubble.append(await replyNode(payload.replyTo));
  if (payload.text) bubble.append(h('div', { class: 'message-text' }, linkify(String(payload.text))));
  if (payload.file?.url) bubble.append(attachmentNode(payload.file));
  if (msg.edited) bubble.append(h('span', { class: 'edited-mark', text: '(изменено)' }));
  bubble.append(h('div', { class: 'message-time', text: formatTime(msg.at) + (isMe ? ' ✓✓' : '') }));
  return h('div', {
    class: 'message-wrapper ' + (isMe ? 'out' : 'in'),
    'data-id': msg.id,
    'data-at': String(msg.at || 0),
    oncontextmenu: e => { e.preventDefault(); showContextMenu(e, msg.id); }
  }, isMe ? null : avatar(user, 'message-avatar'), h('div', {}, bubble), isMe ? avatar(state.me, 'message-avatar') : null);
}

async function addMessage(chat, msg, live) {
  if (state.chat !== chat || findNode(msg.id)) return;
  const payload = await decode(chat, msg);
  const node = await buildNode(chat, msg, payload);
  if (state.chat !== chat || findNode(msg.id)) return;
  state.messages.set(msg.id, { msg, payload });
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  let before = null;
  for (let i = box.children.length - 1; i >= 0; i--) {
    const at = box.children[i].dataset.at;
    if (at && Number(at) > msg.at) before = box.children[i];
    else break;
  }
  box.insertBefore(node, before);
  if (live && (msg.from === state.me.uid || nearBottom)) scrollBottom();
  if (live && msg.from !== state.me.uid && document.visibilityState === 'visible') {
    db.ref('chats/' + chat.id + '/unread/' + state.me.uid).set(0);
  }
}

async function updateMessage(chat, msg) {
  const old = findNode(msg.id);
  if (state.chat !== chat || !old) return;
  const payload = await decode(chat, msg);
  const node = await buildNode(chat, msg, payload);
  state.messages.set(msg.id, { msg, payload });
  old.replaceWith(node);
}

function removeMessage(id) {
  findNode(id)?.remove();
  state.messages.delete(id);
}

export function jumpTo(id) {
  const el = findNode(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1000);
}

export function stopMessages() {
  if (query && handlers) {
    query.off('child_added', handlers.added);
    query.off('child_changed', handlers.changed);
    query.off('child_removed', handlers.removed);
  }
  query = null;
  handlers = null;
  state.messages.clear();
}

export function startMessages() {
  stopMessages();
  const chat = state.chat;
  clear($('messages'));
  query = db.ref('messages/' + chat.id).orderByChild('at').limitToLast(LIMITS.page);
  let chain = Promise.resolve();
  let ready = false;
  const enqueue = fn => { chain = chain.then(fn).catch(console.error); };
  const item = snap => ({ id: snap.key, ...snap.val() });
  handlers = {
    added: snap => enqueue(() => addMessage(chat, item(snap), ready)),
    changed: snap => enqueue(() => updateMessage(chat, item(snap))),
    removed: snap => enqueue(() => removeMessage(snap.key))
  };
  const fail = err => console.warn(err.message);
  query.on('child_added', handlers.added, fail);
  query.on('child_changed', handlers.changed, fail);
  query.on('child_removed', handlers.removed, fail);
  query.once('value', snap => enqueue(() => {
    ready = true;
    scrollBottom();
    if (snap.numChildren() >= LIMITS.page) addOlderButton(chat);
  }), fail);
}

function addOlderButton(chat) {
  $('messages').prepend(h('button', {
    class: 'btn btn-secondary load-older', 'data-older': '1', text: 'Загрузить ранее',
    onclick: e => loadOlder(chat, e.currentTarget)
  }));
}

async function loadOlder(chat, button) {
  const first = $('messages').querySelector('.message-wrapper');
  if (!first) return;
  button.disabled = true;
  const snap = await db.ref('messages/' + chat.id).orderByChild('at').endAt(Number(first.dataset.at) - 1).limitToLast(LIMITS.page).once('value');
  const items = [];
  snap.forEach(child => { items.push({ id: child.key, ...child.val() }); });
  const box = $('messages');
  const before = box.scrollHeight;
  for (const msg of items) await addMessage(chat, msg, false);
  box.scrollTop += box.scrollHeight - before;
  if (items.length < LIMITS.page) button.remove();
  else button.disabled = false;
}

function hideContextMenu() {
  $('context-menu').classList.remove('show');
}

export { hideContextMenu };

function showContextMenu(e, id) {
  const entry = state.messages.get(id);
  if (!entry) return;
  const { msg, payload } = entry;
  const mine = msg.from === state.me.uid;
  const items = [{ icon: '↩️', label: 'Ответить', run: () => setReply(entry) }];
  if (mine && payload.text && !payload.failed) items.push({ icon: '✎', label: 'Редактировать', run: () => startEditing(entry) });
  if (payload.text) items.push({ icon: '📋', label: 'Копировать', run: () => copyText(payload.text) });
  if (mine) items.push({ icon: '🗑', label: 'Удалить', danger: true, run: () => db.ref('messages/' + state.chat.id + '/' + id).remove() });
  const menu = clear($('context-menu'));
  for (const it of items) {
    menu.append(h('div', { class: 'context-item' + (it.danger ? ' danger' : ''), text: it.icon + ' ' + it.label, onclick: () => { it.run(); hideContextMenu(); } }));
  }
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 160) + 'px';
  menu.classList.add('show');
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Скопировано', '', 'success'), () => {});
}

async function setReply({ msg, payload }) {
  state.editing = null;
  state.replyTo = { id: msg.id, from: msg.from, text: String(payload.text || (payload.file ? '📎 ' + (payload.file.name || 'файл') : '')).slice(0, 120) };
  const box = $('reply-preview');
  const user = await getUser(msg.from);
  clear(box).append(h('div', { class: 'reply-preview-content' },
    h('span', { class: 'reply-preview-close', 'data-act': 'cancelReply', text: '✕' }),
    h('div', { class: 'reply-preview-title', text: 'Ответ ' + user.name }),
    h('div', { class: 'reply-preview-text', text: state.replyTo.text })));
  box.classList.remove('hidden');
}

export function cancelReply() {
  state.replyTo = null;
  clear($('reply-preview')).classList.add('hidden');
}

function startEditing(entry) {
  cancelReply();
  state.editing = entry;
  const input = $('message-input');
  input.value = entry.payload.text;
  input.focus();
  autoResize(input);
  $('cancel-edit-btn').classList.remove('hidden');
  $('send-btn').textContent = '✔';
}

export function cancelEditing() {
  state.editing = null;
  const input = $('message-input');
  input.value = '';
  autoResize(input);
  $('cancel-edit-btn').classList.add('hidden');
  $('send-btn').textContent = '➤';
}

export function resetFile() {
  if (state.filePreviewUrl) URL.revokeObjectURL(state.filePreviewUrl);
  state.filePreviewUrl = null;
  state.file = null;
  clear($('file-preview')).classList.add('hidden');
  $('file-input').value = '';
}

export function selectFile(file) {
  resetFile();
  if (!file) return;
  state.file = file;
  const box = $('file-preview');
  if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
    state.filePreviewUrl = URL.createObjectURL(file);
    box.append(h('img', { src: state.filePreviewUrl, alt: '' }));
  }
  box.append(
    h('div', {}, h('div', { class: 'file-preview-title', text: file.name }), h('div', { text: (file.size / 1048576).toFixed(2) + ' MB' })),
    h('span', { class: 'file-preview-remove', 'data-act': 'removeFile', text: '✕' })
  );
  box.classList.remove('hidden');
}

export function resetComposer() {
  cancelReply();
  resetFile();
  if (state.editing) cancelEditing();
  const input = $('message-input');
  input.value = '';
  autoResize(input);
}

async function uploadAttachment(file, encrypted) {
  const limit = encrypted ? LIMITS.encryptedFile : LIMITS.plainFile;
  if (file.size > limit) throw new Error('Файл больше ' + limit / 1048576 + ' MB');
  const permanent = !$('temp-file-checkbox').checked;
  const meta = { name: file.name.slice(0, 120), size: file.size, type: file.type };
  if (encrypted) {
    const { blob, enc } = await encryptFile(file);
    meta.url = await uploadFile(new File([blob], 'data.bin'), permanent);
    meta.enc = enc;
  } else {
    meta.url = await uploadFile(file, permanent);
  }
  return meta;
}

async function touchChat(chat, mode, payload) {
  let preview = '🔒 Сообщение';
  if (mode !== 'enc') {
    const text = payload.text ? payload.text.slice(0, 45) + (payload.text.length > 45 ? '...' : '') : '📎 ' + (payload.file?.name || 'файл');
    preview = state.me.name + ': ' + text;
  }
  await db.ref('chats/' + chat.id).update({ lastMsg: preview, lastMsgTime: getCurrentTime(), lastAt: TS });
  for (const uid of Object.keys(chat.participants || chat.members || {})) {
    if (uid !== state.me.uid) db.ref('chats/' + chat.id + '/unread/' + uid).transaction(v => (v || 0) + 1);
  }
}

async function commitEdit(chat, text) {
  const entry = state.editing;
  cancelEditing();
  if (!text) return;
  const update = { edited: true, editedAt: TS };
  if (entry.msg.v === 2) {
    const key = await chatKey(chat);
    if (!key) {
      toast('Ошибка', 'Нет ключа шифрования', 'error');
      return;
    }
    const { failed, ...clean } = entry.payload;
    update.enc = await encryptJson(key, { ...clean, text }, messageAad(chat.id, state.me.uid));
  } else {
    update.text = text;
  }
  await db.ref('messages/' + chat.id + '/' + entry.msg.id).update(update);
}

function setSending(on) {
  state.sending = on;
  $('send-btn').disabled = on;
  if (!state.editing) $('send-btn').textContent = on ? '⏳' : '➤';
}

export async function sendMessage() {
  const chat = state.chat;
  if (!chat || state.sending) return;
  const input = $('message-input');
  const text = input.value.trim();
  setSending(true);
  try {
    if (state.editing) {
      await commitEdit(chat, text);
      return;
    }
    if (!text && !state.file) return;
    const { mode, key } = await resolveMode(chat);
    if (mode === 'blocked') {
      toast('Шифрование', 'Ключи не загружены. Войдите заново.', 'error');
      return;
    }
    const payload = {};
    if (text) payload.text = text;
    if (state.replyTo) payload.replyTo = { ...state.replyTo };
    if (state.file) payload.file = await uploadAttachment(state.file, mode === 'enc');
    const msg = { from: state.me.uid, at: TS };
    if (mode === 'enc') {
      msg.v = 2;
      msg.enc = await encryptJson(key, payload, messageAad(chat.id, state.me.uid));
    } else {
      Object.assign(msg, payload);
    }
    await db.ref('messages/' + chat.id).push(msg);
    input.value = '';
    autoResize(input);
    cancelReply();
    resetFile();
    await touchChat(chat, mode, payload);
  } catch (e) {
    toast('Ошибка', e.message || 'Не удалось отправить', 'error');
  } finally {
    setSending(false);
  }
}
