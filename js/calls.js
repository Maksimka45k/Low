import { db, TS } from './firebase.js';
import { state } from './state.js';
import { ICE_SERVERS, LIMITS } from './config.js';
import { $, toast, getUser, initials, userColor, avatarContent } from './util.js';
import { otherUid } from './messages.js';

let incomingRef = null;
let incomingHandlers = null;

const callRef = call => db.ref('calls/' + call.calleeId + '/' + call.id);
const otherRole = call => (call.role === 'caller' ? 'callee' : 'caller');

function newCall(fields) {
  return {
    ...fields,
    pc: null,
    local: null,
    screen: null,
    camTrack: null,
    remote: new MediaStream(),
    iceQueue: [],
    listeners: [],
    timers: {},
    accepted: false,
    muted: false,
    cam: false,
    screenOn: false,
    peerVideo: false,
    minimized: false,
    meter: null,
    ended: false
  };
}

function listen(call, ref, event, fn) {
  ref.on(event, fn);
  call.listeners.push({ ref, event, fn });
}

async function openMedia(type) {
  const attempts = type === 'video' ? [{ audio: true, video: true }, { audio: true }] : [{ audio: true }];
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.warn('getUserMedia', e.name);
    }
  }
  return null;
}

function videoSender(call) {
  return call.pc.getTransceivers().find(t => t.receiver.track.kind === 'video')?.sender || null;
}

function syncLayout() {
  const call = state.call;
  if (!call) return;
  $('call-videos').classList.toggle('hidden', !(call.cam || call.screenOn || call.peerVideo));
  $('remote-video').classList.toggle('hidden', !call.peerVideo);
  $('remote-placeholder').classList.toggle('hidden', call.peerVideo);
  if (call.peerVideo) $('remote-video').play().catch(() => {});
  syncDock();
}

function syncLocalPreview() {
  const call = state.call;
  if (!call) return;
  const track = call.screenOn ? call.screen?.getVideoTracks()[0] : call.cam ? call.camTrack : null;
  const video = $('local-video');
  video.srcObject = track ? new MediaStream([track]) : null;
  video.classList.toggle('hidden', !track);
  $('local-placeholder').classList.toggle('hidden', !!track);
  syncLayout();
}

function publishVideoState(call) {
  callRef(call).child('video_' + call.role).set(call.cam || call.screenOn).catch(() => {});
}

function setStatus(full, short = full) {
  $('call-status').textContent = full;
  $('dock-status').textContent = short;
}

/* ---------- свёрнутый звонок: плавающая плашка ---------- */
const DOCK_KEY = 'low:dockCorner';
const CORNERS = ['tl', 'tr', 'bl', 'br'];
let dockCorner = (() => {
  try { const c = localStorage.getItem(DOCK_KEY); return CORNERS.includes(c) ? c : 'bl'; } catch { return 'bl'; }
})();

function dockMargins() {
  const mobile = window.innerWidth <= 768;
  return { side: 16, top: mobile ? 64 : 72, bottom: mobile ? 84 : 88 };
}

function cornerPos(corner, dock) {
  const m = dockMargins();
  const w = dock.offsetWidth, h = dock.offsetHeight;
  return {
    left: corner[1] === 'l' ? m.side : Math.max(m.side, window.innerWidth - w - m.side),
    top: corner[0] === 't' ? m.top : Math.max(m.top, window.innerHeight - h - m.bottom)
  };
}

function placeDock(animate = false) {
  const dock = $('call-dock');
  if (dock.classList.contains('hidden') || dock.classList.contains('dragging')) return;
  dock.classList.toggle('snap', animate);
  const pos = cornerPos(dockCorner, dock);
  dock.style.left = pos.left + 'px';
  dock.style.top = pos.top + 'px';
}

