import { floatToPcm16Base64, PcmPlayer } from './audio';

export type CompanionState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'reacting';

export interface TranscriptLine {
  id: string;
  speaker: 'user' | 'assistant';
  text: string;
  final?: boolean | undefined;
}

export type RealtimeEvent =
  | { type: 'status'; status: string; reason?: string }
  | { type: 'input.ack'; requestId: string; inputType: 'text' }
  | { type: 'response.empty'; reason: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'transcript'; speaker: 'user' | 'assistant'; text: string; final?: boolean }
  | { type: 'avatar.expression'; payload: { expression: string; intensity: number } }
  | { type: 'avatar.state'; payload: { state: CompanionState } }
  | { type: 'avatar.model.change'; payload: { modelName: string } };

export class RealtimeClient extends EventTarget {
  readonly player = new PcmPlayer();
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: number | null = null;
  private manuallyDisconnected = false;
  private micStream: MediaStream | null = null;
  private micContext: AudioContext | null = null;
  private micProcessor: ScriptProcessorNode | null = null;
  private screenStream: MediaStream | null = null;
  private screenTimer: number | null = null;
  private readonly audioEnabled: boolean;

  constructor(options: { audioEnabled?: boolean } = {}) {
    super();
    this.audioEnabled = options.audioEnabled ?? true;
  }

  connect(): Promise<void> {
    this.manuallyDisconnected = false;
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connecting) {
      return this.connecting;
    }
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.dispatchEvent(new CustomEvent<RealtimeEvent>('event', { detail: { type: 'status', status: 'connecting' } }));
    const socket = new WebSocket('ws://127.0.0.1:8787/realtime');
    this.socket = socket;
    this.connecting = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('error', handleError);
        socket.removeEventListener('close', handleCloseBeforeOpen);
      };
      const handleOpen = () => {
        cleanup();
        this.connecting = null;
        this.send({ type: 'connect', surface: 'app' });
        resolve();
      };
      const handleError = () => {
        cleanup();
        this.connecting = null;
        reject(new Error('Realtime WebSocket connection failed'));
      };
      const handleCloseBeforeOpen = () => {
        cleanup();
        this.connecting = null;
        reject(new Error('Realtime WebSocket closed before opening'));
      };

      socket.addEventListener('open', handleOpen);
      socket.addEventListener('error', handleError);
      socket.addEventListener('close', handleCloseBeforeOpen);
    }).catch((error) => {
      this.dispatchEvent(new CustomEvent<RealtimeEvent>('event', {
        detail: { type: 'status', status: 'offline', reason: error instanceof Error ? error.message : String(error) }
      }));
      this.scheduleReconnect();
      throw error;
    });
    socket.addEventListener('message', (message) => {
      const event = JSON.parse(message.data as string) as RealtimeEvent;
      if (event.type === 'audio' && this.audioEnabled) {
        void this.player.playBase64Pcm(event.data);
      }
      this.dispatchEvent(new CustomEvent<RealtimeEvent>('event', { detail: event }));
    });
    socket.addEventListener('error', () => {
      this.dispatchEvent(new CustomEvent<RealtimeEvent>('event', {
        detail: { type: 'status', status: 'offline', reason: 'Realtime WebSocket error' }
      }));
    });
    socket.addEventListener('close', () => {
      this.dispatchEvent(new CustomEvent<RealtimeEvent>('event', { detail: { type: 'status', status: 'offline' } }));
      if (this.socket === socket) {
        this.socket = null;
        this.connecting = null;
      }
      this.scheduleReconnect();
    });
    return this.connecting;
  }

  disconnect() {
    this.manuallyDisconnected = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopMicrophone();
    this.stopScreenShare();
    this.send({ type: 'disconnect' });
    this.socket?.close();
    this.socket = null;
  }

  sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.dispatchEvent(new CustomEvent<RealtimeEvent>('event', {
      detail: { type: 'transcript', speaker: 'user', text: trimmed, final: true }
    }));
    const payload = { type: 'text', text: trimmed, requestId: crypto.randomUUID() };
    void this.connect()
      .then(() => this.send(payload))
      .catch((error) => {
        this.dispatchEvent(new CustomEvent<RealtimeEvent>('event', {
          detail: { type: 'status', status: 'offline', reason: error instanceof Error ? error.message : String(error) }
        }));
      });
  }

  setPassive(passive: boolean) {
    void this.connect()
      .then(() => this.send({ type: 'mode', passive }))
      .catch(() => undefined);
  }

  interrupt() {
    this.player.stopQueuedAudio();
    void this.connect()
      .then(() => this.send({ type: 'interrupt' }))
      .catch(() => undefined);
  }

  async startMicrophone() {
    await this.connect();
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    this.micContext = new AudioContext({ sampleRate: 16000 });
    const source = this.micContext.createMediaStreamSource(this.micStream);
    this.micProcessor = this.micContext.createScriptProcessor(4096, 1, 1);
    this.micProcessor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      this.send({ type: 'audio', data: floatToPcm16Base64(input), mimeType: 'audio/pcm;rate=16000' });
    };
    source.connect(this.micProcessor);
    this.micProcessor.connect(this.micContext.destination);
  }

  stopMicrophone() {
    this.micProcessor?.disconnect();
    void this.micContext?.close();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micProcessor = null;
    this.micContext = null;
    this.micStream = null;
  }

  async startScreenShare(options: { systemAudio: boolean; fps: number }) {
    await this.connect();
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: options.fps, max: 5 }, width: { max: 1920 } },
      audio: options.systemAudio
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.screenStream;
    await new Promise<void>((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        resolve();
        return;
      }
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    });
    await video.play();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const capture = () => {
      if (!context || !video.videoWidth || !video.videoHeight) {
        return;
      }
      const width = Math.min(video.videoWidth, 1280);
      const height = Math.round(width * (video.videoHeight / video.videoWidth));
      canvas.width = width;
      canvas.height = height;
      context.drawImage(video, 0, 0, width, height);
      const data = canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
      if (data) {
        this.send({ type: 'video', data, mimeType: 'image/jpeg' });
      }
    };
    capture();
    this.screenTimer = window.setInterval(capture, 1000 / Math.max(1, Math.min(options.fps, 5)));
    this.screenStream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopScreenShare());
  }

  stopScreenShare() {
    if (this.screenTimer) {
      window.clearInterval(this.screenTimer);
    }
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenTimer = null;
    this.screenStream = null;
  }

  private send(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect() {
    if (this.manuallyDisconnected || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, 1500);
  }
}
