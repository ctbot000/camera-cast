import { Broadcaster } from './broadcaster.js';
import { Camera, QUALITIES, cameraSupported, listCameras } from './camera.js';
import { formatCode, generateCode, isValidCode, normalizeCode, signalingOptions, watchLink } from './code.js';
import { qrSvg } from './qr.js';
import { formatBitrate, sampleStats } from './stats.js';
import { Watcher } from './watcher.js';

const $ = (id) => document.getElementById(id);
const APP_TITLE = 'Camera Cast';
const launchParams = new URLSearchParams(location.search);

let peerOptions = {};
let broadcast = null; // { camera, broadcaster, ui } while streaming
let watch = null; // { code, watcher, ui, recorder, ... } while watching

// ---------------------------------------------------------------------------
// Small helpers

// Preferences for this browser. Storage can throw (private mode, blocked site
// data), so keep the value in memory too: a write that failed must not turn
// into a different answer on the next read.
function stored(key) {
  let value;
  return {
    get() {
      if (value === undefined) {
        try {
          value = localStorage.getItem(key);
        } catch {
          value = null;
        }
      }
      return value;
    },
    set(next) {
      value = next;
      try {
        localStorage.setItem(key, next);
      } catch {
        // The memory copy is enough for this page's lifetime.
      }
    },
  };
}

// The code stays the same across visits, so viewers' links keep working.
const saved = {
  code: stored('camera-cast:code'),
  quality: stored('camera-cast:quality'),
  mic: stored('camera-cast:mic'),
  camera: stored('camera-cast:camera'),
};

let toastTimer = 0;
function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 3500);
}

function showError(id, message) {
  const element = $(id);
  element.textContent = message;
  element.hidden = !message;
}

function setPill(pill, state, text) {
  pill.dataset.state = state;
  pill.querySelector('.pill-text').textContent = text;
}

function setPressed(button, pressed, label) {
  button.setAttribute('aria-pressed', String(pressed));
  if (label) {
    button.title = label;
    button.querySelector('.visually-hidden').textContent = label;
  }
}

function describeMediaError(error, device = 'camera') {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Permission to use the ${device} was denied. Allow it in the browser's site settings and try again.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${device} was found on this device.`;
    case 'NotReadableError':
    case 'AbortError':
      return `The ${device} is being used by another app, or could not be started.`;
    default:
      return error?.message || `The ${device} could not be started.`;
  }
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context and permission; fall back to selecting.
    input.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

// Keep the screen on while streaming or watching.
const wake = { want: false, lock: null };
async function keepAwake(on) {
  wake.want = on;
  if (!on) {
    const lock = wake.lock;
    wake.lock = null;
    await lock?.release().catch(() => {});
    return;
  }
  if (wake.lock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!wake.want) {
      lock.release().catch(() => {});
      return;
    }
    wake.lock = lock;
    lock.addEventListener('release', () => {
      if (wake.lock === lock) wake.lock = null;
    });
  } catch {
    // Denied (battery saver, unsupported): the stream works regardless.
  }
}
document.addEventListener('visibilitychange', () => {
  if (wake.want && document.visibilityState === 'visible') keepAwake(true);
});

// ---------------------------------------------------------------------------
// Navigation. Home is the bare URL, watching is ?watch=CODE (so the address is
// the share link), and streaming is a history entry on the home URL, so the
// Back button stops it.

function appUrl(extra = {}) {
  const url = new URL(location.href);
  url.hash = '';
  url.searchParams.delete('watch');
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.href;
}

function goHome() {
  if (history.state?.screen) history.back();
  else {
    history.replaceState(null, '', appUrl());
    render();
  }
}

function showScreen(name) {
  for (const screen of document.querySelectorAll('.screen')) screen.hidden = screen.id !== name;
  document.body.dataset.screen = name;
}

function render() {
  const query = new URLSearchParams(location.search);
  if (query.has('watch')) {
    const code = normalizeCode(query.get('watch'));
    if (isValidCode(code)) {
      closeBroadcast();
      openWatch(code);
      return;
    }
    closeAll();
    showHome();
    $('watch-code').value = query.get('watch');
    showError('watch-error', 'That camera code is not valid. Codes have 8 letters and digits, like ABCD-2345.');
    return;
  }
  if (history.state?.screen === 'broadcast' && broadcast) {
    showScreen('broadcast');
    return;
  }
  closeAll();
  showHome();
}