function initDockDrag() {
  const dock = $('call-dock');
  const handle = $('dock-drag');
  let drag = null;
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const rect = dock.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    handle.setPointerCapture(e.pointerId);
    dock.classList.remove('snap');
    dock.classList.add('dragging');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - dock.offsetWidth);
    const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - dock.offsetHeight);
    dock.style.left = x + 'px';
    dock.style.top = y + 'px';
  });
  const finish = e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    dock.classList.remove('dragging');
    const rect = dock.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    dockCorner = (cy < window.innerHeight / 2 ? 't' : 'b') + (cx < window.innerWidth / 2 ? 'l' : 'r');
    try { localStorage.setItem(DOCK_KEY, dockCorner); } catch {}
    placeDock(true);
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}
initDockDrag();
window.addEventListener('resize', () => placeDock(false));

function fillDockAvatar(el, user) {
  el.style.background = userColor(user);
  el.replaceChildren(user.img ? avatarContent(user) : initials(user.name));
}

// Единое место, где кнопки обоих окон (полного и плашки) узнают состояние звонка.
function syncControls() {
  const call = state.call;
  if (!call) return;
  const mic = call.muted ? '🔇' : '🎤';
  for (const id of ['mute-button', 'dock-mute']) {
    $(id).textContent = mic;
    $(id).classList.toggle('danger', call.muted);
  }
  const cam = call.cam && !call.screenOn;
  $('camera-button').classList.toggle('on', cam);
  $('dock-camera').classList.toggle('on', cam);
  $('screen-button').classList.toggle('on', call.screenOn);
  $('dock-screen').classList.toggle('on', call.screenOn);
}

function syncDock() {
  const call = state.call;
  if (!call) return;
  const showVideo = call.minimized && call.peerVideo;
  $('dock-video-box').classList.toggle('hidden', !showVideo);
  if (showVideo) {
    const v = $('dock-video');
    if (v.srcObject !== call.remote) v.srcObject = call.remote;
    v.play().catch(() => {});
  }
  placeDock(true);
}

export function minimizeCall() {
  const call = state.call;
  if (!call || call.minimized) return;
  call.minimized = true;
  $('call-overlay').classList.add('hidden');
  $('call-dock').classList.remove('hidden');
  $('remote-audio').play().catch(() => {});
  syncControls();
  syncDock();
  placeDock(false);
}

export function expandCall() {
  const call = state.call;
  if (!call || !call.minimized) return;
  call.minimized = false;
  $('call-dock').classList.add('hidden');
  $('dock-video').srcObject = null;
  $('dock-video-box').classList.add('hidden');
  $('call-overlay').classList.remove('hidden');
  $('remote-audio').play().catch(() => {});
  syncLayout();
  syncControls();
}

/* Индикатор «говорит»: зелёное кольцо у аватарки, как в Discord. */
function startMeters(call) {
  if (call.meter) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  let ctx;
  try { ctx = new AC(); } catch { return; }
  const mk = (stream, el, muted) => ({ stream, el, muted, analyser: null, buf: null, until: 0 });
  const meters = [
    mk(call.remote, $('dock-peer'), () => false),
    mk(call.local, $('dock-me'), () => call.muted)
  ];
  const timer = setInterval(() => {
    if (!call.minimized) {
      meters.forEach(m => m.el.classList.remove('speaking'));
      return;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = Date.now();
    for (const m of meters) {
      if (!m.analyser && m.stream && m.stream.getAudioTracks().length) {
        try {
          m.analyser = ctx.createAnalyser();
          m.analyser.fftSize = 512;
          m.buf = new Uint8Array(m.analyser.fftSize);
          ctx.createMediaStreamSource(m.stream).connect(m.analyser);
        } catch { m.analyser = null; continue; }
      }
      if (!m.analyser) continue;
      let loud = false;
      if (!m.muted()) {
        m.analyser.getByteTimeDomainData(m.buf);
        let peak = 0;
        for (let i = 0; i < m.buf.length; i++) peak = Math.max(peak, Math.abs(m.buf[i] - 128));
        loud = peak > 6;
      }
      if (loud) m.until = now + 350;
      m.el.classList.toggle('speaking', now < m.until);
    }
  }, 120);
  call.meter = { ctx, timer };
}

function stopMeters(call) {
  if (!call.meter) return;
  clearInterval(call.meter.timer);
  call.meter.ctx.close().catch(() => {});
  call.meter = null;
  $('dock-peer').classList.remove('speaking');
  $('dock-me').classList.remove('speaking');
}

function startTimer(call) {
  if (call.timers.tick) return;
  clearTimeout(call.timers.ring);
  call.accepted = true;
  let seconds = 0;
  call.timers.tick = setInterval(() => {
    seconds++;
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    setStatus((call.type === 'video' ? 'ВИДЕО' : 'ЗВОНОК') + ' • ' + mm + ':' + ss, mm + ':' + ss);
  }, 1000);
  startMeters(call);
}

function createPeer(call) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  pc.ontrack = e => call.remote.addTrack(e.track);
  pc.onconnectionstatechange = () => {
    if (state.call !== call) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      clearTimeout(call.timers.drop);
      startTimer(call);
    } else if (s === 'failed') {
      toast('Звонок', 'Нет соединения', 'error');
      endCall();
    } else if (s === 'disconnected') {
      call.timers.drop = setTimeout(() => {
        if (state.call === call && pc.connectionState === 'disconnected') endCall();
      }, 8000);
    }
  };
  call.pc = pc;
  return pc;
}

