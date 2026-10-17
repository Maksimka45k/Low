import { $, h, clear } from './util.js';
import { decryptFile } from './crypto.js';

const HOST = /^https:\/\/(files|litter)\.catbox\.moe\/[\w.\-/]+$/;
const EXT = {
  image: /\.(jpe?g|png|gif|webp|bmp)$/i,
  video: /\.(mp4|webm|ogv|mov)$/i,
  audio: /\.(mp3|wav|ogg|m4a|aac)$/i
};

export const safeMediaUrl = url => (typeof url === 'string' && HOST.test(url) ? url : null);

export async function uploadFile(file, permanent) {
  const form = new FormData();
  let url = 'https://catbox.moe/user/api.php';
  if (!permanent) {
    url = 'https://litterbox.catbox.moe/resources/internals/api.php';
    form.append('time', '72h');
  }
  form.append('reqtype', 'fileupload');
  form.append('userhash', '');
  form.append('fileToUpload', file);
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Загрузка не удалась: ' + res.status);
  const out = (await res.text()).trim();
  if (!safeMediaUrl(out)) throw new Error('Неожиданный ответ сервера');
  return out;
}

export function mediaKind(file) {
  const type = file.type || '';
  const name = file.name || '';
  if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(type) || EXT.image.test(name)) return 'image';
  if (type.startsWith('video/') || EXT.video.test(name)) return 'video';
  if (type.startsWith('audio/') || EXT.audio.test(name)) return 'audio';
  return 'file';
}

export function openMediaModal(src, kind) {
  const box = clear($('media-modal-content'));
  if (kind === 'image') box.append(h('img', { src, alt: '' }));
  else if (kind === 'video') box.append(h('video', { src, controls: true, autoplay: true }));
  else if (kind === 'audio') box.append(h('audio', { src, controls: true }));
  else return;
  $('media-modal').classList.remove('hidden');
}

export function closeMediaModal() {
  $('media-modal').classList.add('hidden');
  clear($('media-modal-content'));
}

function player(kind, src, name) {
  if (kind === 'image') {
    return h('img', {
      class: 'inline-img', src, alt: name, loading: 'lazy',
      onclick: e => { e.stopPropagation(); openMediaModal(src, 'image'); }
    });
  }
  if (kind === 'video') return h('video', { class: 'inline-img', src, controls: true, preload: 'metadata' });
  return h('audio', { src, controls: true, preload: 'none' });
}

export function attachmentNode(file) {
  const url = safeMediaUrl(file?.url);
  const kind = file ? mediaKind(file) : 'file';
  const box = h('div', { class: 'message-file ' + kind });
  if (!url) {
    box.append('⚠ файл недоступен');
    return box;
  }
  const name = String(file.name || 'файл').slice(0, 120);
  const show = async () => {
    const src = file.enc ? URL.createObjectURL(await decryptFile(url, file.enc, file.type)) : url;
    clear(box);
    if (kind === 'file') {
      box.append(h('a', {
        href: src,
        download: file.enc ? name : null,
        target: file.enc ? null : '_blank',
        rel: 'noopener noreferrer',
        text: '📎 ' + name
      }));
    } else {
      box.append(player(kind, src, name), h('div', { class: 'message-file-name', text: name }));
    }
  };
  const fail = () => {
    clear(box);
    box.append('🔒 не удалось расшифровать файл');
  };
  if (!file.enc) show();
  else if (kind === 'image') show().catch(fail);
  else box.append(h('span', { class: 'locked-file', text: '🔒 ' + name + ' — загрузить', onclick: () => show().catch(fail) }));
  return box;
}