function closeAll() {
  closeBroadcast();
  closeWatch();
}

window.addEventListener('popstate', render);

// Leaving the page: close connections now, so viewers and the signaling server
// hear about it immediately instead of after a timeout.
window.addEventListener('pagehide', () => {
  closeBroadcast({ graceful: false });
  closeWatch();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});

// ---------------------------------------------------------------------------
// Home

function fillQualityOptions(select, selected) {
  select.replaceChildren(
    ...Object.entries(QUALITIES).map(([value, { label }]) => new Option(label, value, false, value === selected)),
  );
}

function showHome() {
  showScreen('home');
  document.title = APP_TITLE;
}

function setUpHome() {
  const quality = QUALITIES[saved.quality.get()] ? saved.quality.get() : 'medium';
  fillQualityOptions($('start-quality'), quality);
  $('start-mic').checked = saved.mic.get() === '1';

  if (!cameraSupported()) {
    $('start-camera').disabled = true;
    showError(
      'broadcast-error',
      window.isSecureContext
        ? 'This browser cannot access cameras.'
        : 'Sharing a camera needs a secure page (https, or localhost). You can still watch from here.',
    );
  }

  $('broadcast-form').addEventListener('submit', (event) => {
    event.preventDefault();
    startBroadcast();
  });

  $('watch-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = normalizeCode($('watch-code').value);
    if (!isValidCode(code)) {
      showError('watch-error', 'Enter the 8-character code shown on the camera, like ABCD-2345.');
      $('watch-code').focus();
      return;
    }
    showError('watch-error', '');
    history.pushState({ screen: 'watch' }, '', appUrl({ watch: code }));
    render();
  });

  $('watch-code').addEventListener('input', () => showError('watch-error', ''));

  $('brand').addEventListener('click', (event) => {
    event.preventDefault();
    if (broadcast && broadcast.broadcaster?.viewerCount > 0 && !confirm('Stop streaming to your viewers?')) return;
    if (document.body.dataset.screen !== 'home') goHome();
  });
}

// ---------------------------------------------------------------------------
// Broadcasting

async function startBroadcast() {
  if (broadcast) return;
  showError('broadcast-error', '');
  const button = $('start-camera');
  const label = button.querySelector('span');
  button.disabled = true;
  label.textContent = 'Starting camera…';

  const quality = $('start-quality').value;
  const mic = $('start-mic').checked;
  saved.quality.set(quality);
  saved.mic.set(mic ? '1' : '0');

  const camera = new Camera();
  const warnings = [];
  camera.addEventListener('warning', (event) => warnings.push(event.detail.message));
  try {
    await camera.start({ quality, mic, deviceId: saved.camera.get() });
  } catch (error) {
    camera.stop();
    showError('broadcast-error', describeMediaError(error));
    return;
  } finally {
    button.disabled = false;
    label.textContent = 'Start camera';
  }

  let code = saved.code.get();
  if (!code || !isValidCode(code)) {
    code = generateCode();
    saved.code.set(code);
  }
  history.pushState({ screen: 'broadcast' }, '', appUrl());
  openBroadcast(camera, code);
  for (const message of warnings) toast(message);
}

function openBroadcast(camera, code) {
  const ui = new AbortController();
  const { signal } = ui;
  broadcast = { camera, broadcaster: null, ui };
  showScreen('broadcast');

  camera.addEventListener('trackchange', renderCamera, { signal });
  camera.addEventListener('settingschange', renderCamera, { signal });
  camera.addEventListener('warning', (event) => toast(event.detail.message), { signal });
  camera.addEventListener('trackended', (event) => onTrackEnded(event.detail.kind), { signal });
  $('broadcast-video').addEventListener('resize', fitBroadcastStage, { signal });
  $('broadcast-video').addEventListener('loadedmetadata', fitBroadcastStage, { signal });
  navigator.mediaDevices?.addEventListener('devicechange', fillCameraOptions, { signal });

  fillQualityOptions($('quality-select'), camera.quality);
  renderCamera();
  fillCameraOptions();
  startBroadcaster(code);
  keepAwake(true);
}

function startBroadcaster(code) {
  const { camera, ui } = broadcast;
  const broadcaster = new Broadcaster({ code, camera, peerOptions });
  broadcast.broadcaster = broadcaster;
  broadcaster.addEventListener('status', (event) => renderBroadcastStatus(event.detail), { signal: ui.signal });
  broadcaster.addEventListener('viewers', (event) => renderViewers(event.detail.count), { signal: ui.signal });
  renderShare(code);
  renderViewers(0);
  broadcaster.start();
}

