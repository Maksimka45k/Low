import { $, h, clear, toast } from './util.js';
import { decryptFile } from './crypto.js';

const HOST = /^https:\/\/(files|litter)\.catbox\.moe\/[\w.\-/]+$/;
const EXT = {
  image: /\.(jpe?g|png|gif|webp|bmp)$/i,
  video: /\.(mp4|webm|ogv|mov)$/i,
  audio: /\.(mp3|wav|ogg|m4a|aac)$/i
};

const KLIPY = /^https:\/\/[a-z0-9-]+\.klipy\.com\/[\w.\-/]+$/;
const CLOUD = 'igqnvp1y';        // Cloudinary: имя облака
const PRESET = 'low_unsigned';   // Cloudinary: unsigned upload preset
const CLD_MAX = 10 * 1048576;    // лимит бесплатного тарифа на файл
const CLOUDINARY = new RegExp('^https://res\\.cloudinary\\.com/' + CLOUD + '/[\\w.\\-/]+$');
export const safeMediaUrl = url => (typeof url === 'string' && (HOST.test(url) || KLIPY.test(url) || CLOUDINARY.test(url)) ? url : null);

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

async function withRetry(fn, tries) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e.retry === false) break;
      await wait(800 * (i + 1));
    }
  }
  throw last;
}

async function cloudinaryOnce(file, name) {
  const form = new FormData();
  form.append('file', file, name);
  form.append('upload_preset', PRESET);
  const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUD + '/auto/upload', {
    method: 'POST', body: form, signal: AbortSignal.timeout(20000 + file.size / 100)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || 'Cloudinary: ' + res.status), { retry: res.status >= 500 });
  if (!safeMediaUrl(json.secure_url)) throw Object.assign(new Error('Неожиданный ответ сервера'), { retry: true });
  return json.secure_url;
}

// Зашифрованный блок называется data.bin; если Cloudinary не принимает такое расширение, пробуем другие.
async function postCloudinary(file) {
  const names = file.name === 'data.bin' ? ['data.bin', 'data.txt', 'data.dat'] : [file.name];
  let last;
  for (const name of names) {
    try {
      return await cloudinaryOnce(file, name);
    } catch (e) {
      last = e;
      if (!/not allowed/i.test(e.message || '')) throw e;
    }
  }
  throw last;
}

const HOSTS = {
  cloudinary: (f, tries) => withRetry(() => postCloudinary(f), tries),
  catbox: (f, tries) => withRetry(() => postOnce(f, true), tries),
  litter: (f, tries) => withRetry(() => postOnce(f, false), tries)
};
const failedAt = {};

// Если хранилище недавно не отвечало, в этой сессии оно пробуется в последнюю очередь.
export async function uploadFile(file, permanent) {
  let order = permanent ? ['cloudinary', 'catbox', 'litter'] : ['litter', 'cloudinary', 'catbox'];
  if (file.size > CLD_MAX) order = order.filter(name => name !== 'cloudinary');
  const bad = name => Date.now() - (failedAt[name] || 0) < 10 * 60 * 1000;
  order = [...order.filter(name => !bad(name)), ...order.filter(bad)];
  const errors = [];
  const LABEL = { cloudinary: 'Cloudinary', catbox: 'Catbox', litter: 'litterbox' };
  for (const [i, name] of order.entries()) {
    try {
      const url = await HOSTS[name](file, i === order.length - 1 ? 3 : 1);
      if (i > 0) toast('Файл', 'Основное хранилище недоступно, файл сохранён в запасном');
      return url;
    } catch (e) {
      failedAt[name] = Date.now();
      errors.push(LABEL[name] + ': ' + (e.message || 'ошибка'));
    }
  }
  throw new Error(errors.join(' | '));
}

// Фото с камеры сжимаются перед отправкой (до 1920 px, JPEG): меньше места и трафика.
export async function compressImage(file) {
  if (file.type !== 'image/jpeg' || file.size < 1048576) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), ht = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = ht;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, ht);
    bmp.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? new File([blob], file.name, { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

const decrypted = new Map();
function decryptedUrl(url, enc, type) {
  if (!decrypted.has(url)) {
    decrypted.set(url, decryptFile(url, enc, type).then(blob => URL.createObjectURL(blob)).catch(e => { decrypted.delete(url); throw e; }));
  }
  return decrypted.get(url);
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
    const src = file.enc ? await decryptedUrl(url, file.enc, file.type) : url;
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
