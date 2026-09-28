// The sending side. Registers the camera's code with the signaling server and
// calls every viewer that opens a data connection to it. The data connection
// carries control messages and a heartbeat; the media goes over a PeerJS call.
//
// Events: `status` ({ state, message }) and `viewers` ({ count }).
// States: connecting, live, reconnecting, id-taken, error.

import { peerIdFor } from './code.js';

const HEARTBEAT_MS = 2000;
const VIEWER_TIMEOUT_MS = 10000;
const MAX_RETRY_MS = 15000;
const RECONNECT_CONFIRM_MS = 5000;

export class Broadcaster extends EventTarget {
  state = 'idle';
  #peer = null;
  #viewers = new Map();
  #camera;
  #options;
  #listeners = new AbortController();
  #heartbeat = 0;
  #retryTimer = 0;
  #retryDelay = 1000;
  #stopped = false;

  constructor({ code, camera, peerOptions }) {
    super();
    this.code = code;
    this.#camera = camera;
    this.#options = peerOptions;
    const { signal } = this.#listeners;
    camera.addEventListener('trackchange', (event) => this.#replaceTrack(event.detail.kind), { signal });
  }

  get viewerCount() {
    return this.#viewers.size;
  }

  start() {
    this.#stopped = false;
    this.#heartbeat = setInterval(() => this.#tick(), HEARTBEAT_MS);
    this.#connect();
  }

  // With `graceful`, viewers get a moment to receive the goodbye before the
  // connections close; without it (page unload) everything closes at once.
  stop({ graceful = true } = {}) {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#listeners.abort();
    clearInterval(this.#heartbeat);
    clearTimeout(this.#retryTimer);
    const viewers = [...this.#viewers.values()];
    for (const viewer of viewers) {
      viewer.closed = true;
      send(viewer.conn, { type: 'bye' });
    }
    this.#viewers.clear();
    const peer = this.#peer;
    this.#peer = null;
    // Leave the signaling server now, so a restart can claim the code at once;
    // the viewers' connections are peer-to-peer and outlive this.
    if (peer && !peer.disconnected) peer.disconnect();
    const close = () => {
      for (const viewer of viewers) closeViewer(viewer);
      peer?.destroy();
    };
    if (graceful && viewers.length) setTimeout(close, 300);
    else close();
    this.#setStatus('idle');
  }

  // Tell viewers whether the microphone is on, so they can offer to unmute.
  #stateMessage() {
    return { mic: this.#camera.micOn };
  }

  #connect() {
    this.#setStatus(this.state === 'idle' ? 'connecting' : this.state);
    const peer = new Peer(peerIdFor(this.code), this.#options);
    this.#peer = peer;
    peer.on('open', () => {
      if (peer !== this.#peer) return;
      this.#retryDelay = 1000;
      this.#setStatus('live');
    });
    peer.on('connection', (conn) => this.#addViewer(conn));
    // Viewers only receive; nothing should ever call us.
    peer.on('call', (call) => call.close());
    // `disconnected`: the signaling socket dropped but the peer can reconnect.
    // `close`: the peer was destroyed and has to be created again. Either way,
    // viewers already watching are unaffected; only new viewers have to wait.
    peer.on('disconnected', () => this.#recover(peer));
    peer.on('close', () => this.#recover(peer));
    peer.on('error', (error) => this.#onError(peer, error));
  }

  #recover(peer) {
    if (this.#stopped || peer !== this.#peer) return;
    if (this.state !== 'id-taken') this.#setStatus('reconnecting');
    // A destroy emits `disconnected` and then `close`; one pending retry covers
    // both, and it looks at the peer when it fires to pick the right repair.
    if (this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = 0;
      if (this.#stopped || peer !== this.#peer) return;
      if (peer.destroyed) this.#connect();
      else if (peer.disconnected) {
        peer.reconnect();
        this.#confirmReconnect(peer);
      }
    }, this.#retryDelay);
    this.#retryDelay = Math.min(this.#retryDelay * 2, MAX_RETRY_MS);
  }

  // PeerServer confirms a reconnect with OPEN only if it had already dropped
  // the old socket. If it had not (the network died without closing it), it
  // silently moves the session to the new socket: signaling works, but `open`
  // never fires. Recognise that by the socket being open with no error; if the
  // socket is not open either, start over with a fresh peer.
  #confirmReconnect(peer) {
    setTimeout(() => {
      if (this.#stopped || peer !== this.#peer || peer.open || peer.disconnected || peer.destroyed) return;
      if (peer.socket?._wsOpen?.()) {
        this.#retryDelay = 1000;
        this.#setStatus('live');
      } else {
        peer.destroy();
      }
    }, RECONNECT_CONFIRM_MS);
  }

  #onError(peer, error) {
    if (this.#stopped || peer !== this.#peer) return;
    switch (error.type) {
      case 'unavailable-id':
        // Someone else holds this code: another tab or device, a stop that the
        // server has not processed yet, or a session whose connection died
        // without closing (the server drops those within about 90 s). The peer
        // is destroyed next, and `close` schedules the retry.
        this.#setStatus('id-taken', 'This camera code is in use in another tab or on another device, or by a session that has not timed out yet.');
        break;
      case 'browser-incompatible':
        this.#fail('This browser does not support WebRTC.');
        break;
      case 'invalid-id':
      case 'invalid-key':
      case 'ssl-unavailable':
        this.#fail(`The signaling server refused the connection (${error.type}).`);
        break;
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        // The matching disconnected/close event drives the retry.
        if (this.state !== 'id-taken') this.#setStatus('reconnecting', 'Cannot reach the signaling server. Retrying…');
        break;
      default:
      // peer-unavailable, webrtc, disconnected: about one viewer's connection,
      // which cleans itself up through its own close event.
    }
  }

  #fail(message) {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = 0;
    const peer = this.#peer;
    this.#peer = null;
    peer?.destroy();
    this.#setStatus('error', message);
  }

  #addViewer(conn) {
    const viewer = { id: conn.peer, conn, call: null, lastSeen: Date.now(), closed: false };
    conn.on('open', () => {
      if (this.#stopped) {
        conn.close();
        return;
      }
      const previous = this.#viewers.get(viewer.id);
      if (previous) this.#dropViewer(previous);
      this.#viewers.set(viewer.id, viewer);
      viewer.lastSeen = Date.now();
      send(conn, { type: 'hello', ...this.#stateMessage() });
      this.#call(viewer);
      this.#emitViewers();
    });
    conn.on('data', (message) => {
      viewer.lastSeen = Date.now();
      if (message?.type === 'bye') this.#dropViewer(viewer);
    });
    conn.on('close', () => this.#dropViewer(viewer));
    conn.on('error', () => this.#dropViewer(viewer));
  }

  #call(viewer) {
    if (viewer.closed) return;
    const previous = viewer.call;
    viewer.call = null;
    previous?.close();
    const call = this.#peer?.call(viewer.id, this.#camera.stream);
    if (!call) {
      // Signaling is down right now; the viewer will time out and dial again.
      this.#dropViewer(viewer);
      return;
    }
    viewer.call = call;
    const lost = () => {
      if (viewer.call === call) this.#dropViewer(viewer);
    };
    call.on('close', lost);
    call.on('error', lost);
  }

  #dropViewer(viewer) {
    if (viewer.closed) return;
    viewer.closed = true;
    if (this.#viewers.get(viewer.id) === viewer) this.#viewers.delete(viewer.id);
    closeViewer(viewer);
    this.#emitViewers();
  }

  #replaceTrack(kind) {
    const track = kind === 'video' ? this.#camera.videoTrack : this.#camera.audioTrack;
    for (const viewer of this.#viewers.values()) {
      const transceiver = viewer.call?.peerConnection
        ?.getTransceivers()
        .find((candidate) => !candidate.stopped && candidate.receiver.track?.kind === kind);
      if (transceiver) transceiver.sender.replaceTrack(track).catch(() => this.#call(viewer));
      // The call was negotiated without this kind of track: call again.
      else if (track) this.#call(viewer);
    }
    if (kind === 'audio') {
      for (const viewer of this.#viewers.values()) send(viewer.conn, { type: 'state', ...this.#stateMessage() });
    }
  }

  #tick() {
    const now = Date.now();
    for (const viewer of [...this.#viewers.values()]) {
      if (now - viewer.lastSeen > VIEWER_TIMEOUT_MS) this.#dropViewer(viewer);
      else send(viewer.conn, { type: 'ping' });
    }
  }

  #emitViewers() {
    this.dispatchEvent(new CustomEvent('viewers', { detail: { count: this.#viewers.size } }));
  }

  #setStatus(state, message = '') {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, message } }));
  }
}

function send(conn, message) {
  if (conn?.open) conn.send(message);
}

function closeViewer(viewer) {
  const { call, conn } = viewer;
  viewer.call = null;
  call?.close();
  conn.close();
}