function attachLocal(call, stream) {
  call.local = stream;
  call.camTrack = stream.getVideoTracks()[0] || null;
  call.cam = !!call.camTrack;
  stream.getTracks().forEach(t => call.pc.addTrack(t, stream));
  syncControls();
}

function pushIce(call, candidate) {
  callRef(call).child('ice_' + call.role).push(candidate).catch(() => {});
}

function addIce(call, candidate) {
  if (call.pc.remoteDescription) call.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.warn);
  else call.iceQueue.push(candidate);
}

function flushIce(call) {
  while (call.iceQueue.length) call.pc.addIceCandidate(new RTCIceCandidate(call.iceQueue.shift())).catch(console.warn);
}

function showCallUI(call, user) {
  $('call-title').textContent = user.name;
  const wait = call.role === 'caller' ? 'ВЫЗОВ...' : 'СОЕДИНЕНИЕ...';
  setStatus(wait);
  $('dock-name').textContent = user.name;
  fillDockAvatar($('dock-peer'), user);
  fillDockAvatar($('dock-me'), state.me);
  $('call-dock').classList.add('hidden');
  $('remote-label').textContent = user.name;
  const rp = $('remote-placeholder');
  rp.style.background = userColor(user);
  rp.textContent = initials(user.name);
  const lp = $('local-placeholder');
  lp.style.background = userColor(state.me);
  lp.textContent = initials(state.me.name);
  $('remote-audio').srcObject = call.remote;
  $('remote-video').srcObject = call.remote;
  $('call-overlay').classList.remove('hidden');
  $('call-overlay').addEventListener('click', () => $('remote-audio').play().catch(() => {}), { once: true });
  syncLocalPreview();
  syncControls();
}

function watchCommon(call) {
  listen(call, callRef(call).child('video_' + otherRole(call)), 'value', snap => {
    call.peerVideo = !!snap.val();
    syncLayout();
  });
}

