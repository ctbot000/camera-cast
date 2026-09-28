// End to end: a real Chrome streams between pages through a local PeerServer.
// The camera is faked with canvases painting solid colours, so the test can
// tell from the viewer's pixels which camera it is seeing and that frames keep
// arriving, and the microphone with an oscillator. Neither touches a real
// device, so the run needs no capture permission from the operating system.
// Set CHROME_PATH if Chrome is not in a standard location.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PeerServer } from 'peer';
import puppeteer from 'puppeteer-core';
import { createStaticServer } from '../scripts/serve.mjs';

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((path) => path && existsSync(path));

// Runs in the page before any of its scripts. The back camera (the app's
// default) paints blue/yellow, the front camera red/green, alternating every
// half second. The microphone plays a steady tone.
function installFakeDevices() {
  const cameras = [
    { deviceId: 'fake-back', label: 'Fake back camera', facingMode: 'environment', colors: ['#0000ff', '#ffff00'] },
    { deviceId: 'fake-front', label: 'Fake front camera', facingMode: 'user', colors: ['#ff0000', '#00ff00'] },
  ];
  const media = navigator.mediaDevices;
  const realEnumerateDevices = media.enumerateDevices.bind(media);
  const exact = (value) => (value && typeof value === 'object' ? value.exact : undefined);
  const wanted = (value) => (value && typeof value === 'object' ? (value.exact ?? value.ideal) : value);

  function open(camera) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      context.fillStyle = camera.colors[Math.floor(frame++ / 10) % 2];
      context.fillRect(0, 0, canvas.width, canvas.height);
    };
    draw();
    const timer = setInterval(draw, 50);
    const track = canvas.captureStream(20).getVideoTracks()[0];
    const getSettings = track.getSettings.bind(track);
    track.getSettings = () => ({
      ...getSettings(),
      deviceId: camera.deviceId,
      facingMode: camera.facingMode,
      width: 640,
      height: 360,
      frameRate: 20,
    });
    const stop = track.stop.bind(track);
    track.stop = () => {
      clearInterval(timer);
      stop();
    };
    return track;
  }

  media.getUserMedia = async (constraints = {}) => {
    const tracks = [];
    if (constraints.video) {
      const video = typeof constraints.video === 'object' ? constraints.video : {};
      const byId = cameras.find((camera) => camera.deviceId === wanted(video.deviceId));
      const byFacing = cameras.find((camera) => camera.facingMode === wanted(video.facingMode));
      const camera = byId ?? byFacing ?? cameras[0];
      if ((exact(video.deviceId) && !byId) || (exact(video.facingMode) && !byFacing)) {
        throw new DOMException('No camera matches', 'OverconstrainedError');
      }
      tracks.push(open(camera));
    }
    if (constraints.audio) {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      tracks.push(destination.stream.getAudioTracks()[0]);
    }
    return new MediaStream(tracks);
  };
  media.enumerateDevices = async () => [
    ...(await realEnumerateDevices()).filter((device) => device.kind === 'audiooutput'),
    { deviceId: 'fake-mic', label: 'Fake microphone', groupId: 'fake-mic', kind: 'audioinput', toJSON() {} },
    ...cameras.map(({ deviceId, label }) => ({ deviceId, label, groupId: deviceId, kind: 'videoinput', toJSON() {} })),
  ];
}

const COLORS = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0] };

function colorName(rgb) {
  for (const [name, reference] of Object.entries(COLORS)) {
    if (reference.every((value, i) => Math.abs(value - rgb[i]) < 70)) return name;
  }
  return null;
}

let browser;
let signalServer;
let signalPort = 0;
const signalSockets = new Set();
let webServer;
let baseUrl;
let signal;
const pageErrors = [];
const state = {};

