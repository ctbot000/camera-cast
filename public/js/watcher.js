// The receiving side. Opens a data connection to the camera's peer id; the
// camera answers by calling back with its stream. Keeps retrying for as long
// as the page is open, so a viewer can be opened before the camera starts and
// survives the camera restarting or the network dropping.
//
// Events: `status` ({ state, message }), `stream` ({ stream|null }) and
// `remotestate` ({ mic }).
// States: connecting, offline, live, reconnecting, ended, error.

import { peerIdFor } from './code.js';

const HEARTBEAT_MS = 2000;
const SILENCE_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 20000;
const PEER_START_TIMEOUT_MS = 15000;
const OFFLINE_RETRY_MS = 3000;
const MAX_RETRY_MS = 10000;
// PeerServer holds undeliverable messages for 5 s before reporting them.
const ECHO_WINDOW_MS = 4000;

export class Watcher extends EventTarget {
  state = 'idle';
  remote = { mic: false };
  #target;
  #options;
  #peer = null;
  #peerStartedAt = 0;
  #conn = null;
  #call = null;
  #stream = null;
  #lastSeen = 0;
  #dialStartedAt = 0;
  #heartbeat = 0;
  #dialTimer = 0;
  #connectTimer = 0;
  #retryDelay = 1000;
  #stopped = false;

  constructor({ code, peerOptions }) {
    super();
    this.code = code;
    this.#target = peerIdFor(code);
    this.#options = peerOptions;
  }

  get peerConnection() {
    return this.#call?.peerConnection ?? null;
  }

  get stream() {
    return this.#stream;
  }