export async function startCall(type) {
  const chat = state.chat;
  if (!chat || chat.type !== 'dm' || state.incoming) return;
  if (state.call) {
    toast('Звонок', 'Сначала завершите текущий звонок');
    return;
  }
  const calleeId = otherUid(chat);
  if (!calleeId) return;
  const call = newCall({ id: db.ref('calls/' + calleeId).push().key, calleeId, callerId: state.me.uid, role: 'caller', type });
  state.call = call;
  showCallUI(call, await getUser(calleeId));
  const stream = await openMedia(type);
  if (state.call !== call) { stream?.getTracks().forEach(t => t.stop()); return; }
  if (!stream) {
    toast('Звонок', 'Нет доступа к микрофону', 'error');
    endCall();
    return;
  }
  const pc = createPeer(call);
  attachLocal(call, stream);
  if (!call.camTrack) pc.addTransceiver('video', { direction: 'sendrecv' });
  const pending = [];
  let published = false;
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    if (published) pushIce(call, e.candidate.toJSON());
    else pending.push(e.candidate.toJSON());
  };
  syncLocalPreview();
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await callRef(call).set({
      type,
      callerId: state.me.uid,
      callerName: state.me.name,
      status: 'pending',
      offer: { sdp: offer.sdp, type: offer.type },
      createdAt: TS
    });
  } catch (e) {
    toast('Звонок', 'Не удалось начать звонок', 'error');
    endCall();
    return;
  }
  if (state.call !== call) return;
  published = true;
  pending.forEach(c => pushIce(call, c));
  publishVideoState(call);
  call.timers.ring = setTimeout(() => {
    if (state.call === call && !call.accepted) {
      toast('Звонок', 'Нет ответа');
      endCall();
    }
  }, LIMITS.ringSeconds * 1000);
  listen(call, callRef(call).child('status'), 'value', snap => {
    const s = snap.val();
    if (state.call !== call) return;
    if (s === 'rejected') {
      toast('Звонок', 'Отклонён');
      endCall();
    } else if (s === null || s === 'ended') {
      toast('Звонок', call.accepted ? 'Завершён' : 'Отменён');
      endCall();
    }
  });
  listen(call, callRef(call).child('answer'), 'value', async snap => {
    if (!snap.exists() || pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));
    flushIce(call);
  });
  listen(call, callRef(call).child('ice_callee'), 'child_added', snap => addIce(call, snap.val()));
  watchCommon(call);
}

export async function acceptCall() {
  const incoming = state.incoming;
  if (!incoming || state.call) return;
  clearTimeout(incoming.timeout);
  state.incoming = null;
  $('incoming-call').classList.add('hidden');
  const call = newCall({ id: incoming.id, calleeId: state.me.uid, callerId: incoming.callerId, role: 'callee', type: incoming.type });
  state.call = call;
  showCallUI(call, await getUser(incoming.callerId));
  const stream = await openMedia(incoming.type);
  if (state.call !== call) { stream?.getTracks().forEach(t => t.stop()); return; }
  if (!stream) {
    toast('Звонок', 'Нет доступа к микрофону', 'error');
    endCall();
    return;
  }
  const pc = createPeer(call);
  attachLocal(call, stream);
  pc.onicecandidate = e => { if (e.candidate) pushIce(call, e.candidate.toJSON()); };
  listen(call, callRef(call).child('ice_caller'), 'child_added', snap => addIce(call, snap.val()));
  watchCommon(call);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(incoming.offer));
    flushIce(call);
    pc.getTransceivers().forEach(t => {
      if (t.receiver.track.kind === 'video' && t.direction === 'recvonly') t.direction = 'sendrecv';
    });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await callRef(call).child('answer').set({ sdp: answer.sdp, type: answer.type });
    await callRef(call).child('status').set('active');
  } catch (e) {
    toast('Звонок', 'Не удалось принять звонок', 'error');
    endCall();
    return;
  }
  publishVideoState(call);
  syncLocalPreview();
  listen(call, callRef(call).child('status'), 'value', snap => {
    const s = snap.val();
    if (state.call !== call || (s !== null && s !== 'ended')) return;
    toast('Звонок', 'Завершён');
    endCall();
  });
}

export function rejectCall() {
  const incoming = state.incoming;
  if (!incoming) return;
  clearTimeout(incoming.timeout);
  state.incoming = null;
  $('incoming-call').classList.add('hidden');
  const ref = db.ref('calls/' + state.me.uid + '/' + incoming.id);
  ref.child('status').set('rejected').then(() => setTimeout(() => ref.remove().catch(() => {}), 3000)).catch(() => {});
}

export function endCall() {
  const call = state.call;
  if (!call || call.ended) return;
  call.ended = true;
  state.call = null;
  Object.values(call.timers).forEach(t => { clearTimeout(t); clearInterval(t); });
  call.listeners.forEach(({ ref, event, fn }) => ref.off(event, fn));
  callRef(call).remove().catch(() => {});
  call.local?.getTracks().forEach(t => t.stop());
  call.screen?.getTracks().forEach(t => t.stop());
  call.camTrack?.stop();
  call.pc?.close();
  stopMeters(call);
  for (const id of ['remote-audio', 'remote-video', 'local-video', 'dock-video']) $(id).srcObject = null;
  $('call-dock').classList.add('hidden');
  $('dock-video-box').classList.add('hidden');
  $('remote-video').classList.add('hidden');
  $('local-video').classList.add('hidden');
  $('call-videos').classList.add('hidden');
  $('call-overlay').classList.add('hidden');
}