function closeBroadcast({ graceful = true } = {}) {
  if (!broadcast) return;
  const { camera, broadcaster, ui } = broadcast;
  broadcast = null;
  ui.abort();
  broadcaster?.stop({ graceful });
  camera.stop();
  $('broadcast-video').srcObject = null;
  $('camera-note').hidden = true;
  keepAwake(false);
  document.title = APP_TITLE;
}

function rotateCode() {
  if (!broadcast) return;
  const code = generateCode();
  saved.code.set(code);
  broadcast.broadcaster.stop();
  startBroadcaster(code);
  toast(`New camera code: ${formatCode(code)}`);
}

const BROADCAST_STATUS = {
  idle: 'Stopped',
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  'id-taken': 'Code in use',
  error: 'Offline',
};

function renderBroadcastStatus({ state, message }) {
  setPill($('broadcast-status'), state, BROADCAST_STATUS[state] ?? state);
  const alert = $('broadcast-alert');
  let text = '';
  if (state === 'id-taken') text = `${message} Retrying… Or switch this camera to a new code.`;
  else if (state === 'error') text = message;
  else if (state === 'reconnecting') text = 'Reconnecting to the signaling server. People already watching are not affected; new viewers can join once it is back.';
  alert.hidden = !text;
  alert.classList.toggle('error', state === 'error');
  $('broadcast-alert-text').textContent = text;
  $('alert-new-code').hidden = state !== 'id-taken';
  renderBroadcastTitle();
}

function renderViewers(count) {
  $('viewer-count').textContent = String(count);
  renderBroadcastTitle();
}

function renderBroadcastTitle() {
  const broadcaster = broadcast?.broadcaster;
  if (!broadcaster) return;
  const count = broadcaster.viewerCount;
  document.title =
    broadcaster.state === 'live'
      ? `● Live${count ? ` · ${count} watching` : ''} · ${APP_TITLE}`
      : `${BROADCAST_STATUS[broadcaster.state] ?? ''} · ${APP_TITLE}`;
}

function renderShare(code) {
  const link = watchLink(appUrl(), code, launchParams);
  $('camera-code').textContent = formatCode(code);
  $('share-link').value = link;
  $('qr').innerHTML = qrSvg(link);
  $('qr').title = link;
}

function renderCamera() {
  if (!broadcast) return;
  const { camera } = broadcast;
  const video = $('broadcast-video');
  const track = camera.videoTrack;
  if (video.srcObject?.getVideoTracks()[0] !== track) {
    video.srcObject = track ? new MediaStream([track]) : null;
    video.play()?.catch(() => {});
  }
  const settings = camera.settings;
  $('broadcast-stage').classList.toggle('mirror', settings.facingMode === 'user');
  setPressed($('toggle-mic'), camera.micOn, camera.micOn ? 'Turn microphone off' : 'Turn microphone on');
  const details = [];
  if (settings.width && settings.height) details.push(`${settings.width}×${settings.height}`);
  if (settings.frameRate) details.push(`${Math.round(settings.frameRate)} fps`);
  details.push(camera.micOn ? 'microphone on' : 'microphone off');
  $('camera-info').textContent = `Sending ${details.join(' · ')}`;
  $('quality-select').value = camera.quality;
  const select = $('camera-select');
  if ([...select.options].some((option) => option.value === settings.deviceId)) select.value = settings.deviceId;
  if (settings.deviceId) saved.camera.set(settings.deviceId);
  if (track?.readyState === 'live') $('camera-note').hidden = true;
}

function fitBroadcastStage() {
  const video = $('broadcast-video');
  if (video.videoWidth && video.videoHeight) {
    $('broadcast-stage').style.setProperty('--ratio', (video.videoWidth / video.videoHeight).toFixed(4));
  }
}

async function fillCameraOptions() {
  if (!broadcast) return;
  const cameras = await listCameras().catch(() => []);
  if (!broadcast) return;
  const current = broadcast.camera.settings.deviceId;
  const select = $('camera-select');
  select.replaceChildren(
    ...cameras.map((camera, index) => new Option(camera.label || `Camera ${index + 1}`, camera.deviceId, false, camera.deviceId === current)),
  );
  if (!cameras.length) select.append(new Option('Default camera', '', true, true));
  select.disabled = cameras.length < 2;
  $('switch-camera').hidden = cameras.length < 2;
}

