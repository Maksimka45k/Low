import { $, h, clear, toast } from './util.js';
import { decryptFile } from './crypto.js';

const HOST = /^https:\/\/(files|litter)\.catbox\.moe\/[\w.\-/]+$/;
const EXT = {
  image: /\.(jpe?g|png|gif|webp|bmp)$/i,
  video: /\.(mp4|webm|ogv|mov)$/i,
  audio: /\.(mp3|wav|ogg|m4a|aac)$/i
};

const KLIPY = /^https:\/\/[a-z0-9-]+\.klipy\.com\/[\w.\-/]+$/;
export const safeMediaUrl = url => (typeof url === 'string' && (HOST.test(url) || KLIPY.test(url)) ? url : null);

const CATBOX = 'https://catbox.moe/user/api.php';
const LITTER = 'https://litterbox.catbox.moe/resources/internals/api.php';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function postOnce(file, permanent) {
  const form = new FormData();
  if (!permanent) form.append('time', '72h');
  form.append('reqtype', 'fileupload');
  form.append('userhash', '');
  form.append('fileToUpload', file);
  const res = await fetch(permanent ? CATBOX : LITTER, { method: 'POST', body: form, signal: AbortSignal.timeout(20000 + file.size / 100) });
  if (!res.ok) throw Object.assign(new Error('Загрузка не удалась: ' + res.status), { retry: res.status >= 500 });
  const out = (await res.text()).trim();
  if (!safeMediaUrl(out)) throw Object.assign(new Error('Неожиданный ответ сервера'), { retry: true });
  return out;
}

async function postWithRetry(file, permanent, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await postOnce(file, permanent);
    } catch (e) {
      last = e;
      if (e.retry === false) break;
      await wait(800 * (i + 1));
    }
  }
  throw last;
}

export async function uploadFile(file, permanent) {
  try {
    return await postWithRetry(file, permanent, 1);
  } catch (first) {
    try {
      const url = await postWithRetry(file, !permanent);
      toast('Файл', permanent
        ? 'Постоянное хранилище недоступно, файл сохранён на 72 часа'
        : 'Временное хранилище недоступно, файл сохранён в постоянном');
      return url;
    } catch {
      throw first;
    }
  }
}

export function mediaKind(file) {
  const type = file.type || '';
  const name = file.name || '';
  if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(type) || EXT.image.test(name)) return 'image';
  if (type.startsWith('video/') || EXT.video.test(name)) return 'video';
  if (type.startsWith('audio/') || EXT.audio.test(name)) return 'audio';
  return 'file';
}

let current = null;

async function downloadCurrent(e) {
  e.stopPropagation();
  if (!current) return;
  const { src, name } = current;
  const fileName = name || decodeURIComponent(src.split('/').pop().split('?')[0]) || 'file';
  try {
    let href = src;
    if (!src.startsWith('blob:')) {
      const res = await fetch(src);
      if (!res.ok) throw new Error('fetch');
      href = URL.createObjectURL(await res.blob());
      setTimeout(() => URL.revokeObjectURL(href), 15000);
    }
    const link = h('a', { href, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
  } catch {
    window.open(src, '_blank', 'noopener,noreferrer');
    toast('Скачивание', 'Прямое скачивание недоступно, файл открыт в новой вкладке');
  }
}

function ensureDownloadButton() {
  if ($('media-download')) return;
  $('media-modal').append(h('button', {
    id: 'media-download', class: 'media-modal-close', title: 'Скачать', text: '⬇',
    style: { right: '90px', border: 'none', fontSize: '24px', background: 'rgba(0,0,0,0.5)' },
    onclick: downloadCurrent
  }));
}

export function openMediaModal(src, kind, name) {
  ensureDownloadButton();
  current = { src, name };
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
      onclick: e => { e.stopPropagation(); openMediaModal(src, 'image', name); }
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
