import { auth, db, TS, EmailAuthProvider, prepareAuthStorage } from './firebase.js';
import { state } from './state.js';
import { $, showModal, hideModal, colorFromNick, resetUserCache } from './util.js';
import { SUPPORT_URL } from './config.js';
import { unlockKeys, restoreKeys, forgetKeys, resetCrypto, cryptoAvailable } from './crypto.js';

const DOMAIN = '@low.local';
const BAD_LOGIN = ['auth/wrong-password', 'auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-login-credentials'];
const BAD_UNLOCK = ['auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials'];
const LABELS = { login: ['ВОЙТИ →', 'ВХОД...'], register: ['СОЗДАТЬ →', 'СОЗДАНИЕ...'] };
const TOS_VERSION = '2026-11-23';
const TOS_ERROR = 'Для продолжения нужно принять Пользовательское соглашение';
const tosAccepted = form => $(form + '-tos').checked;

let hooks = null;
let unlockResolver = null;
let newPwResolver = null;
let changedTo = null;
let busy = false;
let lastForm = 'login';

function setBusy(on, form) {
  busy = on;
  for (const [name, [idle, working]] of Object.entries(LABELS)) {
    const button = document.querySelector('[data-act="' + name + '"]');
    button.disabled = on;
    button.textContent = on && name === form ? working : idle;
  }
}

const showError = text => { $(lastForm + '-error').textContent = text; };

export function switchAuthTab(tab) {
  const tabs = document.querySelectorAll('#auth .tabs .tab');
  tabs[0].classList.toggle('active', tab === 'login');
  tabs[1].classList.toggle('active', tab === 'register');
  $('login-form').classList.toggle('hidden', tab !== 'login');
  $('register-form').classList.toggle('hidden', tab !== 'register');
}

export async function handleLogin() {
  if (busy) return;
  const nick = $('login-nick').value.trim().toLowerCase();
  const password = $('login-password').value;
  lastForm = 'login';
  showError('');
  if (!nick || !password) { showError('Заполните поля'); return; }
  if (!tosAccepted('login')) { showError(TOS_ERROR); return; }
  setBusy(true, 'login');
  state.pendingPassword = password;
  try {
    await auth.signInWithEmailAndPassword(nick + DOMAIN, password);
  } catch (e) {
    state.pendingPassword = null;
    setBusy(false);
    if (BAD_LOGIN.includes(e.code)) showError('Неверный никнейм или пароль');
    else if (e.code === 'auth/too-many-requests') showError('Слишком много попыток, попробуйте позже');
    else showError('Ошибка: ' + e.message);
  }
}

export async function handleRegister() {
  if (busy) return;
  const name = $('register-name').value.trim();
  const nick = $('register-nick').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  const password = $('register-password').value;
  lastForm = 'register';
  showError('');
  if (!name || !nick || !password) { showError('Заполните поля'); return; }
  if (nick.length < 3) { showError('Никнейм минимум 3 символа'); return; }
  if (password.length < 6) { showError('Пароль минимум 6 символов'); return; }
  if (!tosAccepted('register')) { showError(TOS_ERROR); return; }
  setBusy(true, 'register');
  state.registering = true;
  state.pendingPassword = password;
  const fail = text => {
    state.registering = false;
    state.pendingPassword = null;
    setBusy(false);
    showError(text);
  };
  let cred;
  try {
    cred = await auth.createUserWithEmailAndPassword(nick + DOMAIN, password);
  } catch (e) {
    fail(e.code === 'auth/email-already-in-use' ? 'Никнейм занят' : 'Ошибка: ' + e.message);
    return;
  }
  try {
    await db.ref('nickToUid/' + nick).set(cred.user.uid);
  } catch (e) {
    await cred.user.delete().catch(() => {});
    fail(e.code === 'PERMISSION_DENIED' ? 'Никнейм занят' : 'Ошибка: ' + e.message);
    return;
  }
  const profile = { uid: cred.user.uid, nick, name, color: colorFromNick(nick), status: '', createdAt: TS };
  try {
    // фиксируем факт и версию согласия; если правила БД не пускают новые поля — пишем профиль без них
    await db.ref('users/' + cred.user.uid).set({ ...profile, tosVersion: TOS_VERSION, tosAcceptedAt: TS });
  } catch {
    try {
      await db.ref('users/' + cred.user.uid).set(profile);
    } catch (e) {
      console.warn('profile write failed, will retry on session start', e.message);
    }
  }
  state.registering = false;
  await startSession(cred.user);
}

function askUnlock() {
  $('unlock-error').textContent = '';
  $('unlock-password').value = '';
  showModal('unlock-modal');
  return new Promise(resolve => { unlockResolver = resolve; });
}

export async function submitUnlock() {
  const password = $('unlock-password').value;
  const user = auth.currentUser;
  if (!password || !user) return;
  try {
    await user.reauthenticateWithCredential(EmailAuthProvider.credential(user.email, password));
    await unlockKeys(user.uid, password);
    hideModal('unlock-modal');
    unlockResolver?.(true);
    unlockResolver = null;
  } catch (e) {
    const wrong = BAD_UNLOCK.includes(e.code) || e.name === 'OperationError';
    $('unlock-error').textContent = (wrong ? 'Неверный пароль' : 'Ошибка: ' + e.message) + ' (' + (e.code || e.name) + ')';
  }
}

export function cancelUnlock() {
  hideModal('unlock-modal');
  unlockResolver?.(false);
  unlockResolver = null;
  auth.signOut();
}

// После сброса пароля админом у аккаунта есть метка pwReset (custom claim). Пока она стоит, пользователь
// обязан задать свой пароль; метку снимает сервер (/finish), и только если пароль действительно сменился.
async function mustChangePassword(user) {
  try { return !!(await user.getIdTokenResult()).claims.pwReset; } catch { return false; }
}