async function onTrackEnded(kind) {
  if (!broadcast) return;
  if (kind === 'audio') {
    toast('The microphone stopped.');
    return;
  }
  $('camera-note-text').textContent = 'The camera stopped. It may have been disconnected or taken by another app.';
  $('camera-note').hidden = false;
}

async function withBusy(button, action) {
  button.disabled = true;
  try {
    await action();
  } finally {
    button.disabled = false;
  }
}

function setUpBroadcastControls() {
  $('toggle-mic').addEventListener('click', (event) =>
    withBusy(event.currentTarget, async () => {
      if (!broadcast) return;
      const on = !broadcast.camera.micOn;
      try {
        await broadcast.camera.setMic(on);
        saved.mic.set(on ? '1' : '0');
      } catch (error) {
        toast(describeMediaError(error, 'microphone'));
      }
    }),
  );

  $('switch-camera').addEventListener('click', (event) =>
    withBusy(event.currentTarget, async () => {
      try {
        await broadcast?.camera.switchCamera();
      } catch (error) {
        toast(describeMediaError(error));
      }
    }),
  );

  $('camera-select').addEventListener('change', async (event) => {
    const deviceId = event.currentTarget.value;
    if (!broadcast || !deviceId) return;
    try {
      await broadcast.camera.useCamera({ deviceId });
    } catch (error) {
      toast(describeMediaError(error));
    }
  });

  $('quality-select').addEventListener('change', async (event) => {
    const quality = event.currentTarget.value;
    saved.quality.set(quality);
    try {
      await broadcast?.camera.setQuality(quality);
    } catch {
      toast('This camera does not support that quality.');
    }
  });

  $('restart-camera').addEventListener('click', (event) =>
    withBusy(event.currentTarget, async () => {
      try {
        await broadcast?.camera.restartVideo();
      } catch (error) {
        $('camera-note-text').textContent = describeMediaError(error);
      }
    }),
  );

  $('stop-broadcast').addEventListener('click', () => goHome());

  $('copy-link').addEventListener('click', async () => {
    const input = $('share-link');
    const copied = await copyText(input.value, input);
    toast(copied ? 'Link copied' : 'Select the link and copy it');
  });

  if (navigator.share) {
    $('share-native').hidden = false;
    $('share-native').addEventListener('click', () => {
      navigator
        .share({ title: APP_TITLE, text: 'Watch my camera live', url: $('share-link').value })
        .catch(() => {});
    });
  }

  $('new-code').addEventListener('click', () => {
    const viewers = broadcast?.broadcaster?.viewerCount ?? 0;
    if (viewers > 0 && !confirm(`Disconnect ${viewers === 1 ? 'the viewer' : `all ${viewers} viewers`} and switch to a new code?`)) return;
    rotateCode();
  });
  $('alert-new-code').addEventListener('click', rotateCode);
}

// ---------------------------------------------------------------------------
// Watching

const WATCH_STATUS = {
  idle: { pill: 'Stopped', title: 'Stopped', message: '' },
  connecting: { pill: 'Connecting…', title: 'Connecting…', message: 'Looking for the camera.' },
  offline: {
    pill: 'Offline',
    title: 'The camera is offline',
    message: 'This page connects by itself as soon as the camera starts streaming.',
  },
  live: { pill: 'Live' },
  reconnecting: { pill: 'Reconnecting…', title: 'Reconnecting…', message: 'The connection dropped. Trying again…' },
  ended: {
    pill: 'Ended',
    title: 'The stream ended',
    message: 'The camera stopped streaming. This page reconnects if it starts again.',
  },
  error: { pill: 'Error', title: 'This stream cannot play here', message: '' },
};

function openWatch(code) {
  if (watch?.code === code) {
    showScreen('watch');
    return;
  }
  closeWatch();
  const ui = new AbortController();
  const { signal } = ui;
  const watcher = new Watcher({ code, peerOptions });
  watch = { code, watcher, ui, recorder: null, statsTimer: 0, previousStats: null, soundWanted: false };
  showScreen('watch');
  $('watch-code-label').textContent = formatCode(code);
  $('watch-stage').classList.remove('fill', 'idle');
  setPressed($('fit'), false);
  setPressed($('stats-toggle'), false);
  $('stats').hidden = true;
  renderRemoteState({ mic: false });

  watcher.addEventListener('status', (event) => renderWatchStatus(event.detail), { signal });
  watcher.addEventListener('stream', (event) => setWatchStream(event.detail.stream), { signal });
  watcher.addEventListener('remotestate', (event) => renderRemoteState(event.detail), { signal });
  watcher.start();
  keepAwake(true);
}