export function toggleMute() {
  const call = state.call;
  if (!call) return;
  call.muted = !call.muted;
  call.local?.getAudioTracks().forEach(t => { t.enabled = !call.muted; });
  syncControls();
}

async function swapVideo(call) {
  const sender = videoSender(call);
  if (!sender) return;
  const track = call.screenOn ? call.screen.getVideoTracks()[0] : call.cam ? call.camTrack : null;
  await sender.replaceTrack(track);
  syncLocalPreview();
  syncControls();
  publishVideoState(call);
}

export async function toggleCamera() {
  const call = state.call;
  if (!call?.pc) return;
  if (call.cam) {
    call.cam = false;
    call.camTrack?.stop();
    call.camTrack = null;
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (state.call !== call) { stream.getTracks().forEach(t => t.stop()); return; }
      call.camTrack = stream.getVideoTracks()[0];
      call.cam = true;
    } catch {
      toast('Ошибка', 'Нет доступа к камере', 'error');
      return;
    }
  }
  await swapVideo(call);
}

export async function toggleScreen() {
  const call = state.call;
  if (!call?.pc) return;
  if (call.screenOn) {
    call.screen.getTracks().forEach(t => t.stop());
    call.screen = null;
    call.screenOn = false;
    await swapVideo(call);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    if (state.call !== call) { stream.getTracks().forEach(t => t.stop()); return; }
    call.screen = stream;
    call.screenOn = true;
    stream.getVideoTracks()[0].onended = () => {
      if (state.call === call && call.screenOn) toggleScreen();
    };
    await swapVideo(call);
    toast('Экран', 'Демонстрация начата', 'success');
  } catch {
    toast('Ошибка', 'Нет доступа к экрану', 'error');
  }
}

export function stopCalls() {
  if (incomingRef && incomingHandlers) {
    incomingRef.off('child_added', incomingHandlers.added);
    incomingRef.off('child_removed', incomingHandlers.removed);
  }
  incomingRef = null;
  incomingHandlers = null;
  if (state.incoming) clearTimeout(state.incoming.timeout);
  state.incoming = null;
  $('incoming-call').classList.add('hidden');
}

export function listenForCalls() {
  stopCalls();
  const uid = state.me.uid;
  db.ref('.info/serverTimeOffset').once('value', offset => {
    if (!state.me || state.me.uid !== uid || incomingRef) return;
    const since = Date.now() + (offset.val() || 0) - 30000;
    incomingRef = db.ref('calls/' + uid).orderByChild('createdAt').startAt(since);
    incomingHandlers = {
      added: async snap => {
        const call = snap.val();
        if (!call || call.status !== 'pending' || !call.offer) return;
        if (state.call || state.incoming) {
          snap.ref.child('status').set('rejected').catch(() => {});
          return;
        }
        const user = await getUser(call.callerId);
        state.incoming = { id: snap.key, callerId: call.callerId, type: call.type, offer: call.offer };
        $('incoming-name').textContent = user.name;
        $('incoming-type').textContent = call.type === 'video' ? '📹 Видеозвонок' : '📞 Аудиозвонок';
        $('incoming-call').classList.remove('hidden');
        state.incoming.timeout = setTimeout(() => {
          if (state.incoming?.id !== snap.key) return;
          snap.ref.remove().catch(() => {});
          state.incoming = null;
          $('incoming-call').classList.add('hidden');
        }, 30000);
      },
      removed: snap => {
        if (state.incoming?.id !== snap.key) return;
        clearTimeout(state.incoming.timeout);
        state.incoming = null;
        $('incoming-call').classList.add('hidden');
      }
    };
    incomingRef.on('child_added', incomingHandlers.added, () => {});
    incomingRef.on('child_removed', incomingHandlers.removed, () => {});
  });
}