function askNewPassword() {
  $('newpw-1').value = '';
  $('newpw-2').value = '';
  $('newpw-error').textContent = '';
  changedTo = null;
  showModal('newpw-modal');
  return new Promise(resolve => { newPwResolver = resolve; });
}

async function finishReset(user) {
  if (!SUPPORT_URL) throw new Error('сервис восстановления не настроен');
  const res = await fetch(SUPPORT_URL + '/finish', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await user.getIdToken(true) }
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
}

export async function submitNewPassword() {
  const user = auth.currentUser;
  const pw = $('newpw-1').value;
  const fail = text => { $('newpw-error').textContent = text; };
  if (!user) return;
  if (pw.length < 6) return fail('Пароль минимум 6 символов');
  if (pw !== $('newpw-2').value) return fail('Пароли не совпадают');
  if (pw === state.pendingPassword && pw !== changedTo) return fail('Новый пароль должен отличаться от временного');
  try {
    if (changedTo !== pw) {
      await user.updatePassword(pw);
      changedTo = pw;
    }
    await finishReset(user);
  } catch (e) {
    return fail(e.code === 'auth/weak-password' ? 'Слишком простой пароль' : 'Ошибка: ' + e.message + ' — попробуйте ещё раз');
  }
  state.pendingPassword = pw;
  hideModal('newpw-modal');
  newPwResolver?.(true);
  newPwResolver = null;
}

export function cancelNewPassword() {
  hideModal('newpw-modal');
  newPwResolver?.(false);
  newPwResolver = null;
  auth.signOut();
}

async function ensureKeys(user) {
  if ((await restoreKeys(user.uid)) && state.me.pubKey) return true;
  if (state.pendingPassword) {
    try {
      await unlockKeys(user.uid, state.pendingPassword);
      return true;
    } catch (e) {
      console.warn('unlock', e.name);
    }
  }
  return askUnlock();
}

async function repairProfile(user) {
  const nick = String(user.email || '').replace(DOMAIN, '').toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(nick)) throw new Error('Профиль не найден');
  const owner = (await db.ref('nickToUid/' + nick).once('value')).val();
  if (owner && owner !== user.uid) throw new Error('Профиль не найден');
  if (!owner) await db.ref('nickToUid/' + nick).set(user.uid);
  const profile = { uid: user.uid, nick, name: nick, color: colorFromNick(nick), status: '', createdAt: TS };
  await db.ref('users/' + user.uid).set(profile);
  return { ...profile, createdAt: Date.now() };
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

async function startSession(user) {
  try {
    if (!cryptoAvailable) throw new Error('Шифрование недоступно: откройте сайт по https://');
    window.__lowStage = 'profile';
    const snap = await withTimeout(db.ref('users/' + user.uid).once('value'), 12000, 'Нет связи с базой данных. Проверьте интернет, VPN или DNS и попробуйте снова.');
    window.__lowStage = 'keys';
    const ban = (await db.ref('bans/' + user.uid).once('value')).val();
    if (ban && ban.until > Date.now()) throw new Error('Аккаунт заблокирован' + (ban.reason ? ': ' + ban.reason : ''));
    state.me = snap.exists() ? { ...snap.val(), uid: user.uid } : await repairProfile(user);
    if (await mustChangePassword(user) && !(await askNewPassword())) return;
    if (!(await ensureKeys(user))) return;
    window.__lowStage = 'ready';
    state.pendingPassword = null;
    $('auth').classList.add('hidden');
    $('app').classList.remove('hidden');
    hooks.onReady();
  } catch (e) {
    console.error(e);
    state.me = null;
    state.pendingPassword = null;
    showError(e.code === 'PERMISSION_DENIED' ? 'Ошибка доступа к базе. Проверьте правила Firebase.' : e.message);
    await auth.signOut();
  } finally {
    setBusy(false);
  }
}

function teardown() {
  hooks.onLogout();
  resetCrypto();
  resetUserCache();
  Object.assign(state, { me: null, chat: null, tab: 'chats', search: '', pendingPassword: null });
  setBusy(false);
  switchAuthTab('login');
  $('settings').classList.add('hidden');
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  for (const id of ['login-nick', 'login-password', 'register-name', 'register-nick', 'register-password']) $(id).value = '';
  for (const id of ['login-tos', 'register-tos']) $(id).checked = false;
}

export async function logout() {
  const uid = state.me?.uid;
  hooks.onLogout();
  if (uid) {
    await db.ref('users/' + uid + '/online').set(false).catch(() => {});
    await forgetKeys(uid);
  }
  auth.signOut();
}

function recoverFromStall() {
  let reloaded = false;
  try { reloaded = sessionStorage.getItem('low-recovered') === '1'; } catch {}
  if (reloaded) {
    $('loading').classList.add('hidden');
    teardown();
    return;
  }
  try { sessionStorage.setItem('low-recovered', '1'); } catch {}
  const finish = () => location.reload();
  try {
    const req = indexedDB.deleteDatabase('firebaseLocalStorageDb');
    req.onsuccess = finish;
    req.onerror = finish;
    req.onblocked = finish;
  } catch {
    finish();
  }
  setTimeout(finish, 2000);
}

export async function initAuth(callbacks) {
  hooks = callbacks;
  let fired = false;
  setTimeout(() => { if (!fired) recoverFromStall(); }, 6000);
  window.__lowStage = 'prepare';
  await prepareAuthStorage();
  window.__lowStage = 'listen';
  auth.onAuthStateChanged(async user => {
    fired = true;
    window.__lowStage = 'state';
    $('loading').classList.add('hidden');
    if (state.registering) return;
    if (user) await startSession(user);
    else teardown();
  });
}