function closeWatch() {
  if (!watch) return;
  const current = watch;
  current.recorder?.stop();
  clearInterval(current.statsTimer);
  current.ui.abort();
  current.watcher.stop();
  watch = null;
  const video = $('watch-video');
  video.srcObject = null;
  video.muted = true;
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('play-button').hidden = true;
  keepAwake(false);
  document.title = APP_TITLE;
}

function renderWatchStatus({ state, message }) {
  const info = WATCH_STATUS[state] ?? WATCH_STATUS.connecting;
  setPill($('watch-status'), state, info.pill);
  const overlay = $('watch-overlay');
  overlay.hidden = state === 'live';
  overlay.dataset.state = state;
  if (state !== 'live') {
    $('watch-title').textContent = info.title;
    $('watch-message').textContent = message || info.message;
    $('watch-stage').classList.remove('idle');
  }
  $('watch-home').hidden = state !== 'error';
  const live = state === 'live';
  for (const id of ['snapshot', 'record', 'pip']) $(id).disabled = !live && !(id === 'record' && watch?.recorder);
  document.title = live ? `Watching ${formatCode(watch.code)} · ${APP_TITLE}` : `${info.pill} · ${APP_TITLE}`;
}

function setWatchStream(stream) {
  const video = $('watch-video');
  if (!stream) {
    watch?.recorder?.stop();
    video.srcObject = null;
    $('play-button').hidden = true;
    return;
  }
  video.srcObject = stream;
  // Autoplay allows sound only after the user has interacted with the page;
  // the button that asked for sound counts, so honour it across reconnects.
  video.muted = !watch.soundWanted;
  playWatchVideo();
}

function playWatchVideo() {
  const video = $('watch-video');
  video
    .play()
    .then(() => {
      $('play-button').hidden = true;
      renderSound();
    })
    .catch(() => {
      if (!video.muted) {
        // Sound was refused; muted playback is always allowed.
        video.muted = true;
        renderSound();
        playWatchVideo();
        return;
      }
      $('play-button').hidden = false;
    });
}

function renderRemoteState({ mic }) {
  const button = $('toggle-sound');
  const wasOff = button.dataset.remoteMic !== 'on';
  button.dataset.remoteMic = mic ? 'on' : 'off';
  if (mic && wasOff && watch && !watch.soundWanted && watch.watcher.state === 'live') {
    toast('The camera turned its microphone on. Tap the speaker to listen.');
  }
  renderSound();
}

function renderSound() {
  const button = $('toggle-sound');
  const video = $('watch-video');
  const remoteMic = button.dataset.remoteMic === 'on';
  const on = remoteMic && !video.muted;
  button.disabled = !remoteMic;
  setPressed(button, on, !remoteMic ? 'The camera’s microphone is off' : on ? 'Mute' : 'Unmute');
}

function renderStats(summary) {
  const rows = [
    ['Resolution', summary.resolution],
    ['Frame rate', summary.fps != null ? `${summary.fps} fps` : '—'],
    ['Bitrate', formatBitrate(summary.bitrate)],
    ['Codec', summary.codec.toUpperCase()],
    ['Round trip', summary.rtt != null ? `${summary.rtt} ms` : '—'],
    ['Route', summary.route],
    ['Packets lost', String(summary.packetsLost)],
  ];
  $('stats').textContent = rows.map(([label, value]) => `${label.padEnd(13)}${value}`).join('\n');
}

async function refreshStats() {
  const pc = watch?.watcher.peerConnection;
  if (!pc) {
    $('stats').textContent = 'Waiting for the stream…';
    return;
  }
  try {
    const result = await sampleStats(pc, watch.previousStats);
    if (!watch) return;
    watch.previousStats = result;
    renderStats(result.summary);
  } catch {
    // The connection closed between the check and the read.
  }
}

