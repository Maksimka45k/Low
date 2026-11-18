import { db } from './firebase.js';
import { h, clear, $, toast, isMobile } from './util.js';
import { state } from './state.js';
import { sendGif } from './messages.js';
import { safeMediaUrl } from './media.js';
import { KLIPY_KEY } from './gif-key.js';

const API = 'https://api.klipy.com/api/v1/';
const PER_PAGE = 24;
const MAX_FAVS = 100;
const KLIPY_URL = /^https:\/\/[a-z0-9-]+\.klipy\.com\/[\w.\-/]+$/;

let panel, back, search, home, grid, status, cols = [], colH = [0, 0];
let view = 'home', page = 1, query = '', timer = 0, token = 0, anonId = null;
let count = 0, hasNext = false, busy = false, favs = null;

// Чтобы добавить категорию, допишите строку: { icon: '👋', title: 'Привет', run: () => showAll('hello') }
const CATEGORIES = [
  { icon: '⭐', title: 'Избранное', cls: 'fav', run: () => showFav() },
  { icon: '🔥', title: 'Популярные GIF', run: () => showAll('') }
];

// Klipy получает не настоящий uid, а производный от него обезличенный идентификатор.
async function customerId() {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('low-gif:' + state.me.uid));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- избранное ---------- */
async function loadFavs() {
  if (favs) return favs;
  favs = new Map();
  try {
    const val = (await db.ref('gifFavs/' + state.me.uid).once('value')).val() || {};
    for (const [key, v] of Object.entries(val)) {
      if (safeMediaUrl(v.url) && safeMediaUrl(v.thumb)) favs.set(v.url, { key, ...v });
    }
  } catch {}
  return favs;
}

async function favKey(url) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return [...new Uint8Array(buf)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function setFav(gif, on) {
  await loadFavs();
  const key = await favKey(gif.url);
  const ref = db.ref('gifFavs/' + state.me.uid + '/' + key);
  if (on) {
    if (favs.size >= MAX_FAVS) throw new Error('Максимум ' + MAX_FAVS + ' избранных GIF');
    const rec = { url: gif.url, thumb: gif.thumb || gif.url, at: Date.now() };
    if (Number.isFinite(gif.w) && Number.isFinite(gif.h)) { rec.w = gif.w; rec.h = gif.h; }
    await ref.set(rec);
    favs.set(gif.url, { key, ...rec });
  } else {
    await ref.remove();
    favs.delete(gif.url);
  }
}

export const canSaveGif = file => !!file?.url && KLIPY_URL.test(file.url);

export async function saveGifFav(file) {
  try {
    await loadFavs();
    if (favs.has(file.url)) return toast('Избранные GIF', 'Уже в избранном');
    await setFav({ url: file.url, thumb: file.url }, true);
    toast('Избранные GIF', 'GIF сохранён', 'success');
  } catch (e) {
    toast('Ошибка', e.message || 'Не удалось сохранить', 'error');
  }
}

/* ---------- сетка ---------- */
function resetCols() {
  clear(grid);
  grid.scrollTop = 0;
  cols = [h('div', { class: 'gif-col' }), h('div', { class: 'gif-col' })];
  colH = [0, 0];
  count = 0;
  grid.append(...cols);
}

function more() {
  if (view !== 'all' || busy || !hasNext) return;
  if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 300) { page++; load(false); }
}

function addTile(gif) {
  const img = h('img', { src: gif.thumb, loading: 'lazy', alt: String(gif.title || 'GIF').slice(0, 80) });
  const known = Number.isFinite(gif.w) && Number.isFinite(gif.h) && gif.w > 0;
  if (known) { img.setAttribute('width', String(gif.w)); img.setAttribute('height', String(gif.h)); }
  const isFav = favs?.has(gif.url);
  const star = h('button', { class: 'gif-star' + (isFav ? ' on' : ''), title: 'Избранное', text: isFav ? '★' : '☆' });
  const tile = h('div', { class: 'gif-tile' },
    h('button', { class: 'gif-pick', title: String(gif.title || 'GIF').slice(0, 80), onclick: () => choose(gif) }, img), star);
  star.addEventListener('click', async e => {
    e.stopPropagation();
    const on = !favs?.has(gif.url);
    try {
      await setFav(gif, on);
    } catch (err) {
      toast('Ошибка', err.message || 'Не удалось сохранить', 'error');
      return;
    }
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('on', on);
    if (view === 'fav' && !on) tile.remove();
  });
  const i = colH[0] <= colH[1] ? 0 : 1;
  colH[i] += known ? gif.h / gif.w : 1;
  count++;
  cols[i].append(tile);
}