  start() {
    this.#stopped = false;
    this.#heartbeat = setInterval(() => this.#tick(), HEARTBEAT_MS);
    this.#setStatus('connecting');
    this.#createPeer();
  }

  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    clearTimeout(this.#dialTimer);
    clearTimeout(this.#connectTimer);
    if (this.#conn?.open) this.#conn.send({ type: 'bye' });
    this.#hangUp();
    const peer = this.#peer;
    this.#peer = null;
    peer?.destroy();
    this.#setStatus('idle');
  }

  // The viewer's own peer id is random and disposable, so a peer that loses
  // the signaling server is replaced rather than reconnected. (PeerServer can
  // accept a reconnect without ever confirming it, which would leave the peer
  // unable to tell whether it may dial.)
  #createPeer() {
    const peer = new Peer(this.#options);
    this.#peer = peer;
    this.#peerStartedAt = Date.now();
    peer.on('open', () => {
      if (peer === this.#peer && !this.#conn) this.#dial();
    });
    peer.on('call', (call) => this.#answer(call));
    peer.on('connection', (conn) => conn.close());
    peer.on('disconnected', () => this.#signalingLost(peer));
    peer.on('close', () => this.#signalingLost(peer));
    peer.on('error', (error) => this.#onError(peer, error));
  }

  #replacePeer() {
    const old = this.#peer;
    this.#peer = null;
    old?.destroy();
    this.#createPeer();
  }

  // Signaling only matters for finding the camera; a stream that is playing
  // keeps flowing without it, and the next dial brings a fresh peer. A dial
  // still in progress needs it, though, so start that one again.
  #signalingLost(peer) {
    if (this.#stopped || peer !== this.#peer || this.#stream) return;
    this.#hangUp();
    if (!this.#dialTimer) this.#scheduleDial(this.#nextDelay());
  }

  #onError(peer, error) {
    if (this.#stopped || peer !== this.#peer) return;
    switch (error.type) {
      case 'peer-unavailable':
        // The server tells us the camera is not registered. It says so once per
        // message it could not deliver (the offer and every ICE candidate), and
        // only after holding them for a few seconds, so anything sooner than
        // that after a dial, or while a redial is pending, is an echo of an
        // earlier dial.
        if (this.#dialTimer || this.#call || Date.now() - this.#dialStartedAt < ECHO_WINDOW_MS) return;
        this.#hangUp();
        this.#setStatus(this.state === 'ended' ? 'ended' : 'offline');
        this.#scheduleDial(OFFLINE_RETRY_MS);
        break;
      case 'browser-incompatible':
        this.#fail('This browser does not support WebRTC, so it cannot play the stream.');
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
        if (!this.#stream) this.#setStatus('reconnecting', 'Cannot reach the signaling server. Retrying…');
        break;
      default:
      // webrtc, disconnected: the dial they belong to fails or times out on its own.
    }
  }

  #dial() {
    clearTimeout(this.#dialTimer);
    this.#dialTimer = 0;
    if (this.#stopped) return;
    const peer = this.#peer;
    if (!peer?.open) {
      // A peer still starting up dials from its `open` handler; give it a
      // deadline. One that lost the server, or never reached it, is replaced.
      const starting = peer && !peer.disconnected && !peer.destroyed && Date.now() - this.#peerStartedAt < PEER_START_TIMEOUT_MS;
      if (starting) this.#scheduleDial(PEER_START_TIMEOUT_MS);
      else this.#replacePeer();
      return;
    }
    this.#hangUp();
    const conn = peer.connect(this.#target, { serialization: 'json', reliable: true });
    if (!conn) {
      this.#scheduleDial(this.#nextDelay());
      return;
    }
    this.#conn = conn;
    this.#lastSeen = this.#dialStartedAt = Date.now();
    // Covers a connection that never opens and a camera that never calls back.
    this.#connectTimer = setTimeout(() => {
      if (this.#conn === conn && !this.#stream) this.#lost('reconnecting');
    }, CONNECT_TIMEOUT_MS);
    conn.on('open', () => {
      if (this.#conn !== conn) return;
      this.#lastSeen = Date.now();
      conn.send({ type: 'ping' });
    });
    conn.on('data', (message) => this.#onMessage(conn, message));
    conn.on('close', () => {
      if (this.#conn === conn) this.#lost(this.state === 'ended' ? 'ended' : 'reconnecting');
    });
    conn.on('error', () => {
      if (this.#conn === conn) this.#lost('reconnecting');
    });
  }

  #answer(call) {
    if (this.#stopped || call.peer !== this.#target || !this.#conn) {
      call.close();
      return;
    }
    const previous = this.#call;
    this.#call = call;
    previous?.close();
    call.answer();
    call.on('stream', (stream) => {
      if (this.#call !== call) return;
      clearTimeout(this.#connectTimer);
      this.#retryDelay = 1000;
      // PeerJS emits this once per track, with the same stream each time.
      if (stream !== this.#stream) {
        this.#stream = stream;
        this.dispatchEvent(new CustomEvent('stream', { detail: { stream } }));
      }
      this.#setStatus('live');
    });
    const lost = () => {
      if (this.#call === call) this.#lost('reconnecting');
    };
    call.on('close', lost);
    call.on('error', lost);
  }

  #onMessage(conn, message) {
    if (this.#conn !== conn) return;
    this.#lastSeen = Date.now();
    switch (message?.type) {
      case 'hello':
      case 'state':
        this.remote = { mic: Boolean(message.mic) };
        this.dispatchEvent(new CustomEvent('remotestate', { detail: this.remote }));
        break;
      case 'bye':
        this.#lost('ended');
        break;
      default:
      // ping: lastSeen is all it is for.
    }
  }

  #lost(state) {
    this.#hangUp();
    this.#setStatus(state);
    this.#scheduleDial(state === 'ended' ? OFFLINE_RETRY_MS : this.#nextDelay());
  }

  #nextDelay() {
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(this.#retryDelay * 2, MAX_RETRY_MS);
    return delay;
  }

  #scheduleDial(delay) {
    clearTimeout(this.#dialTimer);
    this.#dialTimer = setTimeout(() => this.#dial(), delay);
  }

  #hangUp() {
    clearTimeout(this.#connectTimer);
    const { conn, call } = { conn: this.#conn, call: this.#call };
    this.#conn = null;
    this.#call = null;
    call?.close();
    conn?.close();
    if (this.#stream) {
      this.#stream = null;
      this.dispatchEvent(new CustomEvent('stream', { detail: { stream: null } }));
    }
  }

  #tick() {
    if (!this.#conn?.open) return;
    if (Date.now() - this.#lastSeen > SILENCE_TIMEOUT_MS) {
      this.#lost('reconnecting');
      return;
    }
    this.#conn.send({ type: 'ping' });
  }

  #fail(message) {
    this.#hangUp();
    clearTimeout(this.#dialTimer);
    this.#dialTimer = 0;
    const peer = this.#peer;
    this.#peer = null;
    peer?.destroy();
    this.#setStatus('error', message);
  }

  #setStatus(state, message = '') {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, message } }));
  }
}
