import { db } from './firebase.js';
import { state } from './state.js';
import { $, h, clear, toast, initials, userColor, COLORS, colorFromNick } from './util.js';

const THEMES = {
  dark: { '--bg': '#0a0a12', '--bg-secondary': '#12121f', '--bg-tertiary': '#1a1a2c', '--border': '#2a2a3a', '--text': '#e0e0f0', '--text-secondary': '#9090b0', '--text-muted': '#505070' },
  light: { '--bg': '#f5f5fa', '--bg-secondary': '#ffffff', '--bg-tertiary': '#f0f0f8', '--border': '#d0d0e0', '--text': '#12121f', '--text-secondary': '#505070', '--text-muted': '#9090b0' }
};

const root = document.documentElement;

export const toggleSettings = () => $('settings').classList.toggle('hidden');

export function switchSettingsTab(name, el) {
  document.querySelectorAll('.settings-nav-item').forEach(e => e.classList.toggle('active', e === el));
  document.querySelectorAll('.settings-section').forEach(e => e.classList.toggle('active', e.id === name + '-section'));
}

export function updateAvatarColors() {
  for (const id of ['user-avatar', 'settings-avatar']) {
    const el = $(id);
    el.style.background = userColor(state.me);
    el.textContent = initials(state.me.name);
  }
}

export function fillProfile() {
  const me = state.me;
  $('user-name').textContent = me.name;
  $('user-nick').textContent = '@' + me.nick;
  $('settings-name').textContent = me.name;
  $('settings-nick').textContent = '@' + me.nick;
  $('settings-display-name').value = me.name;
  $('settings-status').value = me.status || '';
  updateAvatarColors();
}

export async function saveProfile() {
  const name = $('settings-display-name').value.trim();
  const status = $('settings-status').value.trim();
  if (!name) return;
  await db.ref('users/' + state.me.uid).update({ name, status });
  Object.assign(state.me, { name, status });
  fillProfile();
  toast('Сохранено', 'Профиль обновлён', 'success');
}

export function cycleAvatarColor() {
  const current = userColor(state.me);
  const next = COLORS[(COLORS.indexOf(current) + 1) % COLORS.length] || colorFromNick(state.me.nick);
  state.me.color = next;
  db.ref('users/' + state.me.uid + '/color').set(next);
  updateAvatarColors();
}

export function setAccentColor(color, el) {
  document.querySelectorAll('.color-option').forEach(e => e.classList.toggle('active', e === el));
  root.style.setProperty('--accent', color);
}

export function setTheme(dark) {
  for (const [name, value] of Object.entries(THEMES[dark ? 'dark' : 'light'])) root.style.setProperty(name, value);
}

export const setFont = font => root.style.setProperty('--font-mono', font);

export function setFontSize(size) {
  $('font-size-value').textContent = size + 'px';
  root.style.setProperty('--msg-size', size + 'px');
}

export async function loadDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const targets = { audioinput: $('mic-select'), audiooutput: $('speaker-select'), videoinput: $('camera-select') };
    Object.values(targets).forEach(clear);
    for (const device of devices) {
      const target = targets[device.kind];
      if (target) target.append(new Option(device.label || device.kind + ' (' + device.deviceId.slice(0, 5) + '...)', device.deviceId));
    }
  } catch (e) {
    console.warn('devices', e);
  }
}

export async function requestMediaPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach(t => t.stop());
    toast('Доступ получен', 'Список устройств обновлён', 'success');
    await loadDevices();
  } catch {
    toast('Ошибка доступа', 'Проверьте настройки конфиденциальности браузера', 'error');
  }
}

export async function testMicrophone() {
  const level = $('mic-test-level');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let ticks = 0;
    level.textContent = '🎤 Говорите...';
    const timer = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const bars = Math.min(20, Math.round(data.reduce((a, b) => a + b, 0) / data.length / 8));
      level.textContent = '▐' + '█'.repeat(bars) + '░'.repeat(20 - bars) + '▌';
      if (++ticks > 60) {
        clearInterval(timer);
        stream.getTracks().forEach(t => t.stop());
        ctx.close();
        level.textContent = '✓ Тест завершён';
      }
    }, 80);
  } catch {
    level.textContent = '✗ Нет доступа к микрофону';
  }
}

export async function startCameraPreview() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const video = $('camera-preview');
    video.srcObject = stream;
    video.classList.remove('hidden');
    $('camera-placeholder').classList.add('hidden');
  } catch {
    toast('Ошибка', 'Нет доступа к камере', 'error');
  }
}

export function requestNotifications() {
  Notification.requestPermission().then(p => { if (p === 'granted') toast('Уведомления', 'Разрешены', 'success'); });
}