function toggleRecording() {
  if (!watch) return;
  if (watch.recorder) {
    watch.recorder.stop();
    return;
  }
  const stream = $('watch-video').srcObject;
  if (!stream) return;
  if (typeof MediaRecorder === 'undefined') {
    toast('This browser cannot record video.');
    return;
  }
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    toast('This browser cannot record this stream.');
    return;
  }
  const session = watch;
  const chunks = [];
  const started = new Date();
  const button = $('record');
  const indicator = $('rec-indicator');
  const tick = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    $('rec-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const timer = setInterval(tick, 1000);
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener('stop', () => {
    clearInterval(timer);
    if (session.recorder === recorder) session.recorder = null;
    if (watch === session) {
      setPressed(button, false, 'Record');
      indicator.hidden = true;
      button.disabled = session.watcher.state !== 'live';
    }
    if (!chunks.length) return;
    const type = recorder.mimeType || mimeType || 'video/webm';
    download(new Blob(chunks, { type }), `camera-cast_${timestamp(started)}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
    toast('Recording saved');
  });
  recorder.start(1000);
  session.recorder = recorder;
  tick();
  indicator.hidden = false;
  setPressed(button, true, 'Stop recording');
}

function takeSnapshot() {
  const video = $('watch-video');
  if (!video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) return;
    download(blob, `camera-cast_${timestamp()}.png`);
    toast('Snapshot saved');
  }, 'image/png');
}

function setUpWatchControls() {
  const stage = $('watch-stage');
  const video = $('watch-video');

  $('toggle-sound').addEventListener('click', () => {
    if (!watch) return;
    video.muted = !video.muted;
    watch.soundWanted = !video.muted;
    if (!video.muted) playWatchVideo();
    renderSound();
  });
  $('play-button').addEventListener('click', () => playWatchVideo());
  $('snapshot').addEventListener('click', takeSnapshot);
  $('record').addEventListener('click', toggleRecording);

  $('fit').addEventListener('click', (event) => {
    const fill = stage.classList.toggle('fill');
    setPressed(event.currentTarget, fill, fill ? 'Fit the whole picture' : 'Fill the screen');
  });

  $('stats-toggle').addEventListener('click', (event) => {
    if (!watch) return;
    const show = $('stats').hidden;
    $('stats').hidden = !show;
    setPressed(event.currentTarget, show);
    clearInterval(watch.statsTimer);
    watch.previousStats = null;
    if (show) {
      refreshStats();
      watch.statsTimer = setInterval(refreshStats, 1000);
    }
  });

  if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
    $('pip').hidden = false;
    $('pip').addEventListener('click', () => {
      const request = document.pictureInPictureElement
        ? document.exitPictureInPicture()
        : video.requestPictureInPicture();
      request.catch(() => toast('Picture in picture is not available right now.'));
    });
  }

  // iPhone Safari has no element fullscreen, only its own video player.
  const canFullscreen = document.fullscreenEnabled || typeof video.webkitEnterFullscreen === 'function';
  $('fullscreen').hidden = !canFullscreen;
  $('fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.fullscreenEnabled) stage.requestFullscreen().catch(() => {});
    else video.webkitEnterFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement === stage;
    setPressed($('fullscreen'), on, on ? 'Exit full screen' : 'Full screen');
  });

  $('leave').addEventListener('click', () => goHome());
  $('watch-home').addEventListener('click', () => goHome());

  // Controls fade out while the stream plays untouched. When hidden they take
  // no clicks, so the first tap only brings them back.
  let idleTimer = 0;
  const wakeControls = () => {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (watch?.watcher.state === 'live' && !stage.matches(':focus-within')) stage.classList.add('idle');
    }, 3000);
  };
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'focusin']) stage.addEventListener(type, wakeControls);
}

// ---------------------------------------------------------------------------

function init() {
  if (typeof window.Peer !== 'function') {
    showHome();
    showError('broadcast-error', 'The connection library failed to load. Check your network and reload the page.');
    $('start-camera').disabled = true;
    $('watch-button').disabled = true;
    return;
  }
  try {
    peerOptions = signalingOptions(launchParams);
  } catch (error) {
    peerOptions = {};
    toast(`${error.message} Using the default server.`);
  }
  setUpHome();
  setUpBroadcastControls();
  setUpWatchControls();
  render();
}

// Handles for debugging from the console and for the end-to-end tests.
window.cameraCast = {
  get camera() {
    return broadcast?.camera ?? null;
  },
  get broadcaster() {
    return broadcast?.broadcaster ?? null;
  },
  get watcher() {
    return watch?.watcher ?? null;
  },
};

init();
