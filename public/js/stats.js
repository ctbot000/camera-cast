// Turns RTCPeerConnection.getStats() into a few numbers a person can read.

export async function sampleStats(pc, previous = null) {
  const report = await pc.getStats();
  const stats = new Map();
  report.forEach((entry) => stats.set(entry.id, entry));

  let video = null;
  let audio = null;
  let pair = null;
  for (const entry of stats.values()) {
    if (entry.type === 'inbound-rtp' && entry.kind === 'video') video = entry;
    else if (entry.type === 'inbound-rtp' && entry.kind === 'audio') audio = entry;
    else if (entry.type === 'transport' && entry.selectedCandidatePairId) pair = stats.get(entry.selectedCandidatePairId);
  }
  // Firefox has no transport entry; it flags the pair itself.
  pair ??= [...stats.values()].find((entry) => entry.type === 'candidate-pair' && entry.selected) ?? null;

  let bitrate = null;
  if (video && previous?.video) {
    const seconds = (video.timestamp - previous.video.timestamp) / 1000;
    if (seconds > 0) bitrate = ((video.bytesReceived - previous.video.bytesReceived) * 8) / seconds;
  }
  const codec = video?.codecId ? stats.get(video.codecId) : null;

  return {
    video,
    summary: {
      resolution: video?.frameWidth ? `${video.frameWidth}×${video.frameHeight}` : '—',
      fps: video?.framesPerSecond != null ? Math.round(video.framesPerSecond) : null,
      bitrate,
      rtt: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      codec: codec?.mimeType?.split('/')[1] ?? '—',
      route: routeOf(pair && stats.get(pair.localCandidateId), pair && stats.get(pair.remoteCandidateId)),
      packetsLost: video?.packetsLost ?? 0,
      audioLevel: audio?.audioLevel ?? null,
    },
  };
}

function routeOf(local, remote) {
  if (!local) return '—';
  if (local.candidateType === 'relay' || remote?.candidateType === 'relay') return 'Relayed (TURN)';
  if (local.candidateType === 'host' && remote?.candidateType === 'host') return 'Direct (local network)';
  return 'Direct (peer-to-peer)';
}

export function formatBitrate(bitsPerSecond) {
  if (bitsPerSecond == null) return '—';
  if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1e3)} kbps`;
}
