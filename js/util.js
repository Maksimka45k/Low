import { db } from './firebase.js';

export const COLORS = ['#6c5ce7', '#00d68f', '#f7c948', '#ff4d6d', '#339af0', '#b197fc', '#ff922b'];

export const $ = id => document.getElementById(id);

export function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

export const clear = node => {
  node.replaceChildren();
  return node;
};

export const isMobile = () => window.innerWidth <= 768;

export const initials = name =>
  String(name || '?').trim().split(/\s+/).map(w => Array.from(w)[0] || '').join('').toUpperCase().slice(0, 2) || '?';

export const colorFromNick = nick =>
  COLORS[nick ? Array.from(String(nick)).reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length : 0];

export const safeColor = (color, fallback = '#888888') => (/^#[0-9a-f]{6}$/i.test(color) ? color : fallback);

export const userColor = user => safeColor(user?.color, colorFromNick(user?.nick));

export const formatTime = ts =>
  new Date(typeof ts === 'number' ? ts : Date.now()).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

export const getCurrentTime = () => formatTime(Date.now());

export const avatar = (user, cls = 'avatar') =>
  h('div', { class: cls, style: { background: userColor(user) }, text: initials(user?.name) });

export function toast(title, message = '', type = '') {
  const el = $('toast');
  $('toast-title').textContent = title;
  $('toast-message').textContent = message;
  el.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(el.timer);
  el.timer = setTimeout(() => { el.className = ''; }, 3000);
}

export const showModal = id => $(id).classList.remove('hidden');
export const hideModal = id => $(id).classList.add('hidden');

const UID = /^[\w-]{10,40}$/;
export const validUid = uid => typeof uid === 'string' && UID.test(uid);

const userCache = new Map();
const unknownUser = { name: '?', nick: '?', color: '#888888' };

export function getUser(uid) {
  if (!validUid(uid)) return Promise.resolve(unknownUser);
  if (!userCache.has(uid)) {
    userCache.set(uid, db.ref('users/' + uid).once('value').then(
      snap => snap.val() || unknownUser,
      () => { userCache.delete(uid); return unknownUser; }
    ));
  }
  return userCache.get(uid);
}

export const forgetUser = uid => userCache.delete(uid);
export const resetUserCache = () => userCache.clear();

export function linkify(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s]+/gi)) {
    out.push(text.slice(last, match.index));
    const raw = match[0];
    let href = null;
    try {
      const url = new URL(raw.startsWith('www.') ? 'https://' + raw : raw);
      if (url.protocol === 'https:' || url.protocol === 'http:') href = url.href;
    } catch {
      href = null;
    }
    out.push(href ? h('a', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer', text: raw }) : raw);
    last = match.index + raw.length;
  }
  out.push(text.slice(last));
  return out;
}
