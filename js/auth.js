import { auth, db, TS, EmailAuthProvider } from './firebase.js';
import { state } from './state.js';
import { $, showModal, hideModal, colorFromNick, resetUserCache } from './util.js';
import { unlockKeys, restoreKeys, forgetKeys, resetCrypto, cryptoAvailable } from './crypto.js';

const DOMAIN = '@low.local';
const BAD_LOGIN = ['auth/wrong-password', 'auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-login-credentials'];
const BAD_UNLOCK = ['auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials'];
const LABELS = { login: ['ВОЙТИ →', 'ВХОД...'], register: ['СОЗДАТЬ →', 'СОЗДАНИЕ...'] };

let hooks = null;
let unlockResolver = null;
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
  try {
    await db.ref('users/' + cred.user.uid).set({
      uid: cred.user.uid, nick, name, color: colorFromNick(nick), status: '', createdAt: TS
    });
  } catch (e) {
    console.warn('profile write failed, will retry on session start', e.message);
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

async function startSession(user) {
  try {
    if (!cryptoAvailable) throw new Error('Шифрование недоступно: откройте сайт по https://');
    const snap = await db.ref('users/' + user.uid).once('value');
    state.me = snap.exists() ? { ...snap.val(), uid: user.uid } : await repairProfile(user);
    if (!(await ensureKeys(user))) return;
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

export function initAuth(callbacks) {
  hooks = callbacks;
  auth.onAuthStateChanged(async user => {
    $('loading').classList.add('hidden');
    if (state.registering) return;
    if (user) await startSession(user);
    else teardown();
  });
}
