function measurePcmRms(pcm: Buffer) {
  if (pcm.length < 4) return 0;
  let sumSq = 0;
  let count = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    sumSq += sample * sample;
    count += 1;
  }
  return Math.sqrt(sumSq / count);
}

/** Build per-frame mouth openness (0–1) from TTS PCM amplitude. */
export function buildLipSyncFrames(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  frameMs = 50
) {
  const bytesPerFrame = Math.max(4, Math.floor(sampleRate * channels * 2 * (frameMs / 1000)));
  const frames: number[] = [];
  let smoothed = 0;

  for (let offset = 0; offset < pcm.length; offset += bytesPerFrame) {
    const end = Math.min(offset + bytesPerFrame, pcm.length);
    const rms = measurePcmRms(pcm.subarray(offset, end));
    const target = Math.min(1, Math.pow(rms / 3000, 0.7)) * 0.88;
    smoothed = target > smoothed ? smoothed * 0.25 + target * 0.75 : smoothed * 0.55 + target * 0.45;
    frames.push(Math.round(smoothed * 1000) / 1000);
  }

  if (frames.length === 0) {
    frames.push(0);
  } else {
    frames.push(0);
  }

  return frames;
}
