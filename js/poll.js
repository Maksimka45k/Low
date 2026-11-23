import { db } from './firebase.js';
import { state } from './state.js';
import { $, h, clear, toast, showModal, hideModal } from './util.js';
import { sendPayload } from './messages.js';

/*
 * Голосование. Само сообщение (вопрос и варианты) — обычное: в группах и личных чатах оно зашифровано,
 * в каналах нет. Голоса лежат отдельно в votes/{чат}/{голосование}/{uid} = номер варианта (0..9):
 * у каждого своя запись, поэтому голосовать и менять голос может любой участник, а не только автор.
 */
const ID = /^[0-9a-f]{16}$/;
const MAX_OPTS = 10;
const nonce = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');

export function pollNode(act) {
  const opts = Array.isArray(act.opts) ? act.opts.slice(0, MAX_OPTS).map(o => String(o).slice(0, 100)) : [];
  const chat = state.chat;
  if (!chat || !ID.test(act.id || '') || typeof act.q !== 'string' || opts.length < 2) {
    return h('div', { class: 'act-error', text: '⚠ голосование недоступно' });
  }
  const me = state.me.uid;
  const ref = db.ref('votes/' + chat.id + '/' + act.id);
  const list = h('div', { class: 'poll-list' });
  const foot = h('div', { class: 'poll-foot', text: 'Загрузка…' });
  const box = h('div', { class: 'poll' }, h('div', { class: 'wheel-title poll-q', text: '📊 ' + act.q.slice(0, 200) }), list, foot);
  let votes = {}, shown = false;

  const vote = value => {
    const own = ref.child(me);
    (value === null ? own.remove() : own.set(value)).catch(() => toast('Голосование', 'Не удалось проголосовать', 'error'));
  };

  const render = () => {
    const counts = Array(opts.length).fill(0);
    let total = 0;
    for (const v of Object.values(votes)) {
      if (Number.isInteger(v) && v >= 0 && v < opts.length) { counts[v]++; total++; }
    }
    const mine = Number.isInteger(votes[me]) && votes[me] < opts.length ? votes[me] : -1;
    clear(list);
    opts.forEach((label, i) => {
      const pct = total ? Math.round((counts[i] * 100) / total) : 0;
      const bar = h('span', { class: 'poll-bar' });
      bar.style.width = pct + '%';
      list.append(h('button', { class: 'poll-opt' + (mine === i ? ' mine' : ''), onclick: () => vote(mine === i ? null : i) },
        bar, h('span', { class: 'poll-label', text: (mine === i ? '✓ ' : '') + label }), h('span', { class: 'poll-count', text: counts[i] + ' · ' + pct + '%' })));
    });
    foot.textContent = 'Проголосовало: ' + total + (mine >= 0 ? ' · нажмите на свой вариант, чтобы убрать голос' : '');
  };

  const onValue = snap => {
    if (shown && !box.isConnected) { ref.off('value', onValue); return; }
    shown = true;
    votes = snap.val() || {};
    render();
  };
  ref.on('value', onValue, () => { foot.textContent = 'Голоса недоступны'; });
  render();
  return box;
}

/* ---------- создание ---------- */
let sending = false;

function syncOpts() {
  const rows = [...$('poll-opts').children];
  rows.forEach((row, i) => { row.querySelector('input').placeholder = 'Вариант ' + (i + 1); });
  $('poll-add').disabled = rows.length >= MAX_OPTS;
}

function addOpt() {
  const list = $('poll-opts');
  if (list.children.length >= MAX_OPTS) return;
  const input = h('input', { class: 'poll-input', maxlength: '100', autocomplete: 'off' });
  const row = h('div', { class: 'poll-row' }, input,
    h('button', { class: 'draw-btn', text: '✕', title: 'Убрать вариант', onclick: () => { if (list.children.length > 2) { row.remove(); syncOpts(); } } }));
  list.append(row);
  syncOpts();
}

async function submit() {
  const chat = state.chat;
  if (!chat || sending) return;
  const q = $('poll-q').value.trim();
  const opts = [...$('poll-opts').querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
  if (!q) return toast('Голосование', 'Напишите вопрос', 'error');
  if (opts.length < 2) return toast('Голосование', 'Нужно минимум 2 варианта', 'error');
  sending = true;
  try {
    await sendPayload(chat, { act: { type: 'poll', id: nonce(), q, opts } });
    hideModal('poll-modal');
    toast('Голосование', 'Отправлено', 'success');
  } catch (e) {
    toast('Ошибка', e.message || 'Не удалось отправить', 'error');
  } finally {
    sending = false;
  }
}

export function startPoll() {
  if (!state.chat) return;
  if (!$('poll-modal')) {
    document.body.append(h('div', { class: 'modal-overlay hidden', id: 'poll-modal' },
      h('div', { class: 'modal' },
        h('h3', { text: 'Голосование' }),
        h('textarea', { id: 'poll-q', rows: '2', maxlength: '200', placeholder: 'Вопрос' }),
        h('div', { id: 'poll-opts' }),
        h('button', { id: 'poll-add', class: 'btn btn-secondary', text: '+ Добавить вариант', onclick: addOpt }),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn btn-secondary', text: 'Отмена', onclick: () => hideModal('poll-modal') }),
          h('button', { class: 'btn btn-primary', text: 'Отправить', onclick: submit })))));
  }
  $('poll-q').value = '';
  clear($('poll-opts'));
  addOpt();
  addOpt();
  showModal('poll-modal');
  $('poll-q').focus();
}