async function openPage(url, { camera = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${url}: ${error.message}`));
  if (camera) await page.evaluateOnNewDocument(installFakeDevices);
  await page.goto(url);
  return page;
}

async function click(page, selector) {
  await page.bringToFront();
  await page.click(selector);
}

function waitForState(page, id, expected, timeout = 20000) {
  return page.waitForFunction(
    (id, expected) => document.getElementById(id)?.dataset.state === expected,
    { timeout },
    id,
    expected,
  );
}

function waitForText(page, id, expected, timeout = 20000) {
  return page.waitForFunction((id, expected) => document.getElementById(id)?.textContent === expected, { timeout }, id, expected);
}

async function sampleColor(page) {
  const rgb = await page.evaluate(() => {
    const video = document.getElementById('watch-video');
    if (!video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, 0, 0, 8, 8);
    return [...context.getImageData(4, 4, 1, 1).data.slice(0, 3)];
  });
  return rgb && colorName(rgb);
}

// Seeing both colours of one camera proves frames are still arriving.
async function waitForColors(page, expected, timeout = 20000) {
  const seen = new Set();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const name = await sampleColor(page);
    if (name) seen.add(name);
    if (expected.every((color) => seen.has(color))) return;
    await delay(100);
  }
  assert.fail(`expected the viewer to show ${expected.join(' and ')}, saw ${[...seen].join(', ') || 'nothing'}`);
}

async function loudestAudio(page, milliseconds) {
  return page.evaluate(async (milliseconds) => {
    const receiver = window.cameraCast.watcher.peerConnection
      .getReceivers()
      .find((candidate) => candidate.track.kind === 'audio');
    let loudest = 0;
    const end = Date.now() + milliseconds;
    while (Date.now() < end) {
      for (const source of receiver.getSynchronizationSources()) loudest = Math.max(loudest, source.audioLevel ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return loudest;
  }, milliseconds);
}

async function startSignalServer() {
  signalServer = await new Promise((resolve) => PeerServer({ port: signalPort, host: '127.0.0.1', path: '/' }, resolve));
  signalPort = signalServer.address().port;
  signalServer.on('connection', (socket) => {
    signalSockets.add(socket);
    socket.on('close', () => signalSockets.delete(socket));
  });
}

// Upgraded WebSocket connections are invisible to closeAllConnections(), so
// track the raw sockets to take the whole server down.
async function stopSignalServer() {
  const closed = new Promise((resolve) => signalServer.close(resolve));
  for (const socket of signalSockets) socket.destroy();
  await closed;
}

before(async () => {
  assert.ok(CHROME, 'Chrome not found; set CHROME_PATH');
  await startSignalServer();
  signal = `http://127.0.0.1:${signalPort}/`;
  webServer = createStaticServer();
  await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${webServer.address().port}/`;
  const args = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-media-suspend',
  ];
  if (process.env.CI) args.push('--no-sandbox');
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args });
});

after(async () => {
  await browser?.close();
  webServer?.closeAllConnections();
  webServer?.close();
  if (signalServer) await stopSignalServer();
});

test('the camera goes live with a code and a share link', async () => {
  const page = await openPage(`${baseUrl}?signal=${encodeURIComponent(signal)}`, { camera: true });
  await click(page, '#start-camera');
  await waitForState(page, 'broadcast-status', 'live');
  const code = (await page.$eval('#camera-code', (element) => element.textContent)).replace('-', '');
  assert.match(code, /^[2-9A-HJKMNP-Z]{8}$/);
  const link = await page.$eval('#share-link', (element) => element.value);
  assert.equal(new URL(link).searchParams.get('watch'), code);
  assert.equal(new URL(link).searchParams.get('signal'), signal);
  assert.ok(await page.$eval('#qr svg', (svg) => svg.querySelector('path').getAttribute('d').length > 100));
  Object.assign(state, { camera: page, code, link });
});

test('a viewer opening the link sees the live camera', async () => {
  const viewer = await openPage(state.link);
  await waitForState(viewer, 'watch-status', 'live');
  await waitForColors(viewer, ['blue', 'yellow']);
  await waitForText(state.camera, 'viewer-count', '1');
  assert.equal(await viewer.$eval('#toggle-sound', (button) => button.disabled), true, 'no microphone yet');
  state.viewer = viewer;
});

test('switching cameras changes the picture on the same connection', async () => {
  await state.viewer.evaluate(() => {
    window.connectionBefore = window.cameraCast.watcher.peerConnection;
  });
  await click(state.camera, '#switch-camera');
  await waitForColors(state.viewer, ['red', 'green']);
  const same = await state.viewer.evaluate(() => window.cameraCast.watcher.peerConnection === window.connectionBefore);
  assert.ok(same, 'the switch should not have reconnected');
  assert.equal(await state.camera.$eval('#broadcast-stage', (stage) => stage.classList.contains('mirror')), true);
});

test('turning the microphone on reaches the viewer', async () => {
  const quiet = await loudestAudio(state.viewer, 1000);
  assert.ok(quiet < 0.01, `silence expected before the microphone is on, got level ${quiet}`);
  await click(state.camera, '#toggle-mic');
  await state.camera.waitForFunction(() => document.getElementById('toggle-mic').getAttribute('aria-pressed') === 'true');
  await state.viewer.waitForFunction(() => !document.getElementById('toggle-sound').disabled, { timeout: 10000 });
  const loud = await loudestAudio(state.viewer, 4000);
  assert.ok(loud > 0.01, `sound expected once the microphone is on, got level ${loud}`);
});

test('the viewer count follows viewers joining and leaving', async () => {
  const second = await openPage(state.link);
  await waitForState(second, 'watch-status', 'live');
  await waitForText(state.camera, 'viewer-count', '2');
  await second.browserContext().close();
  await waitForText(state.camera, 'viewer-count', '1', 15000);
});

test('a signaling outage leaves the stream playing, and the camera registers again', async () => {
  await stopSignalServer();
  await waitForState(state.camera, 'broadcast-status', 'reconnecting', 10000);
  await startSignalServer();
  await waitForState(state.camera, 'broadcast-status', 'live', 30000);
  // The viewer never needed the server to keep watching.
  assert.equal(await state.viewer.$eval('#watch-status', (element) => element.dataset.state), 'live');
  await waitForColors(state.viewer, ['red', 'green']);
  // New viewers can find the camera again.
  const late = await openPage(state.link);
  await waitForState(late, 'watch-status', 'live', 30000);
  await waitForText(state.camera, 'viewer-count', '2');
  await late.browserContext().close();
  await waitForText(state.camera, 'viewer-count', '1', 15000);
});

test('stopping tells the viewer, and restarting reconnects it with the same code', async () => {
  await click(state.camera, '#stop-broadcast');
  await waitForState(state.viewer, 'watch-status', 'ended', 10000);
  await state.camera.waitForFunction(() => !document.getElementById('home').hidden);
  await click(state.camera, '#start-camera');
  await waitForState(state.camera, 'broadcast-status', 'live');
  assert.equal((await state.camera.$eval('#camera-code', (element) => element.textContent)).replace('-', ''), state.code);
  await waitForState(state.viewer, 'watch-status', 'live', 30000);
  // The camera remembers the one it used last: the front camera, from the switch above.
  await waitForColors(state.viewer, ['red', 'green']);
});

test('a second camera claiming a live code is told so, and can move to a new code', async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`second camera: ${error.message}`));
  await page.evaluateOnNewDocument(installFakeDevices);
  await page.evaluateOnNewDocument((code) => localStorage.setItem('camera-cast:code', code), state.code);
  await page.goto(`${baseUrl}?signal=${encodeURIComponent(signal)}`);
  await click(page, '#start-camera');
  await waitForState(page, 'broadcast-status', 'id-taken');
  await page.waitForFunction(() => !document.getElementById('alert-new-code').hidden);
  await click(page, '#alert-new-code');
  await waitForState(page, 'broadcast-status', 'live');
  const code = (await page.$eval('#camera-code', (element) => element.textContent)).replace('-', '');
  assert.notEqual(code, state.code);
  await context.close();
});

test('a new code disconnects the viewers of the old one', async () => {
  state.camera.once('dialog', (dialog) => dialog.accept());
  await click(state.camera, '#new-code');
  await state.camera.waitForFunction(
    (old) => document.getElementById('camera-code').textContent.replace('-', '') !== old,
    {},
    state.code,
  );
  await waitForState(state.camera, 'broadcast-status', 'live');
  await waitForText(state.camera, 'viewer-count', '0');
  await waitForState(state.viewer, 'watch-status', 'ended', 10000);
});

test('a viewer of a camera that is not streaming waits for it', async () => {
  const page = await openPage(`${baseUrl}?watch=ZZZZ2222&signal=${encodeURIComponent(signal)}`);
  await waitForState(page, 'watch-status', 'offline');
  assert.equal(await page.$eval('#watch-title', (element) => element.textContent), 'The camera is offline');
  await page.browserContext().close();
});

test('a malformed code in the link is reported on the home screen', async () => {
  const page = await openPage(`${baseUrl}?watch=hello`);
  await page.waitForFunction(() => !document.getElementById('watch-error').hidden);
  assert.equal(await page.$eval('#home', (element) => element.hidden), false);
  await page.browserContext().close();
});

test('no page threw an uncaught error', () => {
  assert.deepEqual(pageErrors, []);
});
