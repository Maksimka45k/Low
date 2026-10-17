import { db, TS } from './firebase.js';
import { state } from './state.js';
import { ICE_SERVERS, LIMITS } from './config.js';
import { $, toast, getUser, initials, userColor } from './util.js';
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

function startTimer(call) {
  if (call.timers.tick) return;
  clearTimeout(call.timers.ring);
  call.accepted = true;
  let seconds = 0;
  call.timers.tick = setInterval(() => {
    seconds++;
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    $('call-status').textContent = (call.type === 'video' ? 'ВИДЕО' : 'ЗВОНОК') + ' • ' + mm + ':' + ss;
  }, 1000);
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
  $('call-status').textContent = call.role === 'caller' ? 'ВЫЗОВ...' : 'СОЕДИНЕНИЕ...';
  $('remote-label').textContent = user.name;
  const rp = $('remote-placeholder');
  rp.style.background = userColor(user);
  rp.textContent = initials(user.name);
  const lp = $('local-placeholder');
  lp.style.background = userColor(state.me);
  lp.textContent = initials(state.me.name);
  $('remote-audio').srcObject = call.remote;
  $('remote-video').srcObject = call.remote;
  $('mute-button').textContent = '🎤';
  $('mute-button').classList.remove('danger');
  $('call-overlay').classList.remove('hidden');
  $('call-overlay').addEventListener('click', () => $('remote-audio').play().catch(() => {}), { once: true });
  syncLocalPreview();
}

function watchCommon(call) {
  listen(call, callRef(call).child('video_' + otherRole(call)), 'value', snap => {
    call.peerVideo = !!snap.val();
    syncLayout();
  });
}

export async function startCall(type) {
  const chat = state.chat;
  if (!chat || chat.type !== 'dm' || state.call || state.incoming) return;
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
  for (const id of ['remote-audio', 'remote-video', 'local-video']) $(id).srcObject = null;
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
  $('mute-button').textContent = call.muted ? '🔇' : '🎤';
  $('mute-button').classList.toggle('danger', call.muted);
}

async function swapVideo(call) {
  const sender = videoSender(call);
  if (!sender) return;
  const track = call.screenOn ? call.screen.getVideoTracks()[0] : call.cam ? call.camTrack : null;
  await sender.replaceTrack(track);
  syncLocalPreview();
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
