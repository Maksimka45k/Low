import { db, TS } from './firebase.js';
import { state } from './state.js';
import { LIMITS } from './config.js';
import { $, h, clear, toast, hideModal } from './util.js';
import { uploadFile, safeMediaUrl, openMediaModal } from './media.js';

const TYPES = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm))$/;

function momentNode(moment) {
  const kind = moment.type === 'video' ? 'video' : 'image';
  const media = kind === 'image'
    ? h('img', { src: moment.url, loading: 'lazy', alt: '' })
    : h('video', { src: moment.url, muted: true, preload: 'metadata' });
  return h('div', { class: 'moment-preview', onclick: () => openMediaModal(moment.url, kind) },
    h('div', { class: 'moment-item' }, media),
    h('div', { class: 'moment-name', text: '@' + moment.userNick }));
}

export async function loadMoments() {
  const grid = clear($('moments-grid'));
  grid.append(h('div', { class: 'note big', text: 'Загрузка моментов...' }));
  try {
    const snap = await db.ref('moments').orderByChild('expiresAt').startAt(Date.now()).once('value');
    const items = [];
    snap.forEach(child => {
      const moment = child.val();
      const url = safeMediaUrl(moment?.url);
      if (url) items.push({ ...moment, url });
    });
    if (state.tab !== 'moments') return;
    clear(grid);
    if (!items.length) {
      grid.append(h('div', { class: 'note big', text: 'Пока никто не выложил моменты' }));
      return;
    }
    items.reverse().forEach(moment => grid.append(momentNode(moment)));
  } catch {
    clear(grid).append(h('div', { class: 'note big', text: 'Не удалось загрузить моменты' }));
  }
}

export async function uploadMoment() {
  const input = $('moment-file');
  const error = $('moment-error');
  const file = input.files[0];
  error.textContent = '';
  if (!file) { error.textContent = 'Выберите фото или видео'; return; }
  if (!TYPES.test(file.type)) { error.textContent = 'Неподдерживаемый формат'; return; }
  if (file.size > LIMITS.momentFile) { error.textContent = 'Файл слишком большой'; return; }
  const button = $('moment-submit');
  button.textContent = 'Загрузка...';
  button.disabled = true;
  try {
    const url = await uploadFile(file, false);
    await db.ref('moments').push({
      userId: state.me.uid,
      userNick: state.me.nick,
      userName: state.me.name,
      url,
      type: file.type.startsWith('image/') ? 'image' : 'video',
      createdAt: TS,
      expiresAt: Date.now() + Number($('moment-expire').value) * 1000
    });
    hideModal('moment-modal');
    input.value = '';
    toast('Готово', 'Момент опубликован', 'success');
    if (state.tab === 'moments') loadMoments();
  } catch (e) {
    error.textContent = e.message || 'Не удалось загрузить';
  } finally {
    button.textContent = 'Опубликовать';
    button.disabled = false;
  }
}
