import { db } from './firebase.js';
import { state } from './state.js';
import { $, showModal, hideModal, toast } from './util.js';
import { initAuth, switchAuthTab, handleLogin, handleRegister, submitUnlock, cancelUnlock, logout } from './auth.js';
import { startChatList, stopChatList, startRequests, stopRequests, setTab, goBack, closeChat, updatePanels, filterChats } from './chats.js';
import { sendMessage, handleKey, autoResize, selectFile, resetFile, cancelReply, cancelEditing, hideContextMenu } from './messages.js';
import { askDeleteChat, deleteChatSelf, deleteChatBoth, createDM, acceptRequest, rejectRequest, setGroupType, addMember, removeMember, createGroup, invite, leaveGroup, copyChannelLink, joinChannel, showChatInfo } from './contacts.js';
import { startCall, acceptCall, rejectCall, endCall, toggleMute, toggleCamera, toggleScreen, listenForCalls, stopCalls } from './calls.js';
import { uploadMoment } from './moments.js';
import { closeMediaModal } from './media.js';
import {
  toggleSettings, switchSettingsTab, saveProfile, cycleAvatarColor, setAccentColor, setTheme, setFont, setFontSize,
  fillProfile, loadDevices, requestMediaPermissions, testMicrophone, startCameraPreview, requestNotifications
} from './settings.js';

window.__lowVer = 'v5';
window.__lowStage = 'main';

if (location.protocol === 'file:') {
  $('loading').textContent = 'Запустите через локальный сервер';
  throw new Error('file protocol');
}

window.addEventListener('unhandledrejection', e => toast('Ошибка', String(e.reason?.message || e.reason), 'error'));
window.addEventListener('error', e => toast('Ошибка', e.message, 'error'));

const actions = {
  authTab: switchAuthTab,
  login: handleLogin,
  register: handleRegister,
  unlock: submitUnlock,
  unlockLogout: cancelUnlock,
  modal: showModal,
  closeModal: hideModal,
  settings: toggleSettings,
  settingsTab: switchSettingsTab,
  tab: setTab,
  back: goBack,
  audioCall: () => startCall('audio'),
  videoCall: () => startCall('video'),
  chatInfo: showChatInfo,
  pickFile: () => $('file-input').click(),
  send: sendMessage,
  cancelEdit: cancelEditing,
  cancelReply,
  removeFile: resetFile,
  saveProfile,
  logout,
  cycleColor: cycleAvatarColor,
  accent: setAccentColor,
  requestMedia: requestMediaPermissions,
  testMic: testMicrophone,
  camPreview: startCameraPreview,
  notifications: requestNotifications,
  createDM,
  groupType: setGroupType,
  addMember,
  removeMember,
  createGroup,
  acceptRequest,
  rejectRequest,
  invite,
  leaveGroup,
  deleteChat: askDeleteChat,
  deleteSelf: deleteChatSelf,
  deleteBoth: deleteChatBoth,
  copyChannelLink,
  acceptCall,
  rejectCall,
  mute: toggleMute,
  camera: toggleCamera,
  screen: toggleScreen,
  endCall,
  uploadMoment,
  closeMedia: closeMediaModal
};

document.addEventListener('click', e => {
  hideContextMenu();
  const target = e.target.closest('[data-act]');
  const action = target && actions[target.dataset.act];
  if (action) action(target.dataset.arg, target);
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.modal-overlay:not([data-lock])').forEach(m => m.classList.add('hidden'));
  closeMediaModal();
  endCall();
});

document.querySelectorAll('.modal-overlay:not([data-lock])').forEach(el =>
  el.addEventListener('click', e => { if (e.target === el) el.classList.add('hidden'); }));

const onEnter = (id, fn) => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') fn(); });
onEnter('login-nick', handleLogin);
onEnter('login-password', handleLogin);
onEnter('register-password', handleRegister);
onEnter('dm-nick', createDM);
onEnter('member-nick', addMember);
onEnter('unlock-password', submitUnlock);

$('message-input').addEventListener('keydown', handleKey);
$('message-input').addEventListener('input', e => autoResize(e.target));
$('file-input').addEventListener('change', e => selectFile(e.target.files[0]));
$('search-input').addEventListener('input', e => filterChats(e.target.value));
$('dark-theme-toggle').addEventListener('change', e => setTheme(e.target.checked));
$('font-select').addEventListener('change', e => setFont(e.target.value));
$('font-size-range').addEventListener('input', e => setFontSize(e.target.value));
document.querySelectorAll('.color-option').forEach(el => { el.style.background = el.dataset.arg; });
window.addEventListener('resize', updatePanels);

function onReady() {
  fillProfile();
  const online = db.ref('users/' + state.me.uid + '/online');
  online.set(true);
  online.onDisconnect().set(false);
  startChatList();
  startRequests();
  listenForCalls();
  loadDevices();
  setTab('chats');
  const channel = new URLSearchParams(location.search).get('channel');
  if (channel) joinChannel(channel);
}

function onLogout() {
  endCall();
  stopCalls();
  stopChatList();
  stopRequests();
  closeChat();
}

initAuth({ onReady, onLogout });
