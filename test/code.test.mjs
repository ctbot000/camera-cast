import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  CODE_LENGTH,
  formatCode,
  generateCode,
  isValidCode,
  normalizeCode,
  peerIdFor,
  signalingOptions,
  watchLink,
} from '../public/js/code.js';

const params = (query) => new URLSearchParams(query);

test('generated codes are valid', () => {
  for (let i = 0; i < 2000; i++) {
    const code = generateCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.ok(isValidCode(code), code);
  }
});

test('generateCode rejects the bytes that would bias the draw', () => {
  const batches = [
    [255, 250, 248, 0, 1, 2, 3, 4],
    [5, 6, 7, 8, 9, 10, 11, 12],
  ];
  assert.equal(generateCode(() => Uint8Array.from(batches.shift())), '23456789');
});

test('codes are normalized, validated and formatted', () => {
  assert.equal(normalizeCode(' abcd-efgh '), 'ABCDEFGH');
  assert.ok(isValidCode('ABCDEFGH'));
  assert.ok(!isValidCode('ABCDEFG'), 'too short');
  assert.ok(!isValidCode('ABCDEFGHJ'), 'too long');
  assert.ok(!isValidCode('ABCDEFGI'), 'I looks like 1');
  assert.ok(!isValidCode('ABCD0FGH'), '0 looks like O');
  assert.equal(formatCode('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(peerIdFor('ABCDEFGH'), 'camera-cast-ABCDEFGH');
});

test('signalingOptions defaults to the PeerJS cloud server', () => {
  assert.deepEqual(signalingOptions(params('')), {});
  assert.deepEqual(signalingOptions(params('debug=2')), { debug: 2 });
});

test('signalingOptions reads a self-hosted PeerServer from ?signal=', () => {
  assert.deepEqual(signalingOptions(params('signal=https://peer.example.com/app')), {
    host: 'peer.example.com',
    port: 443,
    path: '/app',
    secure: true,
  });
  assert.deepEqual(signalingOptions(params(`signal=${encodeURIComponent('http://localhost:9000/?key=abc')}`)), {
    host: 'localhost',
    port: 9000,
    path: '/',
    secure: false,
    key: 'abc',
  });
  assert.throws(() => signalingOptions(params('signal=not a url')), /not a valid URL/);
  assert.throws(() => signalingOptions(params('signal=ftp://example.com')), /must start with/);
});

test('watchLink carries the code and the signaling override, nothing else', () => {
  assert.equal(
    watchLink('https://example.com/app/?debug=3#top', 'ABCDEFGH', params('')),
    'https://example.com/app/?watch=ABCDEFGH',
  );
  assert.equal(
    watchLink('https://example.com/', 'ABCDEFGH', params('signal=http://localhost:9000/&debug=3')),
    'https://example.com/?watch=ABCDEFGH&signal=http%3A%2F%2Flocalhost%3A9000%2F',
  );
});

test('vendored libraries match the installed packages (run npm run vendor after an upgrade)', async () => {
  for (const [pkg, file, name] of [
    ['peerjs', 'peerjs.min.js', 'PeerJS'],
    ['qrcode-generator', 'qrcode.mjs', 'qrcode-generator'],
  ]) {
    const { version } = JSON.parse(await readFile(new URL(`../node_modules/${pkg}/package.json`, import.meta.url), 'utf8'));
    const vendored = await readFile(new URL(`../public/vendor/${file}`, import.meta.url), 'utf8');
    assert.ok(vendored.startsWith(`/*! ${name} ${version} `) || vendored.startsWith(`// ${name} ${version} `), `${file} is not ${pkg}@${version}`);
  }
});
