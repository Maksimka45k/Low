import { h, clear, $ } from './util.js';
import { state } from './state.js';
import { sendGif } from './messages.js';
import { safeMediaUrl } from './media.js';

// Вставьте сюда ключ с klipy.com/developers (между кавычками).
const KLIPY_KEY = 'ifvdGO9p4KdxOoBBSkI8cyJtSTINkvYwqjIfcDIjrSz7OtjkDoqPo2xOWDfvm318';

const API = 'https://api.klipy.com/api/v1/';
const PER_PAGE = 24;

let panel, grid, search, moreBtn, status;
let page = 1, query = '', timer = 0, token = 0, anonId = null;

// Klipy получает не настоящий uid, а производный от него обезличенный идентификатор.
async function customerId() {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('low-gif:' + state.me.uid));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

function addItem(item) {
  const f = item?.file;
  const thumb = safeMediaUrl(f?.sm?.gif?.url || f?.md?.gif?.url);
  const full = safeMediaUrl(f?.md?.gif?.url || f?.hd?.gif?.url);
  if (!thumb || !full) return;
  const img = h('img', { src: thumb, loading: 'lazy', alt: String(item.title || 'GIF').slice(0, 80) });
  const w = f.sm?.gif?.width, ht = f.sm?.gif?.height;
  if (Number.isFinite(w) && Number.isFinite(ht)) { img.setAttribute('width', String(w)); img.setAttribute('height', String(ht)); }
  grid.append(h('button', { title: String(item.title || 'GIF').slice(0, 80), onclick: () => pick(full, f.md?.gif?.size) }, img));
}

async function load(reset) {
  if (KLIPY_KEY.startsWith('ВСТАВЬТЕ')) {
    status.textContent = 'Нужен ключ Klipy: вставьте его в js/gif.js';
    return;
  }
  const mine = ++token;
  if (reset) { page = 1; clear(grid); }
  moreBtn.classList.add('hidden');
  status.textContent = 'Загрузка…';
  try {
    anonId ||= await customerId();
    const p = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE), customer_id: anonId, content_filter: 'medium' });
    if (query) p.set('q', query);
    const res = await fetch(API + encodeURIComponent(KLIPY_KEY) + '/gifs/' + (query ? 'search' : 'trending') + '?' + p);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (mine !== token) return;
    (json?.data?.data || []).forEach(addItem);
    status.textContent = grid.children.length ? 'via KLIPY' : 'Ничего не найдено';
    moreBtn.classList.toggle('hidden', !json?.data?.has_next);
  } catch (e) {
    if (mine === token) status.textContent = 'Не удалось загрузить GIF (' + (e.message || 'ошибка') + ')';
  }
}

function pick(url, size) {
  close();
  const file = { url, name: 'GIF', type: 'image/gif' };
  if (Number.isFinite(size)) file.size = size;
  sendGif(file);
}

const open = () => { panel.classList.remove('hidden'); search.focus(); if (!grid.children.length) load(true); };
const close = () => panel?.classList.add('hidden');

export function initGif() {
  const attach = document.querySelector('[data-act="pickFile"]');
  const area = $('input-area');
  if (!attach || !area || $('gif-btn')) return;
  const btn = h('button', {
    id: 'gif-btn', class: 'btn-icon', title: 'GIF', text: 'GIF',
    onclick: e => { e.stopPropagation(); panel.classList.contains('hidden') ? open() : close(); }
  });
  search = h('input', { id: 'gif-search', placeholder: 'Поиск GIF…', maxlength: '60', autocomplete: 'off' });
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = search.value.trim(); load(true); }, 450);
  });
  grid = h('div', { id: 'gif-grid' });
  moreBtn = h('button', { id: 'gif-more', class: 'btn btn-secondary hidden', text: 'Ещё', onclick: () => { page++; load(false); } });
  status = h('span', { text: '' });
  panel = h('div', { id: 'gif-panel', class: 'hidden' }, search, grid, h('div', { id: 'gif-foot' }, status, moreBtn));
  attach.after(btn);
  area.append(panel);
  document.addEventListener('click', e => { if (!panel.contains(e.target) && e.target !== btn) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}
