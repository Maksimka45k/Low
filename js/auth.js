import { auth, db, TS, EmailAuthProvider } from './firebase.js';
import { state } from './state.js';
import { $, h, showModal, hideModal, colorFromNick, resetUserCache } from './util.js';
import { unlockKeys, restoreKeys, forgetKeys, resetCrypto } from './crypto.js';

const DOMAIN = '@low.local';
const BAD_LOGIN = ['auth/wrong-password', 'auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-login-credentials'];

let hooks = null;
let unlockResolver = null;

export function switchAuthTab(tab) {
  const tabs = document.querySelectorAll('#auth .tabs .tab');
  tabs[0].classList.toggle('active', tab === 'login');
  tabs[1].classList.toggle('active', tab === 'register');
  $('login-form').classList.toggle('hidden', tab !== 'login');
  $('register-form').classList.toggle('hidden', tab !== 'register');
}

export async function handleLogin() {
  const nick = $('login-nick').value.trim().toLowerCase();
  const password = $('login-password').value;
  const error = $('login-error');
  error.textContent = '';
  if (!nick || !password) { error.textContent = 'Заполните поля'; return; }
  state.pendingPassword = password;
  try {
    await auth.signInWithEmailAndPassword(nick + DOMAIN, password);
  } catch (e) {
    state.pendingPassword = null;
    if (BAD_LOGIN.includes(e.code)) error.textContent = 'Неверный никнейм или пароль';
    else if (e.code === 'auth/too-many-requests') error.textContent = 'Слишком много попыток, попробуйте позже';
    else error.textContent = 'Ошибка: ' + e.message;
  }
}

export async function handleRegister() {
  const name = $('register-name').value.trim();
  const nick = $('register-nick').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  const password = $('register-password').value;
  const error = $('register-error');
  error.textContent = '';
  if (!name || !nick || !password) { error.textContent = 'Заполните поля'; return; }
  if (nick.length < 3) { error.textContent = 'Никнейм минимум 3 символа'; return; }
  if (password.length < 6) { error.textContent = 'Пароль минимум 6 символов'; return; }
  state.registering = true;
  state.pendingPassword = password;
  let cred = null;
  try {
    cred = await auth.createUserWithEmailAndPassword(nick + DOMAIN, password);
    try {
      await db.ref('nickToUid/' + nick).set(cred.user.uid);
    } catch {
      await cred.user.delete();
      cred = null;
      throw new Error('Никнейм занят');
    }
    await db.ref('users/' + cred.user.uid).set({
      uid: cred.user.uid, nick, name, color: colorFromNick(nick), status: '', createdAt: TS
    });
    state.registering = false;
    await startSession(cred.user);
  } catch (e) {
    state.registering = false;
    state.pendingPassword = null;
    error.textContent = e.code === 'auth/email-already-in-use' ? 'Никнейм занят' : e.message;
  }
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
  } catch {
    $('unlock-error').textContent = 'Неверный пароль';
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

function showFatal() {
  const box = $('loading');
  box.classList.remove('hidden');
  box.replaceChildren(h('div', { class: 'fatal' },
    h('div', { text: 'Ошибка доступа к базе данных. Проверьте правила Firebase.' }),
    h('button', { class: 'btn btn-primary mt16', text: 'Перезагрузить', onclick: () => location.reload() })));
}

async function startSession(user) {
  let snap;
  try {
    snap = await db.ref('users/' + user.uid).once('value');
  } catch {
    showFatal();
    return;
  }
  if (!snap.exists()) {
    await auth.signOut();
    return;
  }
  state.me = { ...snap.val(), uid: user.uid };
  if (!(await ensureKeys(user))) return;
  state.pendingPassword = null;
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  hooks.onReady();
}

function teardown() {
  hooks.onLogout();
  resetCrypto();
  resetUserCache();
  Object.assign(state, { me: null, chat: null, tab: 'chats', search: '', pendingPassword: null });
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
