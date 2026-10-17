import { db } from './firebase.js';
import { state } from './state.js';

const te = new TextEncoder();
const td = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const AES = { name: 'AES-GCM', length: 256 };
const SAFE_TYPES = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|ogg)|audio\/(mpeg|ogg|wav|webm|mp4|aac|x-m4a)|application\/pdf|text\/plain)$/;

const rand = n => crypto.getRandomValues(new Uint8Array(n));

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function openStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('low-keys', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const database = await openStore();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('keys', mode);
    const req = fn(tx.objectStore('keys'));
    tx.oncomplete = () => { database.close(); resolve(req.result); };
    tx.onerror = () => { database.close(); reject(tx.error); };
  });
}

const loadStored = uid => withStore('readonly', s => s.get(uid)).catch(() => null);
const saveStored = (uid, key) => withStore('readwrite', s => s.put(key, uid)).catch(() => {});
export const forgetKeys = uid => withStore('readwrite', s => s.delete(uid)).catch(() => {});

const importPrivate = jwk => crypto.subtle.importKey('jwk', jwk, ECDH, false, ['deriveKey']);

async function passwordKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, base, AES, false, ['encrypt', 'decrypt']);
}

async function createKeys(uid, password) {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const salt = rand(16);
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passwordKey(password, salt), te.encode(JSON.stringify(priv)));
  await db.ref('keyBackups/' + uid).set({ salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) });
  await db.ref('users/' + uid + '/pubKey').set(pub);
  return importPrivate(priv);
}

export async function unlockKeys(uid, password) {
  const [backup, pub] = await Promise.all([
    db.ref('keyBackups/' + uid).once('value'),
    db.ref('users/' + uid + '/pubKey').once('value')
  ]);
  let key;
  if (backup.exists() && pub.exists()) {
    const b = backup.val();
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(b.iv) }, await passwordKey(password, fromB64(b.salt)), fromB64(b.ct));
    key = await importPrivate(JSON.parse(td.decode(raw)));
  } else {
    key = await createKeys(uid, password);
  }
  await saveStored(uid, key);
  state.privKey = key;
  state.me.pubKey = (await db.ref('users/' + uid + '/pubKey').once('value')).val();
  return key;
}

export async function restoreKeys(uid) {
  state.privKey = await loadStored(uid);
  return !!state.privKey;
}

const peerKeys = new Map();
const sharedKeys = new Map();
const chatKeys = new Map();

export function resetCrypto() {
  peerKeys.clear();
  sharedKeys.clear();
  chatKeys.clear();
  state.privKey = null;
}

async function peerPublic(uid) {
  if (peerKeys.has(uid)) return peerKeys.get(uid);
  const snap = await db.ref('users/' + uid + '/pubKey').once('value');
  if (!snap.exists()) return null;
  const key = await crypto.subtle.importKey('jwk', snap.val(), ECDH, false, []);
  peerKeys.set(uid, key);
  return key;
}

export const hasKeys = async uid => !!(await peerPublic(uid));

async function sharedKey(uid) {
  if (!state.privKey) return null;
  if (sharedKeys.has(uid)) return sharedKeys.get(uid);
  const pub = await peerPublic(uid);
  if (!pub) return null;
  const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, state.privKey, AES, false, ['encrypt', 'decrypt']);
  sharedKeys.set(uid, key);
  return key;
}

export async function chatKey(chat) {
  if (!chat || chat.type === 'channel') return null;
  if (chatKeys.has(chat.id)) return chatKeys.get(chat.id);
  let key = null;
  if (chat.type === 'dm') {
    const other = Object.keys(chat.participants || {}).find(uid => uid !== state.me.uid);
    key = other ? await sharedKey(other) : null;
  } else {
    const wrapped = chat.keys?.[state.me.uid];
    const wrapper = wrapped ? await sharedKey(wrapped.from) : null;
    if (wrapper) {
      const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(wrapped.iv) }, wrapper, fromB64(wrapped.ct));
      key = await crypto.subtle.importKey('raw', raw, AES, true, ['encrypt', 'decrypt']);
    }
  }
  if (key) chatKeys.set(chat.id, key);
  return key;
}

export const cacheChatKey = (chatId, key) => chatKeys.set(chatId, key);

async function wrap(key, uid) {
  const wrapper = await sharedKey(uid);
  if (!wrapper) throw new Error('У пользователя нет ключей шифрования');
  const iv = rand(12);
  const raw = await crypto.subtle.exportKey('raw', key);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapper, raw);
  return { from: state.me.uid, iv: toB64(iv), ct: toB64(ct) };
}

export async function createGroupKeys(uids) {
  const key = await crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt']);
  const keys = {};
  for (const uid of uids) keys[uid] = await wrap(key, uid);
  return { key, keys };
}

export async function wrapGroupKeyFor(chat, uid) {
  const key = await chatKey(chat);
  if (!key) throw new Error('Нет ключа группы');
  return wrap(key, uid);
}

export const messageAad = (chatId, from) => chatId + '|' + from;

export async function encryptJson(key, obj, aad) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, te.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJson(key, box, aad) {
  try {
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv), additionalData: te.encode(aad) }, key, fromB64(box.ct));
    return JSON.parse(td.decode(raw));
  } catch {
    return null;
  }
}

export async function encryptFile(file) {
  const key = await crypto.subtle.generateKey(AES, true, ['encrypt']);
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer());
  return {
    blob: new Blob([ct], { type: 'application/octet-stream' }),
    enc: { key: toB64(await crypto.subtle.exportKey('raw', key)), iv: toB64(iv) }
  };
}

export async function decryptFile(url, enc, type) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Файл недоступен');
  const key = await crypto.subtle.importKey('raw', fromB64(enc.key), AES, false, ['decrypt']);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(enc.iv) }, key, await res.arrayBuffer());
  return new Blob([raw], { type: SAFE_TYPES.test(type) ? type : 'application/octet-stream' });
}

export async function safetyNumber(otherUid) {
  const read = async uid => {
    const snap = await db.ref('users/' + uid + '/pubKey').once('value');
    const k = snap.val();
    return k ? k.x + k.y : '';
  };
  const [mine, theirs] = await Promise.all([read(state.me.uid), read(otherUid)]);
  const joined = state.me.uid < otherUid ? mine + theirs : theirs + mine;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(joined)));
  return Array.from(digest.slice(0, 15), x => x.toString(16).padStart(2, '0')).join('').match(/.{1,5}/g).join(' ');
}
