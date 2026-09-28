// Camera codes and signaling configuration. Pure functions only, so they run
// unchanged in the browser and under node --test.

// No 0/O or 1/I/L: a code read off a screen should survive being typed.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;

// The signaling server is shared with every other PeerJS app, so namespace the ids.
const PEER_ID_PREFIX = 'camera-cast-';

const randomBytes = (count) => crypto.getRandomValues(new Uint8Array(count));

export function generateCode(random = randomBytes) {
  // Drop bytes past the last whole multiple of the alphabet so every symbol is equally likely.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of random(CODE_LENGTH)) {
      if (byte < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return code;
}

export function normalizeCode(input) {
  return String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function isValidCode(code) {
  return code.length === CODE_LENGTH && [...code].every((symbol) => CODE_ALPHABET.includes(symbol));
}

export function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function peerIdFor(code) {
  return PEER_ID_PREFIX + code;
}

// PeerJS options from the page URL. The default is the public PeerJS cloud
// server; ?signal=https://host:port/path points at a self-hosted PeerServer
// (append ?key=... inside it for a non-default API key), and ?debug=1..3 turns
// on PeerJS logging.
export function signalingOptions(params) {
  const options = {};
  const debug = Number.parseInt(params.get('debug') ?? '', 10);
  if (debug > 0) options.debug = Math.min(debug, 3);
  const raw = params.get('signal');
  if (!raw) return options;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`The signaling server address "${raw}" is not a valid URL.`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`The signaling server address must start with https:// or http:// (got "${raw}").`);
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  options.host = url.hostname;
  options.port = Number(url.port) || (secure ? 443 : 80);
  options.path = url.pathname || '/';
  options.secure = secure;
  const key = url.searchParams.get('key');
  if (key) options.key = key;
  return options;
}

// The link a viewer opens. Carries the signaling override along, because a
// viewer on a different server would never find the camera.
export function watchLink(appUrl, code, params) {
  const url = new URL(appUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set('watch', code);
  const signal = params.get('signal');
  if (signal) url.searchParams.set('signal', signal);
  return url.href;
}
