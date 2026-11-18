import { state } from './state.js';
import { $, h, clear, getUser, toast, showModal, hideModal } from './util.js';
import { cachedChats, displayInfo } from './chats.js';
import { sendPayload } from './messages.js';

function ensureModal() {
  if ($('forward-modal')) return;
  const show = document.createElement('input');
  show.type = 'checkbox';
  show.id = 'forward-show';
  show.checked = true;
  const search = h('input', { id: 'forward-search', placeholder: 'Поиск чата…', autocomplete: 'off' });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const row of $('forward-list').children) row.classList.toggle('hidden', !!q && !row.dataset.name.includes(q));
  });
  document.body.append(h('div', { class: 'modal-overlay hidden', id: 'forward-modal' },
    h('div', { class: 'modal' },
      h('h3', { text: 'Переслать' }),
      h('label', { class: 'forward-opt' }, show, h('span', { text: 'Показывать, от кого переслано' })),
      search,
      h('div', { id: 'forward-list' }),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn btn-secondary', text: 'Отмена', onclick: () => hideModal('forward-modal') })))));
}

async function forwardTo(chat, name, entry, showFrom) {
  hideModal('forward-modal');
  const { msg, payload } = entry;
  const out = {};
  if (payload.text) out.text = payload.text;
  if (payload.file) out.file = payload.file;
  if (showFrom) {
    const author = payload.fwd?.name || (await getUser(msg.from).catch(() => null))?.name || '?';
    out.fwd = { name: String(author).slice(0, 40) };
  }
  try {
    await sendPayload(chat, out);
    toast('Переслано', name, 'success');
  } catch (e) {
    toast('Ошибка', e.message || 'Не удалось переслать', 'error');
  }
}

export async function openForward(entry) {
  ensureModal();
  $('forward-search').value = '';
  const list = clear($('forward-list'));
  const chats = cachedChats()
    .filter(c => c.type !== 'channel' || c.ownerId === state.me.uid)
    .sort((a, b) => (b.saved ? 1 : 0) - (a.saved ? 1 : 0) || (b.lastAt || 0) - (a.lastAt || 0));
  showModal('forward-modal');
  const infos = await Promise.all(chats.map(c => displayInfo(c).catch(() => ({ name: '?', initials: '?', color: '#555' }))));
  chats.forEach((chat, i) => {
    const info = infos[i];
    const avatar = h('div', { class: 'avatar', text: info.initials || '?' });
    if (info.color) avatar.style.background = info.color;
    const row = h('div', { class: 'chat-item', onclick: () => forwardTo(chat, info.name, entry, $('forward-show').checked) },
      avatar, h('div', { class: 'chat-info' }, h('div', { class: 'chat-name', text: info.name })));
    row.dataset.name = String(info.name || '').toLowerCase();
    list.append(row);
  });
  if (!chats.length) list.append(h('div', { class: 'note', text: 'Нет чатов, куда можно переслать' }));
}
