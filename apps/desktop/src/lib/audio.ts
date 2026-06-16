export function base64ToArrayBuffer(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function floatToPcm16Base64(input: Float32Array) {
  const int16 = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
    int16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
}

export class PcmPlayer {
  readonly context = new AudioContext({ sampleRate: 24000 });
  private nextPlayTime = 0;
  private analyser: AnalyserNode | null = null;

  getAnalyser() {
    if (!this.analyser) {
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.35;
    }
    return this.analyser;
  }

  async playBase64Pcm(base64: string) {
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    const buffer = base64ToArrayBuffer(base64);
    const int16 = new Int16Array(buffer);
    const float32 = new Float32Array(int16.length);
    for (let index = 0; index < int16.length; index += 1) {
      float32[index] = (int16[index] ?? 0) / 32768;
    }

    const audioBuffer = this.context.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = audioBuffer;
    source.connect(gain);
    gain.connect(this.context.destination);
    gain.connect(this.getAnalyser());

    const scheduled = Math.max(this.context.currentTime, this.nextPlayTime);
    const fade = 0.004;
    gain.gain.setValueAtTime(0, scheduled);
    gain.gain.linearRampToValueAtTime(1, scheduled + fade);
    gain.gain.setValueAtTime(1, scheduled + audioBuffer.duration - fade);
    gain.gain.linearRampToValueAtTime(0, scheduled + audioBuffer.duration);
    source.start(scheduled);
    this.nextPlayTime = scheduled + audioBuffer.duration;
  }

  stopQueuedAudio() {
    this.nextPlayTime = this.context.currentTime;
  }
}
