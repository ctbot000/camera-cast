// Owns what this device sends: one camera track and one audio track. The audio
// track is the microphone while it is on and generated silence while it is off,
// so every call is negotiated with both kinds up front and every later change
// (flip camera, toggle mic) is a replaceTrack on the existing senders instead
// of a renegotiation.

export const QUALITIES = {
  low: { label: 'Low (360p)', width: 640, height: 360, frameRate: 24 },
  medium: { label: 'Medium (720p)', width: 1280, height: 720, frameRate: 30 },
  high: { label: 'High (1080p)', width: 1920, height: 1080, frameRate: 30 },
};

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export function cameraSupported() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}

export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  // Before permission is granted the ids are blank and useless.
  return devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
}

function videoConstraints({ deviceId, facingMode }, quality) {
  const { width, height, frameRate } = QUALITIES[quality];
  const constraints = { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: frameRate } };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  else if (facingMode) constraints.facingMode = facingMode;
  return constraints;
}

function createSilence() {
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  // A destination with nothing connected to it is a live track of silence.
  const track = context.createMediaStreamDestination().stream.getAudioTracks()[0];
  return {
    track,
    close() {
      track.stop();
      context.close().catch(() => {});
    },
  };
}

export class Camera extends EventTarget {
  videoTrack = null;
  micTrack = null;
  quality = 'medium';
  #silence = null;

  get micOn() {
    return Boolean(this.micTrack);
  }

  get audioTrack() {
    return this.micTrack ?? this.#silence?.track ?? null;
  }

  // A fresh stream of the current tracks, for calls placed from now on.
  get stream() {
    return new MediaStream([this.videoTrack, this.audioTrack].filter(Boolean));
  }

  get settings() {
    return this.videoTrack?.getSettings() ?? {};
  }

  async start({ quality = 'medium', mic = false, deviceId = null, facingMode = 'environment' } = {}) {
    this.quality = QUALITIES[quality] ? quality : 'medium';
    let stream;
    const video = videoConstraints({ deviceId, facingMode }, this.quality);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: mic ? AUDIO : false });
    } catch (error) {
      // A remembered camera that is gone should not stop the stream from starting.
      if (deviceId && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
        return this.start({ quality, mic, facingMode });
      }
      if (!mic) throw error;
      // Retry without the microphone: a camera-only stream beats none.
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      this.#warn('The microphone could not be started, so the stream has no sound.');
    }
    this.#silence = createSilence();
    this.videoTrack = this.#watch(stream.getVideoTracks()[0]);
    this.micTrack = this.#watch(stream.getAudioTracks()[0] ?? null);
    this.#changed('video');
    this.#changed('audio');
  }

  async switchCamera() {
    const current = this.settings;
    if (current.facingMode === 'user' || current.facingMode === 'environment') {
      try {
        await this.useCamera({ facingMode: { exact: current.facingMode === 'user' ? 'environment' : 'user' } });
        return;
      } catch (error) {
        if (error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError') throw error;
      }
    }
    const cameras = await listCameras();
    if (cameras.length < 2) throw new Error('No other camera was found on this device.');
    const index = cameras.findIndex((camera) => camera.deviceId === current.deviceId);
    await this.useCamera({ deviceId: cameras[(index + 1) % cameras.length].deviceId });
  }

  async useCamera(target) {
    const previous = this.videoTrack;
    const previousId = previous?.getSettings().deviceId;
    // Phones cannot open a second camera while the first is still running.
    previous?.stop();
    this.videoTrack = null;
    try {
      this.videoTrack = await this.#openVideo(target);
    } catch (error) {
      if (previousId) this.videoTrack = await this.#openVideo({ deviceId: previousId }).catch(() => null);
      this.#changed('video');
      throw error;
    }
    this.#changed('video');
  }

  async restartVideo() {
    return this.useCamera({ deviceId: this.settings.deviceId });
  }

  async setQuality(quality) {
    if (!QUALITIES[quality]) return;
    this.quality = quality;
    const { width, height, frameRate } = QUALITIES[quality];
    await this.videoTrack?.applyConstraints({
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: frameRate },
    });
    this.dispatchEvent(new CustomEvent('settingschange'));
  }

  async setMic(on) {
    if (on === this.micOn) return;
    if (on) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
      this.micTrack = this.#watch(stream.getAudioTracks()[0]);
    } else {
      this.micTrack.stop();
      this.micTrack = null;
    }
    this.#changed('audio');
  }

  stop() {
    this.videoTrack?.stop();
    this.micTrack?.stop();
    this.#silence?.close();
    this.videoTrack = this.micTrack = this.#silence = null;
  }

  async #openVideo(target) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(target, this.quality),
      audio: false,
    });
    return this.#watch(stream.getVideoTracks()[0]);
  }

  // `ended` fires when the track dies on its own (unplugged, revoked, taken by
  // the OS), never after our own stop().
  #watch(track) {
    track?.addEventListener('ended', () => {
      if (track !== this.videoTrack && track !== this.micTrack) return;
      if (track === this.micTrack) {
        this.micTrack = null;
        this.#changed('audio');
      }
      this.dispatchEvent(new CustomEvent('trackended', { detail: { kind: track.kind } }));
    });
    return track;
  }

  #changed(kind) {
    this.dispatchEvent(new CustomEvent('trackchange', { detail: { kind } }));
  }

  #warn(message) {
    this.dispatchEvent(new CustomEvent('warning', { detail: { message } }));
  }
}