function addItem(item) {
  const f = item?.file;
  const thumb = safeMediaUrl(f?.sm?.gif?.url || f?.md?.gif?.url);
  const full = safeMediaUrl(f?.md?.gif?.url || f?.hd?.gif?.url);
  if (!thumb || !full) return;
  addTile({ url: full, thumb, w: f.sm?.gif?.width, h: f.sm?.gif?.height, size: f.md?.gif?.size, title: item.title });
}

async function load(reset) {
  if (KLIPY_KEY.startsWith('ВСТАВЬТЕ')) {
    status.textContent = 'Нужен ключ Klipy: вставьте его в js/gif-key.js';
    return;
  }
  const mine = ++token;
  if (reset) { page = 1; resetCols(); }
  busy = true;
  hasNext = false;
  status.textContent = 'Загрузка…';
  try {
    anonId ||= await customerId();
    await loadFavs();
    const p = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE), customer_id: anonId, content_filter: 'medium' });
    if (query) p.set('q', query);
    const res = await fetch(API + encodeURIComponent(KLIPY_KEY) + '/gifs/' + (query ? 'search' : 'trending') + '?' + p);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (mine !== token) return;
    (json?.data?.data || []).forEach(addItem);
    status.textContent = count ? 'via KLIPY' : 'Ничего не найдено';
    hasNext = !!json?.data?.has_next;
    busy = false;
    more();
  } catch (e) {
    if (mine === token) { busy = false; status.textContent = 'Не удалось загрузить GIF (' + (e.message || 'ошибка') + ')'; }
  }
}

/* ---------- экраны ---------- */
function setView(v) {
  view = v;
  token++;
  busy = false;
  hasNext = false;
  status.textContent = '';
  home.classList.toggle('hidden', v !== 'home');
  grid.classList.toggle('hidden', v === 'home');
  back.classList.toggle('hidden', v === 'home');
}

function showHome() {
  setView('home');
  query = '';
  search.value = '';
}

function showAll(q) {
  setView('all');
  query = q;
  search.value = q;
  load(true);
}

async function showFav() {
  setView('fav');
  search.value = '';
  resetCols();
  status.textContent = 'Загрузка…';
  await loadFavs();
  if (view !== 'fav') return;
  const list = [...favs.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
  list.forEach(addTile);
  status.textContent = list.length ? 'Избранное: ' + list.length : 'Пока пусто. Нажмите ☆ на любой GIF';
}

function choose(gif) {
  close();
  const file = { url: gif.url, name: 'GIF', type: 'image/gif' };
  if (Number.isFinite(gif.size)) file.size = gif.size;
  sendGif(file);
}

const open = () => { showHome(); panel.classList.remove('hidden'); if (!isMobile()) search.focus(); };
const close = () => panel?.classList.add('hidden');

export function initGif() {
  const attach = document.querySelector('[data-act="pickFile"]');
  const area = $('input-area');
  if (!attach || !area || $('gif-btn')) return;
  const btn = h('button', {
    id: 'gif-btn', class: 'btn-icon', title: 'GIF', text: 'GIF',
    onclick: e => { e.stopPropagation(); panel.classList.contains('hidden') ? open() : close(); }
  });
  back = h('button', { id: 'gif-back', class: 'hidden', title: 'Назад', text: '←', onclick: showHome });
  search = h('input', { id: 'gif-search', placeholder: 'Поиск GIF…', maxlength: '60', autocomplete: 'off' });
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => showAll(search.value.trim()), 450);
  });
  home = h('div', { id: 'gif-home' }, CATEGORIES.map(c =>
    h('button', { class: 'gif-cat ' + (c.cls || ''), onclick: c.run }, h('span', { text: c.icon }), h('b', { text: c.title }))));
  grid = h('div', { id: 'gif-grid', class: 'hidden' });
  status = h('span', { text: '' });
  panel = h('div', { id: 'gif-panel', class: 'hidden' },
    h('div', { id: 'gif-head' }, back, search), home, grid, h('div', { id: 'gif-foot' }, status));
  resetCols();
  grid.addEventListener('scroll', more);
  attach.after(btn);
  area.append(panel);
  document.addEventListener('click', e => { if (!panel.contains(e.target) && e.target !== btn) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
                        }
