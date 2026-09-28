# Camera Cast

Stream your camera to any browser, peer-to-peer over WebRTC. No app, no account, no server of your own.

**Try it:** <https://ctbot000.github.io/camera-cast/>

1. Open the page on the device with the camera and press **Start camera**.
2. On another device, scan the QR code, open the link, or type the 8-character code.
3. Watch live. The video goes directly from one device to the other.

## Features

- **One camera, many viewers.** Each viewer gets its own peer-to-peer connection, and the camera shows how many are watching.
- **Share by link, QR code or code.** Codes use no look-alike characters (no `0`/`O`, `1`/`I`/`L`) and stay the same across visits, so saved links keep working.
- **Live controls without reconnecting.** Switch between front and back cameras, pick another camera or quality, and turn the microphone on or off while viewers keep watching.
- **Viewer tools.** Sound, snapshot (PNG), recording (WebM or MP4), fit or fill, connection stats (resolution, frame rate, bitrate, round trip, direct or relayed), picture-in-picture and full screen.
- **Self-healing.** A viewer can open the link before the camera starts; it waits, connects when the camera appears, and reconnects by itself after a network drop or a camera restart.
- **Stays awake.** Uses the Screen Wake Lock API while streaming or watching.

Everything runs on standard WebRTC APIs, so any current browser should work; the automated tests run in Chrome.

## How it works

```
  camera device                                    viewer device
 ┌───────────────┐    data: hello, state, ping   ┌───────────────┐
 │  Broadcaster  │ ◄───────────────────────────► │    Watcher    │
 │ getUserMedia  │ ───── media call (A + V) ───► │    <video>    │
 └───────┬───────┘                               └───────┬───────┘
         │ registers camera-cast-CODE                    │ connects to camera-cast-CODE
         └───────────────► PeerJS server ◄───────────────┘
                          (signaling only)
```

1. The camera registers the id `camera-cast-<CODE>` with a [PeerJS](https://peerjs.com/) signaling server.
2. A viewer opens a data connection to that id, and the camera calls it back with its audio and video.
3. Media flows directly between the devices, encrypted with DTLS-SRTP. When NAT blocks a direct path, the stream is relayed (still encrypted) through the TURN servers in PeerJS's default configuration.
4. Camera switches and microphone toggles are `RTCRtpSender.replaceTrack()` calls on the live connections. While the microphone is off, the audio sender carries generated silence, so no change ever needs a renegotiation.
5. Both sides send a heartbeat over the data connection every 2 seconds. The camera drops a viewer that has been silent for 10 seconds; a viewer that loses the camera redials with backoff.

## Privacy

- Anyone with the code or the link can watch. Codes are 8 random characters from a 31-symbol alphabet (about 8.5 × 10¹¹ possibilities), and the PeerJS cloud server does not let anyone list peers. **New code** disconnects every viewer and retires the old link.
- The page is static: no accounts, analytics or cookies. It remembers your camera code, quality, microphone and camera choice in `localStorage`.
- The signaling server sees peer ids and connection setup data (session descriptions and ICE candidates, which include IP addresses), never the video or sound.

## Run it locally

```bash
npm install
```

```bash
npm start
```

Then open <http://localhost:5391/>. Browsers allow camera access only on `https://` pages and on `localhost`, so to stream from a phone, use the hosted site or serve the app over HTTPS. Other devices on your network can still watch over plain HTTP; `npm start -- --host 0.0.0.0` prints the addresses to use.

## Use your own signaling server

The app uses the free PeerJS cloud server (`0.peerjs.com`) unless the page URL says otherwise. To run your own [PeerServer](https://github.com/peers/peerjs-server):

```bash
npx peer --port 9000
```

Then open the app with the server's address in `signal`, for example <http://localhost:5391/?signal=http://localhost:9000/>. Share links carry the setting along, so viewers use the same server. Use an `https://` address for a server behind TLS, and put `?key=...` inside the (URL-encoded) address for a non-default API key. Adding `debug=3` turns on PeerJS logging.

## Tests

```bash
npm test
```

Unit tests for the codes and settings, plus an end-to-end suite that drives headless Chrome through a local PeerServer. It checks that a viewer receives the camera, that camera switches and the microphone reach it on the same connection, that viewer counts follow joins and leaves, that a signaling outage leaves the stream playing, and that stopping, restarting, code collisions and new codes all behave. The camera and microphone are faked inside the page (a canvas and an oscillator), so no devices or permissions are involved. Set `CHROME_PATH` if Chrome is not installed in a standard location.

## Project layout

```
public/                 the whole site; no build step
  index.html, app.css
  js/main.js            screens, controls and navigation
  js/camera.js          camera, microphone and the silent stand-in track
  js/broadcaster.js     camera side: registration, viewers, heartbeats
  js/watcher.js         viewer side: dialing, retries, heartbeats
  js/code.js            camera codes and signaling settings
  js/qr.js, js/stats.js
  vendor/               PeerJS and qrcode-generator (npm run vendor)
scripts/serve.mjs       development server with caching off
test/                   node:test suites
```

`public/` is deployed to GitHub Pages by the CI workflow after the tests pass.

## License

[MIT](LICENSE). Includes [PeerJS](https://github.com/peers/peerjs) and [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), both MIT-licensed.
