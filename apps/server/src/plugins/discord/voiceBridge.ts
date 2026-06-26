import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  type AudioPlayer,
  type AudioPlayerState,
  type VoiceConnection,
  type VoiceConnectionState
} from '@discordjs/voice';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import OpusScript from 'opusscript';
import type { AppConfig } from '../../config/env.js';
import type { LiveClientEvent, VoiceCallParticipant } from '../../live/liveSession.js';
import { LiveSessionManager } from '../../live/liveSession.js';
import { LocalVoiceSessionManager } from '../../live/localVoiceSession.js';
import type { MemoryStore } from '../../memory/types.js';
import type { PersonalityInstructionProvider } from '../../personality/service.js';
import type { PlatformStore, UsageReservation } from '../../platform/store.js';
import { voiceCredits } from '../../providers/routing.js';
import type { PlanFeatures } from '../../platform/features.js';
import type { MusicController, VoiceController } from '../../tools/registry.js';
import { logger } from '../../logging/logger.js';
import { broadcastAvatarEvent } from '../../ws/avatarBroadcast.js';

const DISCORD_RATE = 48000;
const DISCORD_CHANNELS = 2;
const GEMINI_INPUT_RATE = 16000;
const GEMINI_OUTPUT_RATE = 24000;
const DEFAULT_SPEECH_END_SILENCE_MS = 900;
/** 16 kHz mono RMS above this counts as speech (not background noise). */
const PCM_SPEECH_RMS_THRESHOLD = 320;
const MIXER_FRAME_MS = 20;
const MIXER_FRAME_BYTES = DISCORD_RATE * DISCORD_CHANNELS * 2 * MIXER_FRAME_MS / 1000;
const MIXER_IDLE_END_MS = 450;
const ASSISTANT_DUCK_HOLD_MS = 650;
const MUSIC_QUEUE_HIGH_WATER_BYTES = DISCORD_RATE * DISCORD_CHANNELS * 2 * 12;
const MUSIC_QUEUE_LOW_WATER_BYTES = DISCORD_RATE * DISCORD_CHANNELS * 2 * 6;
const YTDLP_SEARCH_RESULTS = 5;
const YTDLP_AUDIO_FORMAT = 'ba[protocol*=m3u8]/b[protocol*=m3u8]/ba/bestaudio/best';

interface DiscordMusicStatus {
  state: 'idle' | 'searching' | 'playing' | 'paused' | 'stopping' | 'error';
  title: string | null;
  url: string | null;
  durationSeconds: number | null;
  volume: number;
  duckVolume: number;
  loopCurrent: boolean;
  startedAt: string | null;
  positionSeconds: number;
  seekOffsetSeconds: number;
  lastError: string | null;
  queuedBytes: number;
}

interface DiscordMusicQueueEntry {
  title: string;
  url: string;
  durationSeconds: number | null;
  requestedQuery: string;
  queuedAt: string;
}

interface VoiceBridgeDiagnostics {
  attached: boolean;
  channelId: string | null;
  connectionStatus: string | null;
  receiverAttached: boolean;
  playerStatus: string;
  activeInputUsers: number;
  speakingStarts: number;
  rawUdpPackets: number;
  mappedUdpPackets: number;
  unmappedUdpPackets: number;
  opusBytes: number;
  decodedPcmBytes: number;
  geminiInputBytes: number;
  textInputs: number;
  geminiActivityStarts: number;
  geminiActivityEnds: number;
  geminiAudioEvents: number;
  geminiOutputBytes: number;
  discordOutputBytes: number;
  lastGeminiStatus: string | null;
  lastGeminiStatusAt: string | null;
  lastGeminiStatusReason: string | null;
  lastSpeakingAt: string | null;
  lastRawUdpAt: string | null;
  lastUdpSsrc: number | null;
  lastOpusAt: string | null;
  lastDecodedAt: string | null;
  lastGeminiInputAt: string | null;
  lastTextInputAt: string | null;
  lastGeminiActivityStartAt: string | null;
  lastGeminiActivityEndAt: string | null;
  lastGeminiAudioAt: string | null;
  lastDiscordWriteAt: string | null;
  lastError: string | null;
}

export class DiscordVoiceBridge implements MusicController, VoiceController {
  private readonly live: LiveSessionManager | LocalVoiceSessionManager;
  private readonly bypassVoiceChanger: boolean;
  private readonly player: AudioPlayer;
  private readonly mixer: DiscordPcmMixer;
  private readonly voiceChanger: DiscordVoiceChanger;
  private connection: VoiceConnection | null = null;
  private channelId: string | null = null;
  private speakingHandler: ((userId: string) => void) | null = null;
  private connectionStateHandler: ((oldState: VoiceConnectionState, newState: VoiceConnectionState) => void) | null = null;
  private udpDiagnosticsSocket: { on(event: 'message', listener: (message: Buffer) => void): unknown; off(event: 'message', listener: (message: Buffer) => void): unknown } | null = null;
  private udpDiagnosticsHandler: ((message: Buffer) => void) | null = null;
  private readonly activeInputUsers = new Set<string>();
  private readonly userCaptures = new Map<string, {
    userId: string;
    opusDecoder: OpusScript;
    mode: 'auto' | 'ptt';
    turnActive: boolean;
    pttRecording: boolean;
    pttInputBytes: number;
    silenceTimer: ReturnType<typeof setTimeout> | null;
  }>();
  private pttUiListener: ((phase: 'idle' | 'recording' | 'processing', detail?: string) => void) | null = null;
  private activeTurnUserId: string | null = null;
  private inputQueue: Promise<void> = Promise.resolve();
  private readonly pendingVoiceTextMessages: Array<{ authorName: string; text: string }> = [];
  private voiceTextDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private musicYtDlp: ReturnType<typeof spawn> | null = null;
  private musicFfmpeg: ReturnType<typeof spawn> | null = null;
  private musicStopRequested = false;
  private musicStatus: DiscordMusicStatus;
  private readonly musicQueue: DiscordMusicQueueEntry[] = [];
  private readonly musicHistory: YoutubeTrack[] = [];
  private destroyed = false;
  private usageReservation: UsageReservation | null = null;
  private usageInputBaseline = 0;
  private usageOutputBaseline = 0;
  private voiceUsageAllowed = true;
  private userInputMutedUntil = 0;
  private localTtsPlaying = false;
  private localTtsQueue: Promise<void> = Promise.resolve();
  private pendingAvatarLipSync: { frameMs: number; open: number[] } | null = null;
  private diagnostics: VoiceBridgeDiagnostics = {
    attached: false,
    channelId: null,
    connectionStatus: null,
    receiverAttached: false,
    playerStatus: AudioPlayerStatus.Idle,
    activeInputUsers: 0,
    speakingStarts: 0,
    rawUdpPackets: 0,
    mappedUdpPackets: 0,
    unmappedUdpPackets: 0,
    opusBytes: 0,
    decodedPcmBytes: 0,
    geminiInputBytes: 0,
    textInputs: 0,
    geminiActivityStarts: 0,
    geminiActivityEnds: 0,
    geminiAudioEvents: 0,
    geminiOutputBytes: 0,
    discordOutputBytes: 0,
    lastGeminiStatus: null,
    lastGeminiStatusAt: null,
    lastGeminiStatusReason: null,
    lastSpeakingAt: null,
    lastRawUdpAt: null,
    lastUdpSsrc: null,
    lastOpusAt: null,
    lastDecodedAt: null,
    lastGeminiInputAt: null,
    lastTextInputAt: null,
    lastGeminiActivityStartAt: null,
    lastGeminiActivityEndAt: null,
    lastGeminiAudioAt: null,
    lastDiscordWriteAt: null,
    lastError: null
  };

  constructor(
    private readonly guildId: string,
    private readonly voiceChannelId: string,
    private readonly botUserId: string,
    private readonly resolveSpeakerName: (userId: string) => string,
    private readonly listVoiceParticipants: () => VoiceCallParticipant[],
    private readonly leaveVoice: () => Promise<Record<string, unknown>>,
    private readonly config: AppConfig,
    memory: MemoryStore,
    personality: PersonalityInstructionProvider,
    geminiApiKey: string | undefined,
    private readonly usage?: { platform: PlatformStore; secondsPerCredit: number; reserveCredits: number },
    planFeatures?: PlanFeatures
  ) {
    this.musicStatus = {
      state: 'idle',
      title: null,
      url: null,
      durationSeconds: null,
      volume: config.DISCORD_MUSIC_VOLUME,
      duckVolume: config.DISCORD_MUSIC_DUCK_VOLUME,
      loopCurrent: false,
      startedAt: null,
      positionSeconds: 0,
      seekOffsetSeconds: 0,
      lastError: null,
      queuedBytes: 0
    };
    this.mixer = new DiscordPcmMixer({
      musicVolume: config.DISCORD_MUSIC_VOLUME,
      duckVolume: config.DISCORD_MUSIC_DUCK_VOLUME,
      onStart: (stream) => {
        this.player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
        this.connection?.subscribe(this.player);
      },
      onMusicQueueChange: (queuedBytes) => {
        this.musicStatus.queuedBytes = queuedBytes;
        if (queuedBytes <= MUSIC_QUEUE_LOW_WATER_BYTES && this.musicFfmpeg?.stdout?.isPaused()) {
          this.musicFfmpeg.stdout.resume();
        }
      }
    });
    this.voiceChanger = new DiscordVoiceChanger(
      config.FFMPEG_BINARY,
      config.DISCORD_VOICE_CHANGER_CONFIG,
      (pcm24k) => this.enqueueAssistantSpeech(pcm24k),
      (config as AppConfig & { guildVoiceChanger?: VoiceChangerConfig }).guildVoiceChanger
    );
    this.bypassVoiceChanger = config.GIADA_VOICE_PROVIDER === 'local';
    const liveProviders = {
      music: this,
      voice: this,
      memoryTags: ['discord', guildId, voiceChannelId],
      ...(planFeatures ? { toolEnabled: (name: string) => isVoiceToolEnabled(name, planFeatures) } : {})
    };
    if (config.GIADA_VOICE_PROVIDER === 'local') {
      this.live = new LocalVoiceSessionManager(config, memory, personality);
    } else {
      this.live = new LiveSessionManager(config, memory, personality, {
        ...liveProviders,
        ...(geminiApiKey ? { geminiApiKey } : {})
      });
    }
    this.live.setEmitter((event) => this.handleLiveEvent(event));

    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });
    this.player.on('error', (error) => {
      this.recordError(error.message);
      logger.error('Discord voice audio player failed', {
        guildId: this.guildId,
        error: error.message
      });
    });
    this.player.on('stateChange', (_oldState, newState) => {
      this.diagnostics.playerStatus = newState.status;
    });
  }

  attach(connection: VoiceConnection, channelId: string) {
    const sameConnection = this.connection === connection;
    const sameChannel = this.channelId === channelId;
    if (sameConnection && sameChannel) {
      connection.subscribe(this.player);
      if (connection.state.status === VoiceConnectionStatus.Ready) {
        this.attachReceiver(connection);
      }
      return;
    }

    if (!sameConnection) {
      this.detachReceiver();
      this.detachConnectionStateHandler();
      this.connection = connection;
      this.attachConnectionStateHandler(connection);
    }
    this.channelId = channelId;
    this.diagnostics.attached = true;
    this.diagnostics.channelId = channelId;
    this.diagnostics.connectionStatus = connection.state.status;
    connection.subscribe(this.player);
    this.attachUdpDiagnostics(connection);

    if (connection.state.status === VoiceConnectionStatus.Ready) {
      this.attachReceiver(connection);
    }
  }

  getStatus() {
    const pttUserId = [...this.userCaptures.entries()].find(([, state]) => state.pttRecording)?.[0] ?? null;
    return {
      guildId: this.guildId,
      ...this.diagnostics,
      connectionStatus: this.connection?.state.status ?? this.diagnostics.connectionStatus,
      activeInputUsers: this.activeInputUsers.size,
      pttRecording: Boolean(pttUserId),
      pttUserId,
      voiceInputMode: this.isPttMode() ? 'ptt' : 'auto',
      voiceChanger: this.voiceChanger.getStatus(),
      music: this.getMusicStatus()
    };
  }

  startPttRecording(userId: string) {
    if (this.destroyed || !this.connection) {
      return { ok: false, message: 'Luna is not in a voice channel.' };
    }
    if (this.isAssistantSpeaking()) {
      return { ok: false, message: 'Wait until Luna finishes speaking, then try again.' };
    }
    const busy = [...this.userCaptures.values()].find((state) => state.pttRecording && state.userId !== userId);
    if (busy) {
      return { ok: false, message: 'Someone else is already recording.' };
    }

    let state = this.userCaptures.get(userId);
    if (!state) {
      this.setupUserCapture(this.connection, userId, 'ptt');
      state = this.userCaptures.get(userId);
    }
    if (!state) {
      return { ok: false, message: 'Could not start microphone capture. Make sure you are unmuted in Discord.' };
    }
    if (state.pttRecording) {
      return { ok: true, message: 'Already recording — click Send Message when done.' };
    }

    state.pttRecording = true;
    state.turnActive = true;
    state.pttInputBytes = 0;
    this.activeTurnUserId = userId;
    this.activeInputUsers.add(userId);
    this.diagnostics.activeInputUsers = this.activeInputUsers.size;
    if (!this.isAssistantSpeaking()) {
      this.mixer.clearAssistant();
    }
    this.queueGeminiActivityStart();
    this.pttUiListener?.('recording');
    return { ok: true, message: 'Recording… speak now.' };
  }

  stopPttRecording(userId: string) {
    const state = this.userCaptures.get(userId);
    if (!state?.pttRecording) {
      return { ok: false, message: 'Click Start Recording first, then Send Message when done.' };
    }
    const minBytes = GEMINI_INPUT_RATE * 2 * 0.4;
    if (state.pttInputBytes < minBytes) {
      state.pttRecording = false;
      state.turnActive = false;
      state.pttInputBytes = 0;
      this.activeInputUsers.delete(userId);
      this.diagnostics.activeInputUsers = this.activeInputUsers.size;
      this.queueGeminiActivityEnd();
      this.pttUiListener?.('idle');
      return { ok: false, message: 'Recording too short — speak for at least half a second, then send.' };
    }
    state.pttRecording = false;
    state.turnActive = false;
    state.pttInputBytes = 0;
    this.activeInputUsers.delete(userId);
    this.diagnostics.activeInputUsers = this.activeInputUsers.size;
    this.queueGeminiActivityEnd();
    this.pttUiListener?.('processing');
    return { ok: true, message: 'Processing your message…' };
  }

  setPttUiListener(listener: ((phase: 'idle' | 'recording' | 'processing', detail?: string) => void) | null) {
    this.pttUiListener = listener;
  }

  private isPttMode() {
    return this.config.GIADA_VOICE_PROVIDER === 'local' && this.config.LUNA_VOICE_INPUT_MODE === 'ptt';
  }

  destroy() {
    this.destroyed = true;
    this.detachReceiver();
    this.detachUdpDiagnostics();
    this.detachConnectionStateHandler();
    this.clearVoiceTextDrainTimer();
    this.pendingVoiceTextMessages.length = 0;
    this.stopMusicProcesses('destroyed');
    this.voiceChanger.destroy();
    this.localTtsPlaying = false;
    this.mixer.destroy();
    this.player.stop(true);
    this.live.close();
    this.connection = null;
    this.channelId = null;
    this.diagnostics.attached = false;
    this.diagnostics.channelId = null;
    this.diagnostics.connectionStatus = VoiceConnectionStatus.Destroyed;
    this.diagnostics.receiverAttached = false;
  }

  private attachConnectionStateHandler(connection: VoiceConnection) {
    this.connectionStateHandler = (_oldState, newState) => {
      this.diagnostics.connectionStatus = newState.status;
      if (this.destroyed || this.connection !== connection) {
        return;
      }

      if (newState.status === VoiceConnectionStatus.Ready) {
        this.attachUdpDiagnostics(connection);
        this.attachReceiver(connection);
        return;
      }

      if (newState.status === VoiceConnectionStatus.Destroyed) {
        this.detachReceiver();
        this.detachUdpDiagnostics();
        this.live.close();
        this.connection = null;
        this.channelId = null;
      }
    };
    connection.on('stateChange', this.connectionStateHandler);
  }

  private detachConnectionStateHandler() {
    if (this.connection && this.connectionStateHandler) {
      this.connection.off('stateChange', this.connectionStateHandler);
    }
    this.connectionStateHandler = null;
  }

  private attachReceiver(connection: VoiceConnection) {
    if (this.speakingHandler) {
      return;
    }
    this.speakingHandler = (userId) => {
      if (userId === this.botUserId) {
        return;
      }
      this.diagnostics.speakingStarts += 1;
      this.diagnostics.lastSpeakingAt = new Date().toISOString();
      if (this.isPttMode()) {
        return;
      }
      if (this.config.GIADA_VOICE_PROVIDER === 'local') {
        this.ensureUserCapture(connection, userId);
        return;
      }
      if (this.activeInputUsers.has(userId)) {
        return;
      }
      this.receiveUserSpeech(connection, userId);
    };
    connection.receiver.speaking.on('start', this.speakingHandler);
    this.diagnostics.receiverAttached = true;
  }

  speakTextChatMessage(authorName: string, text: string) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || this.destroyed) {
      return;
    }
    this.diagnostics.textInputs += 1;
    this.diagnostics.lastTextInputAt = new Date().toISOString();
    this.pendingVoiceTextMessages.push({ authorName, text: normalized });
    this.drainVoiceTextMessages();
  }

  private drainVoiceTextMessages() {
    if (!this.pendingVoiceTextMessages.length || this.destroyed) {
      return;
    }
    if (this.activeInputUsers.size > 0 || this.isAssistantSpeaking()) {
      this.scheduleVoiceTextDrain();
      return;
    }

    this.clearVoiceTextDrainTimer();
    const messages = this.pendingVoiceTextMessages.splice(0);
    const text = messages
      .map((message) => `- ${message.authorName}: ${message.text}`)
      .join('\n');
    this.inputQueue = this.inputQueue
      .then(() => this.live.handleInput({
        type: 'text',
        text: `Discord voice channel text chat messages sent while you were connected to voice:\n${text}`
      }, 'discord'))
      .then(() => {
        if (this.pendingVoiceTextMessages.length) {
          this.scheduleVoiceTextDrain();
        }
      })
      .catch((error) => {
        this.recordError(error instanceof Error ? error.message : String(error));
        logger.warn('Failed to forward Discord voice text chat to Gemini Live', {
          guildId: this.guildId,
          channelId: this.channelId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private scheduleVoiceTextDrain() {
    if (this.voiceTextDrainTimer) {
      return;
    }
    this.voiceTextDrainTimer = setTimeout(() => {
      this.voiceTextDrainTimer = null;
      this.drainVoiceTextMessages();
    }, 300);
  }

  private clearVoiceTextDrainTimer() {
    if (this.voiceTextDrainTimer) {
      clearTimeout(this.voiceTextDrainTimer);
      this.voiceTextDrainTimer = null;
    }
  }

  private detachReceiver() {
    if (this.connection && this.speakingHandler) {
      this.connection.receiver.speaking.off('start', this.speakingHandler);
    }
    this.speakingHandler = null;
    for (const userId of [...this.userCaptures.keys()]) {
      this.teardownUserCapture(userId);
    }
    this.activeInputUsers.clear();
    this.diagnostics.receiverAttached = false;
    this.diagnostics.activeInputUsers = 0;
  }

  private attachUdpDiagnostics(connection: VoiceConnection) {
    const networking = 'networking' in connection.state ? connection.state.networking : null;
    const udp = networking && 'state' in networking && 'udp' in networking.state ? networking.state.udp : null;
    if (!udp || udp === this.udpDiagnosticsSocket) {
      return;
    }
    this.detachUdpDiagnostics();
    this.udpDiagnosticsSocket = udp;
    this.udpDiagnosticsHandler = (message: Buffer) => {
      if (message.length <= 8) {
        return;
      }
      const ssrc = message.readUInt32BE(8);
      this.diagnostics.rawUdpPackets += 1;
      this.diagnostics.lastRawUdpAt = new Date().toISOString();
      this.diagnostics.lastUdpSsrc = ssrc;
      const mappedUser = connection.receiver.ssrcMap.get(ssrc);
      if (mappedUser) {
        this.diagnostics.mappedUdpPackets += 1;
      } else {
        this.diagnostics.unmappedUdpPackets += 1;
      }
      if (this.diagnostics.rawUdpPackets <= 3 || this.diagnostics.rawUdpPackets % 100 === 0) {
        logger.debug('Discord voice received raw UDP audio packet', {
          guildId: this.guildId,
          channelId: this.channelId,
          ssrc,
          mappedUserId: mappedUser?.userId ?? null,
          rawUdpPackets: this.diagnostics.rawUdpPackets,
          mappedUdpPackets: this.diagnostics.mappedUdpPackets,
          unmappedUdpPackets: this.diagnostics.unmappedUdpPackets
        });
      }
    };
    udp.on('message', this.udpDiagnosticsHandler);
  }

  private detachUdpDiagnostics() {
    if (this.udpDiagnosticsSocket && this.udpDiagnosticsHandler) {
      this.udpDiagnosticsSocket.off('message', this.udpDiagnosticsHandler);
    }
    this.udpDiagnosticsSocket = null;
    this.udpDiagnosticsHandler = null;
  }

  private ensureUserCapture(connection: VoiceConnection, userId: string) {
    if (!this.userCaptures.has(userId)) {
      this.setupUserCapture(connection, userId, 'auto');
    }
  }

  private setupUserCapture(connection: VoiceConnection, userId: string, mode: 'auto' | 'ptt') {
    if (this.userCaptures.has(userId)) {
      return;
    }
    if (mode !== 'ptt' && (Date.now() < this.userInputMutedUntil || this.isAssistantSpeaking())) {
      return;
    }

    const speechEndSilenceMs = this.config.LUNA_SPEECH_END_SILENCE_MS;
    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual }
    });
    const opusDecoder = new OpusScript(DISCORD_RATE, DISCORD_CHANNELS);
    const state = {
      userId,
      opusDecoder,
      mode,
      turnActive: false,
      pttRecording: false,
      pttInputBytes: 0,
      silenceTimer: null as ReturnType<typeof setTimeout> | null
    };
    this.userCaptures.set(userId, state);
    this.resolveSpeakerName(userId);

    const endTurn = () => {
      if (!state.turnActive) {
        return;
      }
      state.turnActive = false;
      state.pttRecording = false;
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = null;
      }
      this.activeInputUsers.delete(userId);
      this.diagnostics.activeInputUsers = this.activeInputUsers.size;
      this.queueGeminiActivityEnd();
    };

    const scheduleSilenceEnd = () => {
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
      }
      state.silenceTimer = setTimeout(endTurn, speechEndSilenceMs);
    };

    const handleDecodedPcm = (chunk: Buffer) => {
      this.diagnostics.decodedPcmBytes += chunk.length;
      this.diagnostics.lastDecodedAt = new Date().toISOString();
      const pcm16k = downsampleDiscordPcmForGemini(chunk);
      if (pcm16k.length === 0) {
        return;
      }
      if (mode !== 'ptt' && (Date.now() < this.userInputMutedUntil || this.isAssistantSpeaking())) {
        return;
      }

      if (state.mode === 'ptt') {
        if (!state.pttRecording) {
          return;
        }
        state.pttInputBytes += pcm16k.length;
        this.queueGeminiInput(pcm16k);
        return;
      }

      const rms = measurePcmRms(pcm16k);
      const isSpeech = rms >= PCM_SPEECH_RMS_THRESHOLD;
      if (isSpeech) {
        if (!state.turnActive) {
          state.turnActive = true;
          this.activeInputUsers.add(userId);
          this.diagnostics.activeInputUsers = this.activeInputUsers.size;
          if (!this.isAssistantSpeaking()) {
            this.mixer.clearAssistant();
          }
          this.queueGeminiActivityStart(userId);
        }
        this.queueGeminiInput(pcm16k);
        scheduleSilenceEnd();
      } else if (state.turnActive) {
        this.queueGeminiInput(pcm16k);
      }
    };

    opusStream.on('data', (chunk: Buffer) => {
      this.diagnostics.opusBytes += chunk.length;
      this.diagnostics.lastOpusAt = new Date().toISOString();
      try {
        const decoded = opusDecoder.decode(chunk);
        if (decoded.length > 0) {
          handleDecodedPcm(Buffer.from(decoded));
        }
      } catch (error) {
        logger.debug('Discord voice skipped invalid opus packet', {
          guildId: this.guildId,
          channelId: this.channelId,
          userId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    opusStream.once('error', (error) => {
      this.recordError(error instanceof Error ? error.message : String(error));
      logger.warn('Discord voice Opus receive stream failed', {
        guildId: this.guildId,
        channelId: this.channelId,
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
      this.teardownUserCapture(userId);
    });
    opusStream.once('close', () => {
      this.teardownUserCapture(userId);
    });
  }

  private teardownUserCapture(userId: string) {
    const state = this.userCaptures.get(userId);
    if (!state) {
      return;
    }
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
    }
    state.opusDecoder.delete();
    this.userCaptures.delete(userId);
    if (state.turnActive) {
      state.turnActive = false;
      this.queueGeminiActivityEnd();
    }
    this.activeInputUsers.delete(userId);
    this.diagnostics.activeInputUsers = this.activeInputUsers.size;
  }

  private receiveUserSpeech(connection: VoiceConnection, userId: string) {
    if (Date.now() < this.userInputMutedUntil) {
      return;
    }
    if (this.isAssistantSpeaking()) {
      return;
    }
    this.activeInputUsers.add(userId);
    this.diagnostics.activeInputUsers = this.activeInputUsers.size;
    this.resolveSpeakerName(userId);
    if (!this.isAssistantSpeaking()) {
      this.mixer.clearAssistant();
    }

    const speechEndSilenceMs = this.config.GIADA_VOICE_PROVIDER === 'local'
      ? this.config.LUNA_SPEECH_END_SILENCE_MS
      : DEFAULT_SPEECH_END_SILENCE_MS;
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: speechEndSilenceMs
      }
    });
    const opusDecoder = new OpusScript(DISCORD_RATE, DISCORD_CHANNELS);
    let forwardedAudio = false;
    let activityStarted = false;
    let loggedDecodedAudio = false;
    let cleanedUp = false;
    const cleanup = (completeTurn: boolean) => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      opusDecoder.delete();
      this.activeInputUsers.delete(userId);
      this.diagnostics.activeInputUsers = this.activeInputUsers.size;
      if (completeTurn && activityStarted && forwardedAudio) {
        this.queueGeminiActivityEnd();
      }
    };

    const handleDecodedPcm = (chunk: Buffer) => {
      this.diagnostics.decodedPcmBytes += chunk.length;
      this.diagnostics.lastDecodedAt = new Date().toISOString();
      if (!loggedDecodedAudio) {
        loggedDecodedAudio = true;
        logger.debug('Discord voice received decoded audio', {
          guildId: this.guildId,
          channelId: this.channelId,
          userId,
          pcmBytes: chunk.length,
          totalDecodedPcmBytes: this.diagnostics.decodedPcmBytes
        });
      }
      const pcm16k = downsampleDiscordPcmForGemini(chunk);
      // Discord client-side Krisp already denoised this stream — do not apply extra suppression.
      if (pcm16k.length > 0) {
        if (!activityStarted) {
          activityStarted = true;
          this.queueGeminiActivityStart(userId);
        }
        forwardedAudio = true;
        this.queueGeminiInput(pcm16k);
      }
    };

    opusStream.on('data', (chunk: Buffer) => {
      this.diagnostics.opusBytes += chunk.length;
      this.diagnostics.lastOpusAt = new Date().toISOString();
      try {
        const decoded = opusDecoder.decode(chunk);
        if (decoded.length > 0) {
          handleDecodedPcm(Buffer.from(decoded));
        }
      } catch (error) {
        logger.debug('Discord voice skipped invalid opus packet', {
          guildId: this.guildId,
          channelId: this.channelId,
          userId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    opusStream.once('error', (error) => {
      cleanup(forwardedAudio);
      this.recordError(error instanceof Error ? error.message : String(error));
      logger.warn('Discord voice Opus receive stream failed', {
        guildId: this.guildId,
        channelId: this.channelId,
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    opusStream.once('end', () => {
      cleanup(true);
    });
    opusStream.once('close', () => {
      cleanup(true);
    });
  }

  private queueGeminiActivityStart(userId?: string) {
    const speakerUserId = userId ?? this.activeTurnUserId;
    if (userId) {
      this.activeTurnUserId = userId;
    }
    const speaker = speakerUserId ? this.buildSpeakerContext(speakerUserId) : null;
    this.diagnostics.geminiActivityStarts += 1;
    this.diagnostics.lastGeminiActivityStartAt = new Date().toISOString();
    this.inputQueue = this.inputQueue
      .then(async () => {
        if (this.usage && !this.usageReservation) {
          this.usageReservation = await this.usage.platform.reserveUsage(
            this.guildId,
            `voice:${this.guildId}:${this.channelId}:${Date.now()}`,
            'voice_credit',
            this.usage.reserveCredits
          );
          this.voiceUsageAllowed = Boolean(this.usageReservation);
          this.usageInputBaseline = this.diagnostics.geminiInputBytes;
          this.usageOutputBaseline = this.diagnostics.geminiOutputBytes;
        }
        if (!this.voiceUsageAllowed) throw new Error('voice_credits_exhausted');
        await this.live.handleInput({
          type: 'activityStart',
          ...(speaker ? { speaker } : {})
        }, 'discord');
      })
      .catch((error) => {
        this.recordError(error instanceof Error ? error.message : String(error));
        logger.warn('Failed to start Discord voice activity in Gemini Live', {
          guildId: this.guildId,
          channelId: this.channelId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private buildSpeakerContext(userId: string) {
    const othersInCall = this.listVoiceParticipants().filter((person) => person.userId !== userId);
    return {
      guildId: this.guildId,
      userId,
      displayName: this.resolveSpeakerName(userId),
      othersInCall
    };
  }

  private queueGeminiActivityEnd() {
    this.diagnostics.geminiActivityEnds += 1;
    this.diagnostics.lastGeminiActivityEndAt = new Date().toISOString();
    this.inputQueue = this.inputQueue
      .then(() => this.live.handleInput({
        type: 'activityEnd'
      }, 'discord'))
      .catch((error) => {
        this.recordError(error instanceof Error ? error.message : String(error));
        logger.warn('Failed to end Discord voice activity in Gemini Live', {
          guildId: this.guildId,
          channelId: this.channelId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private queueGeminiInput(pcm: Buffer) {
    this.diagnostics.geminiInputBytes += pcm.length;
    this.diagnostics.lastGeminiInputAt = new Date().toISOString();
    logger.debug('Discord voice forwarding audio to Gemini Live', {
      guildId: this.guildId,
      channelId: this.channelId,
      pcmBytes: pcm.length,
      totalGeminiInputBytes: this.diagnostics.geminiInputBytes
    });
    const data = pcm.toString('base64');
    this.inputQueue = this.inputQueue
      .then(() => this.voiceUsageAllowed ? this.live.handleInput({
        type: 'audio',
        data,
        mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}`
      }, 'discord') : undefined)
      .catch((error) => {
        logger.warn('Failed to forward Discord voice audio to Gemini Live', {
          guildId: this.guildId,
          channelId: this.channelId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private handleLiveEvent(event: LiveClientEvent) {
    if (event.type === 'avatar.lipsync') {
      if (this.bypassVoiceChanger) {
        this.pendingAvatarLipSync = event.payload;
      } else {
        broadcastAvatarEvent(event);
      }
    } else if (event.type === 'avatar.state' || event.type === 'avatar.expression' || event.type === 'avatar.model.change') {
      broadcastAvatarEvent(event);
    }
    if (event.type === 'avatar.state' && event.payload.state === 'idle' && this.usageReservation && this.usage) {
      const reservation = this.usageReservation;
      this.usageReservation = null;
      const inputSeconds = Math.max(0, this.diagnostics.geminiInputBytes - this.usageInputBaseline) / (GEMINI_INPUT_RATE * 2);
      const outputSeconds = Math.max(0, this.diagnostics.geminiOutputBytes - this.usageOutputBaseline) / (GEMINI_OUTPUT_RATE * 2);
      void this.usage.platform.reconcileUsage(reservation, voiceCredits(inputSeconds, outputSeconds, this.usage.secondsPerCredit), true);
    }
    if (event.type === 'avatar.state' && event.payload.state === 'listening') {
      if (!this.bypassVoiceChanger && !this.mixer.hasAssistantAudio()) {
        this.mixer.clearAssistant();
        this.voiceChanger.reset();
      }
      if (this.isPttMode()) {
        this.pttUiListener?.('idle');
      }
      return;
    }

    if (event.type === 'avatar.state' && event.payload.state === 'thinking' && this.bypassVoiceChanger && !this.isPttMode()) {
      this.extendUserInputMute(120_000);
      return;
    }

    if (event.type === 'avatar.state' && event.payload.state === 'speaking' && this.bypassVoiceChanger && !this.isPttMode()) {
      this.extendUserInputMute(120_000);
      return;
    }

    if (event.type === 'avatar.state' && event.payload.state === 'thinking' && this.bypassVoiceChanger && this.isPttMode()) {
      this.pttUiListener?.('processing');
      return;
    }

    if (event.type === 'status') {
      this.diagnostics.lastGeminiStatus = event.status;
      this.diagnostics.lastGeminiStatusAt = new Date().toISOString();
      this.diagnostics.lastGeminiStatusReason = event.reason ?? null;
      if (event.status === 'error' || event.reason) {
        this.recordError(event.reason ?? event.status);
      }
      return;
    }

    if (event.type !== 'audio') {
      return;
    }
    if (this.activeInputUsers.size > 0 && !this.bypassVoiceChanger) {
      this.mixer.clearAssistant();
      this.voiceChanger.reset();
      return;
    }
    const pcm = Buffer.from(event.data, 'base64');
    const discordReady = event.mimeType === 'audio/pcm;rate=48000;channels=2';
    this.diagnostics.geminiAudioEvents += 1;
    this.diagnostics.geminiOutputBytes += pcm.length;
    this.diagnostics.lastGeminiAudioAt = new Date().toISOString();
    logger.debug('Discord voice received assistant audio', {
      guildId: this.guildId,
      channelId: this.channelId,
      pcmBytes: pcm.length,
      discordReady,
      audioEvents: this.diagnostics.geminiAudioEvents,
      totalGeminiOutputBytes: this.diagnostics.geminiOutputBytes
    });
    if (this.bypassVoiceChanger) {
      this.enqueueAssistantSpeech(pcm, discordReady);
      return;
    }
    this.voiceChanger.process(pcm);
  }

  private extendUserInputMute(durationMs: number) {
    this.userInputMutedUntil = Math.max(this.userInputMutedUntil, Date.now() + durationMs);
  }

  private isAssistantSpeaking() {
    return this.localTtsPlaying || this.mixer.hasAssistantAudio();
  }

  private enqueueAssistantSpeech(pcm: Buffer, discordReady = false) {
    if (this.destroyed) return;
    if (this.activeInputUsers.size > 0 && !discordReady) return;
    const discordPcm = discordReady ? pcm : upsampleGeminiPcmForDiscord(pcm);
    if (discordReady) {
      const playbackMs = pcmDurationMs(discordPcm, DISCORD_RATE, DISCORD_CHANNELS);
      this.extendUserInputMute(playbackMs + this.config.LUNA_ECHO_MUTE_MS);
    }
    if (discordPcm.length <= 0) return;

    if (this.bypassVoiceChanger && discordReady) {
      this.localTtsQueue = this.localTtsQueue
        .then(() => this.playCompleteLocalTts(discordPcm))
        .catch((error) => {
          this.recordError(error instanceof Error ? error.message : String(error));
          logger.error('Discord voice local TTS playback failed', {
            guildId: this.guildId,
            channelId: this.channelId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      return;
    }

    logger.debug('Discord voice writing audio to Discord output', {
      guildId: this.guildId,
      channelId: this.channelId,
      pcmBytes: discordPcm.length,
      playerStatus: this.diagnostics.playerStatus,
      connectionStatus: this.connection?.state.status ?? this.diagnostics.connectionStatus
    });
    this.mixer.enqueueAssistant(discordPcm);
    this.diagnostics.discordOutputBytes += discordPcm.length;
    this.diagnostics.lastDiscordWriteAt = new Date().toISOString();
  }

  /** Play one full TTS clip in a single stream (no 20ms mixer chunking). */
  private playCompleteLocalTts(discordPcm: Buffer): Promise<void> {
    return new Promise((resolve) => {
      this.localTtsPlaying = true;
      this.mixer.clearAssistant();

      const durationMs = pcmDurationMs(discordPcm, DISCORD_RATE, DISCORD_CHANNELS);
      const lipSync = this.pendingAvatarLipSync;
      this.pendingAvatarLipSync = null;
      const stream = Readable.from(discordPcm);
      const resource = createAudioResource(stream, { inputType: StreamType.Raw });

      const finish = () => {
        if (!this.localTtsPlaying) return;
        this.localTtsPlaying = false;
        cleanup();
        resolve();
      };

      const cleanup = () => {
        this.player.off('stateChange', onStateChange);
        clearTimeout(fallbackTimer);
      };

      let sawPlaying = false;
      const onStateChange = (_old: AudioPlayerState, newState: AudioPlayerState) => {
        if (newState.status === AudioPlayerStatus.Playing) {
          if (!sawPlaying && lipSync) {
            broadcastAvatarEvent({ type: 'avatar.lipsync', payload: lipSync });
          }
          sawPlaying = true;
        }
        if (sawPlaying && newState.status === AudioPlayerStatus.Idle) {
          finish();
        }
      };

      const fallbackTimer = setTimeout(finish, durationMs + 1_000);
      fallbackTimer.unref?.();

      this.player.on('stateChange', onStateChange);
      this.player.play(resource);
      this.connection?.subscribe(this.player);
      this.diagnostics.discordOutputBytes += discordPcm.length;
      this.diagnostics.lastDiscordWriteAt = new Date().toISOString();
      logger.info('Discord voice playing complete local TTS clip', {
        guildId: this.guildId,
        channelId: this.channelId,
        pcmBytes: discordPcm.length,
        durationMs
      });
    });
  }

  async playSong(query: string, options: { volume?: number } = {}) {
    const normalized = query.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      logger.warn('Discord music playback rejected empty query', {
        guildId: this.guildId,
        channelId: this.channelId
      });
      return { ok: false, error: 'empty_query' };
    }
    logger.info('Discord music playback requested', {
      guildId: this.guildId,
      channelId: this.channelId,
      query: normalized,
      connectionStatus: this.connection?.state.status ?? null,
      destroyed: this.destroyed
    });
    if (this.destroyed || !this.connection || this.connection.state.status !== VoiceConnectionStatus.Ready) {
      logger.warn('Discord music playback rejected because voice is not ready', {
        guildId: this.guildId,
        channelId: this.channelId,
        connectionStatus: this.connection?.state.status ?? null,
        destroyed: this.destroyed
      });
      return { ok: false, error: 'discord_voice_not_ready' };
    }

    const volume = options.volume ?? this.musicStatus.volume;
    this.mixer.setMusicVolume(volume);
    const shouldQueue = this.isMusicActive();
    if (!shouldQueue) {
      this.musicStatus = {
        ...this.musicStatus,
        state: 'searching',
        title: null,
        url: null,
        durationSeconds: null,
        volume,
        startedAt: null,
        positionSeconds: 0,
        seekOffsetSeconds: 0,
        lastError: null,
        queuedBytes: 0
      };
    } else {
      this.musicStatus = {
        ...this.musicStatus,
        volume,
        positionSeconds: this.currentMusicPositionSeconds(),
        lastError: null
      };
    }

    let track: YoutubeTrack;
    try {
      track = await resolveYoutubeTrack(this.config, normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.musicStatus = shouldQueue
        ? { ...this.musicStatus, positionSeconds: this.currentMusicPositionSeconds(), lastError: message }
        : { ...this.musicStatus, state: 'error', lastError: message };
      this.recordError(message);
      logger.warn('Discord music YouTube resolution failed', {
        guildId: this.guildId,
        channelId: this.channelId,
        query: normalized,
        ytDlpBinary: this.config.YTDLP_BINARY,
        playerClients: this.config.YTDLP_PLAYER_CLIENTS,
        cookiesConfigured: Boolean(
          (this.config.YTDLP_COOKIES_PATH && isRegularFile(this.config.YTDLP_COOKIES_PATH))
          || this.config.YTDLP_COOKIES_FROM_BROWSER
        ),
        error: message
      });
      return { ok: false, error: message };
    }

    if (shouldQueue) {
      const entry = this.enqueueMusicTrack(track, normalized);
      logger.info('Queued Discord music track', {
        guildId: this.guildId,
        channelId: this.channelId,
        query: normalized,
        title: track.title,
        url: track.url,
        queueLength: this.musicQueue.length
      });
      return {
        ok: true,
        queued: true,
        title: entry.title,
        url: entry.url,
        durationSeconds: entry.durationSeconds,
        queueLength: this.musicQueue.length
      };
    }

    logger.info('Discord music resolved track', {
      guildId: this.guildId,
      channelId: this.channelId,
      query: normalized,
      title: track.title,
      url: track.url,
      durationSeconds: track.durationSeconds
    });
    const started = this.playResolvedMusic(track, 0, { clearBufferedAudio: true, stopReason: 'replaced' });
    if (!started.ok) {
      return started;
    }

    logger.info('Started Discord music playback', {
      guildId: this.guildId,
      channelId: this.channelId,
      title: track.title,
      url: track.url
    });
    return { ok: true, title: track.title, url: track.url, durationSeconds: track.durationSeconds };
  }

  async stopMusic() {
    const wasActive = this.musicStatus.state === 'playing' || this.musicStatus.state === 'searching' || this.musicStatus.state === 'paused';
    this.stopMusicProcesses('requested');
    this.mixer.clearMusic();
    this.musicQueue.length = 0;
    this.musicStatus = {
      ...this.musicStatus,
      state: 'idle',
      startedAt: null,
      positionSeconds: 0,
      seekOffsetSeconds: 0,
      queuedBytes: 0,
      lastError: null
    };
    return { ok: true, stopped: wasActive };
  }

  async pauseMusic() {
    if (this.musicStatus.state !== 'playing') {
      return { ok: false, error: 'music_not_playing', state: this.musicStatus.state };
    }
    const positionSeconds = this.currentMusicPositionSeconds();
    this.musicStatus = {
      ...this.musicStatus,
      state: 'paused',
      positionSeconds,
      seekOffsetSeconds: positionSeconds,
      startedAt: null,
      queuedBytes: this.mixer.getQueuedMusicBytes()
    };
    this.stopMusicProcesses('paused');
    this.mixer.clearMusic();
    return { ok: true, state: 'paused', positionSeconds };
  }

  async resumeMusic() {
    if (this.musicStatus.state !== 'paused') {
      return { ok: false, error: 'music_not_paused', state: this.musicStatus.state };
    }
    const track = this.currentTrack();
    if (!track) {
      return { ok: false, error: 'no_track_to_resume' };
    }
    const positionSeconds = this.clampSeekPosition(this.musicStatus.positionSeconds);
    this.musicStatus = {
      ...this.musicStatus,
      state: 'playing',
      startedAt: new Date().toISOString(),
      seekOffsetSeconds: positionSeconds,
      positionSeconds,
      lastError: null
    };
    const started = this.startMusicDecoder(track, positionSeconds);
    if (!started.ok) {
      return started;
    }
    return { ok: true, state: 'playing', positionSeconds };
  }

  async nextMusic() {
    const next = this.musicQueue.shift();
    if (!next) {
      return { ok: false, error: 'music_queue_empty', state: this.musicStatus.state };
    }
    const current = this.currentTrack();
    if (current) {
      this.musicHistory.push(current);
    }
    const started = this.playResolvedMusic(next, 0, { clearBufferedAudio: true, stopReason: 'next' });
    if (!started.ok) {
      return started;
    }
    return {
      ok: true,
      state: 'playing',
      title: next.title,
      url: next.url,
      durationSeconds: next.durationSeconds,
      queueLength: this.musicQueue.length
    };
  }

  async previousMusic() {
    const previous = this.musicHistory.pop();
    if (!previous) {
      return { ok: false, error: 'music_history_empty', state: this.musicStatus.state };
    }
    const current = this.currentTrack();
    if (current) {
      this.musicQueue.unshift({
        ...current,
        requestedQuery: current.title,
        queuedAt: new Date().toISOString()
      });
    }
    const started = this.playResolvedMusic(previous, 0, { clearBufferedAudio: true, stopReason: 'previous' });
    if (!started.ok) {
      return started;
    }
    return {
      ok: true,
      state: 'playing',
      title: previous.title,
      url: previous.url,
      durationSeconds: previous.durationSeconds,
      queueLength: this.musicQueue.length
    };
  }

  async seekMusic(positionSeconds: number) {
    const track = this.currentTrack();
    if (!track) {
      return { ok: false, error: 'no_music_loaded' };
    }
    const clamped = this.clampSeekPosition(positionSeconds);
    this.stopMusicProcesses('seek');
    this.mixer.clearMusic();
    this.musicStatus = {
      ...this.musicStatus,
      state: 'playing',
      startedAt: new Date().toISOString(),
      seekOffsetSeconds: clamped,
      positionSeconds: clamped,
      lastError: null
    };
    const started = this.startMusicDecoder(track, clamped);
    if (!started.ok) {
      return started;
    }
    return { ok: true, state: 'playing', positionSeconds: clamped };
  }

  async setMusicVolume(volume: number) {
    const normalized = Math.max(0, Math.min(1, volume));
    this.mixer.setMusicVolume(normalized);
    this.musicStatus = {
      ...this.musicStatus,
      volume: normalized,
      positionSeconds: this.currentMusicPositionSeconds()
    };
    return { ok: true, volume: normalized };
  }

  async setMusicLoop(enabled: boolean) {
    this.musicStatus = {
      ...this.musicStatus,
      loopCurrent: enabled,
      positionSeconds: this.currentMusicPositionSeconds()
    };
    return { ok: true, loopCurrent: enabled };
  }

  async leaveVoiceChannel() {
    return this.leaveVoice();
  }

  getMusicStatus(): Record<string, unknown> {
    return {
      ...this.musicStatus,
      positionSeconds: this.currentMusicPositionSeconds(),
      queuedBytes: this.mixer.getQueuedMusicBytes(),
      queue: this.musicQueue.map((entry, index) => ({
        index,
        title: entry.title,
        url: entry.url,
        durationSeconds: entry.durationSeconds,
        requestedQuery: entry.requestedQuery,
        queuedAt: entry.queuedAt
      })),
      queueLength: this.musicQueue.length,
      historyLength: this.musicHistory.length
    };
  }

  private playResolvedMusic(track: YoutubeTrack, positionSeconds: number, options: { clearBufferedAudio: boolean; stopReason: string }): Record<string, unknown> {
    this.stopMusicProcesses(options.stopReason);
    if (options.clearBufferedAudio) {
      this.mixer.clearMusic();
    }
    this.musicStopRequested = false;
    this.musicStatus = {
      ...this.musicStatus,
      state: 'playing',
      title: track.title,
      url: track.url,
      durationSeconds: track.durationSeconds,
      startedAt: new Date().toISOString(),
      positionSeconds,
      seekOffsetSeconds: positionSeconds,
      lastError: null,
      queuedBytes: this.mixer.getQueuedMusicBytes()
    };
    return this.startMusicDecoder(track, positionSeconds);
  }

  private startMusicDecoder(track: YoutubeTrack, positionSeconds: number): Record<string, unknown> {
    const seekArgs = positionSeconds > 0 ? ['-ss', formatSeconds(positionSeconds)] : [];
    const ytDlp = spawn(this.config.YTDLP_BINARY, [
      '-f', YTDLP_AUDIO_FORMAT,
      '--no-playlist',
      '--no-warnings',
      ...ytDlpCommonArgs(this.config, track.playerClients),
      '-o', '-',
      track.url
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ffmpeg = spawn(this.config.FFMPEG_BINARY, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-i', 'pipe:0',
      ...seekArgs,
      '-vn',
      '-f', 's16le',
      '-ar', String(DISCORD_RATE),
      '-ac', String(DISCORD_CHANNELS),
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.musicYtDlp = ytDlp;
    this.musicFfmpeg = ffmpeg;
    this.musicStopRequested = false;
    logger.info('Discord music decoder processes started', {
      guildId: this.guildId,
      channelId: this.channelId,
      ytDlpBinary: this.config.YTDLP_BINARY,
      ffmpegBinary: this.config.FFMPEG_BINARY,
      title: track.title,
      positionSeconds
    });
    let ytDlpStderr = '';
    let ffmpegStderr = '';
    let loggedFirstMusicChunk = false;
    const failPlayback = (source: string, error: string) => {
      if (this.musicStopRequested || (this.musicYtDlp !== ytDlp && this.musicFfmpeg !== ffmpeg)) {
        return;
      }
      const message = `${source}: ${error}`;
      this.musicStatus = { ...this.musicStatus, state: 'error', lastError: message, positionSeconds: this.currentMusicPositionSeconds() };
      this.recordError(message);
      logger.warn('Discord music playback failed', {
        guildId: this.guildId,
        channelId: this.channelId,
        source,
        error
      });
      this.stopMusicProcesses('error');
      this.mixer.clearMusic();
    };

    ytDlp.stderr?.on('data', (chunk: Buffer) => {
      ytDlpStderr = appendLimited(ytDlpStderr, chunk.toString('utf8'));
    });
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      ffmpegStderr = appendLimited(ffmpegStderr, chunk.toString('utf8'));
    });
    ytDlp.once('error', (error) => failPlayback('yt-dlp', error.message));
    ffmpeg.once('error', (error) => failPlayback('ffmpeg', error.message));
    ytDlp.once('close', (code) => {
      if (this.musicYtDlp !== ytDlp || this.musicStopRequested) {
        return;
      }
      if (code && code !== 0) {
        failPlayback('yt-dlp', compactYtDlpError(ytDlpStderr.trim() || `exited with code ${code}`));
      }
    });
    ffmpeg.once('close', (code) => {
      if (this.musicFfmpeg !== ffmpeg || this.musicStopRequested) {
        return;
      }
      if (code && code !== 0) {
        failPlayback('ffmpeg', ffmpegStderr.trim() || `exited with code ${code}`);
        return;
      }
      this.finishMusicTrack(track);
    });
    ffmpeg.stdin?.once('error', () => {
      // The decoder can close stdin while yt-dlp is still unwinding after stop/error.
    });
    if (!ytDlp.stdout || !ffmpeg.stdin || !ffmpeg.stdout) {
      failPlayback('process', 'failed_to_open_audio_pipes');
      return { ok: false, error: 'failed_to_open_audio_pipes' };
    }
    ytDlp.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      if (this.musicFfmpeg !== ffmpeg || this.musicStopRequested || this.musicStatus.state !== 'playing') {
        return;
      }
      if (!loggedFirstMusicChunk) {
        loggedFirstMusicChunk = true;
        logger.info('Discord music decoded first PCM chunk', {
          guildId: this.guildId,
          channelId: this.channelId,
          title: track.title,
          positionSeconds,
          pcmBytes: chunk.length
        });
      }
      this.mixer.enqueueMusic(chunk);
      this.musicStatus.queuedBytes = this.mixer.getQueuedMusicBytes();
      if (this.musicStatus.queuedBytes >= MUSIC_QUEUE_HIGH_WATER_BYTES) {
        ffmpeg.stdout.pause();
      }
    });
    return { ok: true };
  }

  private finishMusicTrack(track: YoutubeTrack) {
    this.musicYtDlp = null;
    this.musicFfmpeg = null;
    const positionSeconds = this.currentMusicPositionSeconds();

    if (this.musicStatus.loopCurrent) {
      const started = this.playResolvedMusic(track, 0, { clearBufferedAudio: false, stopReason: 'loop' });
      if (!started.ok) {
        this.musicStatus = {
          ...this.musicStatus,
          state: 'error',
          startedAt: null,
          positionSeconds,
          queuedBytes: this.mixer.getQueuedMusicBytes(),
          lastError: typeof started.error === 'string' ? started.error : 'failed_to_loop_music'
        };
      }
      return;
    }

    const next = this.musicQueue.shift();
    if (next) {
      this.musicHistory.push(track);
      const started = this.playResolvedMusic(next, 0, { clearBufferedAudio: false, stopReason: 'queue' });
      if (!started.ok) {
        this.musicStatus = {
          ...this.musicStatus,
          state: 'error',
          startedAt: null,
          positionSeconds,
          queuedBytes: this.mixer.getQueuedMusicBytes(),
          lastError: typeof started.error === 'string' ? started.error : 'failed_to_play_next_music'
        };
      }
      return;
    }

    this.musicStatus = {
      ...this.musicStatus,
      state: 'idle',
      startedAt: null,
      positionSeconds,
      queuedBytes: this.mixer.getQueuedMusicBytes()
    };
  }

  private enqueueMusicTrack(track: YoutubeTrack, requestedQuery: string): DiscordMusicQueueEntry {
    const entry = {
      ...track,
      requestedQuery,
      queuedAt: new Date().toISOString()
    };
    this.musicQueue.push(entry);
    return entry;
  }

  private stopMusicProcesses(reason: string) {
    this.musicStopRequested = true;
    const ytDlp = this.musicYtDlp;
    const ffmpeg = this.musicFfmpeg;
    this.musicYtDlp = null;
    this.musicFfmpeg = null;
    ytDlp?.stdout?.destroy();
    ytDlp?.stderr?.destroy();
    ffmpeg?.stdin?.destroy();
    ffmpeg?.stdout?.destroy();
    ffmpeg?.stderr?.destroy();
    if (ytDlp && !ytDlp.killed) {
      ytDlp.kill('SIGTERM');
    }
    if (ffmpeg && !ffmpeg.killed) {
      ffmpeg.kill('SIGTERM');
    }
    if (reason !== 'replaced') {
      logger.info('Stopped Discord music playback', {
        guildId: this.guildId,
        channelId: this.channelId,
        reason
      });
    }
  }

  private currentTrack(): YoutubeTrack | null {
    if (!this.musicStatus.url || !this.musicStatus.title) {
      return null;
    }
    return {
      title: this.musicStatus.title,
      url: this.musicStatus.url,
      durationSeconds: this.musicStatus.durationSeconds
    };
  }

  private isMusicActive() {
    return this.musicStatus.state === 'searching' || this.musicStatus.state === 'playing' || this.musicStatus.state === 'paused';
  }

  private currentMusicPositionSeconds() {
    if (this.musicStatus.state !== 'playing' || !this.musicStatus.startedAt) {
      return this.musicStatus.positionSeconds;
    }
    const elapsed = (Date.now() - Date.parse(this.musicStatus.startedAt)) / 1000;
    return this.clampSeekPosition(this.musicStatus.seekOffsetSeconds + Math.max(0, elapsed));
  }

  private clampSeekPosition(positionSeconds: number) {
    const max = this.musicStatus.durationSeconds;
    const upper = typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.max(0, max - 1) : 24 * 60 * 60;
    return Math.max(0, Math.min(upper, positionSeconds));
  }

  private recordError(error: string) {
    this.diagnostics.lastError = error;
  }
}

interface YoutubeTrack {
  title: string;
  url: string;
  durationSeconds: number | null;
  playerClients?: string;
}

interface PcmQueueEntry {
  buffer: Buffer;
  offset: number;
}

interface VoiceChangerConfig {
  enabled: boolean;
  name: string;
  ffmpegFilter: string;
}

class DiscordVoiceChanger {
  private profile: VoiceChangerConfig;
  private processor: ReturnType<typeof spawn> | null = null;
  private available = true;
  private destroyed = false;
  private stderr = '';
  private inputBytes = 0;
  private outputBytes = 0;
  private lastError: string | null = null;
  private readonly configChangeHandler = () => this.reloadProfile();
  private readonly watchesConfig: boolean;

  constructor(
    private readonly ffmpegBinary: string,
    private readonly configPath: string,
    private readonly onAudio: (pcm24k: Buffer) => void,
    profileOverride?: VoiceChangerConfig
  ) {
    this.profile = profileOverride ?? loadVoiceChangerConfig(configPath);
    this.watchesConfig = !profileOverride;
    if (this.watchesConfig) watchFile(this.configPath, { interval: 1_000 }, this.configChangeHandler);
  }

  process(pcm24k: Buffer) {
    if (!pcm24k.length || this.destroyed) return;
    this.inputBytes += pcm24k.length;
    if (!this.profile.enabled || !this.available) {
      this.onAudio(pcm24k);
      return;
    }
    this.ensureProcessor();
    const stdin = this.processor?.stdin;
    if (!stdin?.writable) {
      this.onAudio(pcm24k);
      return;
    }
    stdin.write(pcm24k);
  }

  reset() {
    this.stopProcessor();
  }

  destroy() {
    this.destroyed = true;
    if (this.watchesConfig) unwatchFile(this.configPath, this.configChangeHandler);
    this.stopProcessor();
  }

  getStatus() {
    return {
      configured: this.profile.enabled,
      active: this.profile.enabled && this.available && Boolean(this.processor),
      available: this.available,
      name: this.profile.name,
      inputBytes: this.inputBytes,
      outputBytes: this.outputBytes,
      lastError: this.lastError
    };
  }

  private ensureProcessor() {
    if (this.processor || this.destroyed) return;
    this.stderr = '';
    const processor = spawn(this.ffmpegBinary, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 's16le',
      '-ar', String(GEMINI_OUTPUT_RATE),
      '-ac', '1',
      '-i', 'pipe:0',
      '-af', this.profile.ffmpegFilter,
      '-f', 's16le',
      '-ar', String(GEMINI_OUTPUT_RATE),
      '-ac', '1',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.processor = processor;
    processor.stdout.on('data', (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      this.onAudio(chunk);
    });
    processor.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2_000);
    });
    processor.once('error', (error) => this.disableAfterFailure(processor, error.message));
    processor.once('close', (code) => {
      if (this.processor !== processor) return;
      this.disableAfterFailure(processor, this.stderr.trim() || `ffmpeg exited with code ${code}`);
    });
  }

  private reloadProfile() {
    if (this.destroyed) return;
    const next = loadVoiceChangerConfig(this.configPath);
    if (
      next.enabled === this.profile.enabled
      && next.name === this.profile.name
      && next.ffmpegFilter === this.profile.ffmpegFilter
    ) return;
    this.stopProcessor();
    this.profile = next;
    this.available = true;
    this.lastError = null;
  }

  private disableAfterFailure(processor: ReturnType<typeof spawn>, error: string) {
    if (this.processor !== processor) return;
    this.processor = null;
    this.available = false;
    this.lastError = error;
    logger.warn('Discord voice changer failed; bypassing effect', {
      name: this.profile.name,
      error
    });
  }

  private stopProcessor() {
    const processor = this.processor;
    this.processor = null;
    if (!processor) return;
    processor.stdin?.end();
    processor.kill('SIGKILL');
  }
}

function loadVoiceChangerConfig(configPath: string): VoiceChangerConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<VoiceChangerConfig>;
    if (typeof parsed.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error('name must be a non-empty string');
    if (typeof parsed.ffmpegFilter !== 'string' || !parsed.ffmpegFilter.trim() || parsed.ffmpegFilter.length > 2_000) {
      throw new Error('ffmpegFilter must be a non-empty string of at most 2000 characters');
    }
    return {
      enabled: parsed.enabled,
      name: parsed.name.trim(),
      ffmpegFilter: parsed.ffmpegFilter.trim()
    };
  } catch (error) {
    logger.warn('Could not load Discord voice changer configuration; using bypass mode', {
      configPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return { enabled: false, name: 'bypass', ffmpegFilter: 'anull' };
  }
}

function isVoiceToolEnabled(name: string, features: PlanFeatures) {
  if (name === 'searchWeb') return features.webSearch;
  if (['playSong', 'pauseMusic', 'resumeMusic', 'stopMusic', 'nextMusic', 'previousMusic', 'seekMusic', 'setMusicVolume', 'setMusicLoop', 'getMusicStatus'].includes(name)) return features.music;
  return true;
}

class DiscordPcmMixer {
  private output: PassThrough | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly assistantQueue: PcmQueueEntry[] = [];
  private readonly musicQueue: PcmQueueEntry[] = [];
  private assistantQueuedBytes = 0;
  private musicQueuedBytes = 0;
  private assistantActiveUntil = 0;
  private idleTicks = 0;
  private musicVolume: number;
  private readonly duckVolume: number;

  constructor(private readonly options: {
    musicVolume: number;
    duckVolume: number;
    onStart: (stream: PassThrough) => void;
    onMusicQueueChange: (queuedBytes: number) => void;
  }) {
    this.musicVolume = options.musicVolume;
    this.duckVolume = options.duckVolume;
  }

  setMusicVolume(volume: number) {
    this.musicVolume = Math.max(0, Math.min(1, volume));
  }

  enqueueAssistant(buffer: Buffer) {
    if (!buffer.length) {
      return;
    }
    const aligned = alignToFrame(buffer);
    this.assistantQueue.push({ buffer: aligned, offset: 0 });
    this.assistantQueuedBytes += aligned.length;
    this.assistantActiveUntil = Date.now() + ASSISTANT_DUCK_HOLD_MS;
    this.ensureStarted();
  }

  enqueueMusic(buffer: Buffer) {
    if (!buffer.length) {
      return;
    }
    this.musicQueue.push({ buffer, offset: 0 });
    this.musicQueuedBytes += buffer.length;
    this.options.onMusicQueueChange(this.musicQueuedBytes);
    this.ensureStarted();
  }

  clearMusic() {
    this.musicQueue.length = 0;
    this.musicQueuedBytes = 0;
    this.options.onMusicQueueChange(0);
  }

  private assistantCarry = Buffer.alloc(0);

  clearAssistant() {
    this.assistantQueue.length = 0;
    this.assistantQueuedBytes = 0;
    this.assistantActiveUntil = 0;
    this.assistantCarry = Buffer.alloc(0);
  }

  hasAssistantAudio() {
    return this.assistantQueuedBytes > 0 || Date.now() <= this.assistantActiveUntil;
  }

  getQueuedMusicBytes() {
    return this.musicQueuedBytes;
  }

  destroy() {
    this.clearTimer();
    this.assistantQueue.length = 0;
    this.musicQueue.length = 0;
    this.assistantQueuedBytes = 0;
    this.musicQueuedBytes = 0;
    this.options.onMusicQueueChange(0);
    this.endOutput();
  }

  private ensureStarted() {
    if (!this.output || this.output.destroyed || this.output.writableEnded) {
      this.output = new PassThrough({ highWaterMark: 1024 * 1024 });
      this.options.onStart(this.output);
    }
    if (!this.timer) {
      this.idleTicks = 0;
      this.timer = setInterval(() => this.tick(), MIXER_FRAME_MS);
      this.timer.unref?.();
      this.tick();
    }
  }

  private tick() {
    const assistantFrame = this.readAssistantFrame();
    const musicFrame = this.readMusicFrame();
    const hasAssistant = Boolean(assistantFrame);
    const hasMusic = Boolean(musicFrame);

    if (!hasAssistant && !hasMusic) {
      this.idleTicks += 1;
      if (this.idleTicks * MIXER_FRAME_MS >= MIXER_IDLE_END_MS) {
        this.clearTimer();
        this.endOutput();
        return;
      }
      this.output?.write(Buffer.alloc(MIXER_FRAME_BYTES));
      return;
    }

    this.idleTicks = 0;
    const musicGain = Date.now() <= this.assistantActiveUntil ? this.duckVolume : this.musicVolume;
    this.output?.write(mixPcmFrames(assistantFrame, musicFrame, musicGain));
  }

  private readAssistantFrame() {
    const frame = readPcmFrame(
      this.assistantQueue,
      this.assistantQueuedBytes,
      (bytes) => { this.assistantQueuedBytes -= bytes; },
      this.assistantCarry,
      (carry) => { this.assistantCarry = Buffer.from(carry); }
    );
    if (this.assistantQueuedBytes > 0 || frame) {
      this.assistantActiveUntil = Date.now() + ASSISTANT_DUCK_HOLD_MS;
    }
    return frame;
  }

  private readMusicFrame() {
    const frame = readPcmFrame(this.musicQueue, this.musicQueuedBytes, (bytes) => {
      this.musicQueuedBytes -= bytes;
    });
    this.options.onMusicQueueChange(this.musicQueuedBytes);
    return frame;
  }

  private clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private endOutput() {
    if (!this.output) {
      return;
    }
    if (!this.output.destroyed && !this.output.writableEnded) {
      this.output.end();
    }
    this.output = null;
  }
}

function pcmDurationMs(pcm: Buffer, sampleRate: number, channels: number) {
  const bytesPerSecond = sampleRate * channels * 2;
  if (bytesPerSecond <= 0 || pcm.length <= 0) return 0;
  return Math.max(0, Math.round((pcm.length / bytesPerSecond) * 1000));
}

function alignToFrame(buffer: Buffer) {
  const remainder = buffer.length % MIXER_FRAME_BYTES;
  if (!remainder) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(MIXER_FRAME_BYTES - remainder)]);
}

function readPcmFrame(
  queue: PcmQueueEntry[],
  queuedBytes: number,
  onConsume: (bytes: number) => void,
  carry: Buffer = Buffer.alloc(0),
  onCarry?: (next: Buffer) => void
) {
  if (queuedBytes <= 0 && carry.length <= 0) {
    return null;
  }

  const frame = Buffer.alloc(MIXER_FRAME_BYTES);
  let written = 0;
  let consumed = 0;

  if (carry.length > 0) {
    const fromCarry = Math.min(carry.length, MIXER_FRAME_BYTES);
    carry.copy(frame, 0, 0, fromCarry);
    written += fromCarry;
    carry = carry.subarray(fromCarry);
  }

  while (written < MIXER_FRAME_BYTES && queue.length > 0) {
    const entry = queue[0];
    if (!entry) break;
    const available = entry.buffer.length - entry.offset;
    const toCopy = Math.min(available, MIXER_FRAME_BYTES - written);
    entry.buffer.copy(frame, written, entry.offset, entry.offset + toCopy);
    entry.offset += toCopy;
    written += toCopy;
    consumed += toCopy;
    if (entry.offset >= entry.buffer.length) queue.shift();
  }

  onCarry?.(carry);

  if (written < MIXER_FRAME_BYTES) {
    if (queue.length > 0 || carry.length > 0) return null;
    if (written === 0) return null;
  }

  if (consumed > 0) onConsume(consumed);
  return frame;
}

function mixPcmFrames(assistantFrame: Buffer | null, musicFrame: Buffer | null, musicGain: number) {
  if (!assistantFrame && !musicFrame) {
    return Buffer.alloc(MIXER_FRAME_BYTES);
  }
  const output = Buffer.allocUnsafe(MIXER_FRAME_BYTES);
  for (let offset = 0; offset < MIXER_FRAME_BYTES; offset += 2) {
    const assistantSample = assistantFrame ? assistantFrame.readInt16LE(offset) : 0;
    const musicSample = musicFrame ? Math.round(musicFrame.readInt16LE(offset) * musicGain) : 0;
    output.writeInt16LE(clampInt16(assistantSample + musicSample), offset);
  }
  return output;
}

function formatSeconds(seconds: number) {
  return seconds.toFixed(3);
}

async function resolveYoutubeTrack(config: AppConfig, query: string): Promise<YoutubeTrack> {
  if (isProbablyUrl(query)) {
    try {
      return await inspectYoutubeTrack(config, query, query);
    } catch (error) {
      throw new Error(compactYtDlpError(error));
    }
  }

  const search = await captureProcessOutput(config.YTDLP_BINARY, [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    ...ytDlpCommonArgs(config),
    `ytsearch${YTDLP_SEARCH_RESULTS}:${query}`
  ], 25_000);
  const parsedSearch = JSON.parse(search) as { entries?: unknown };
  const entries = Array.isArray(parsedSearch.entries) ? parsedSearch.entries : [];
  const candidates = entries
    .map((entry) => normalizeYoutubeSearchEntry(entry))
    .filter((entry): entry is YoutubeTrack => Boolean(entry));
  if (!candidates.length) {
    throw new Error('yt-dlp returned no YouTube search results');
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await inspectYoutubeTrack(config, candidate.url, candidate.title);
    } catch (error) {
      failures.push(`${candidate.title}: ${compactYtDlpError(error)}`);
    }
  }

  throw new Error(`No playable audio result found. ${failures.slice(0, 3).join(' | ')}`);
}

async function inspectYoutubeTrack(config: AppConfig, url: string, fallbackTitle: string): Promise<YoutubeTrack> {
  const playerClientOptions = [...new Set([config.YTDLP_PLAYER_CLIENTS.trim() || 'default', 'default'])];
  let lastError: unknown;
  for (const playerClients of playerClientOptions) {
    try {
      const output = await captureProcessOutput(config.YTDLP_BINARY, [
        '--dump-json',
        '--no-playlist',
        '--skip-download',
        '-f', YTDLP_AUDIO_FORMAT,
        ...ytDlpCommonArgs(config, playerClients),
        url
      ], 25_000);
      const line = output.split(/\r?\n/).find((candidate) => candidate.trim().startsWith('{'));
      if (!line) throw new Error('yt-dlp returned no track metadata');
      const parsed = JSON.parse(line) as {
        title?: unknown;
        webpage_url?: unknown;
        original_url?: unknown;
        duration?: unknown;
        requested_downloads?: unknown;
        requested_formats?: unknown;
        formats?: unknown;
      };
      if (!hasAudioFormat(parsed)) throw new Error('yt-dlp found the result, but it has no audio formats');
      const resolvedUrl = firstString(parsed.webpage_url, parsed.original_url);
      if (!resolvedUrl) throw new Error('yt-dlp track metadata did not include a YouTube URL');
      return {
        title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fallbackTitle,
        url: resolvedUrl,
        durationSeconds: typeof parsed.duration === 'number' && Number.isFinite(parsed.duration) ? parsed.duration : null,
        playerClients
      };
    } catch (error) {
      lastError = error;
      if (playerClients !== 'default') {
        logger.warn('yt-dlp configured player clients failed; retrying with current defaults', {
          configuredPlayerClients: playerClients,
          url,
          error: compactYtDlpError(error)
        });
      }
    }
  }
  throw lastError ?? new Error('yt-dlp could not inspect the YouTube track');
}

function normalizeYoutubeSearchEntry(entry: unknown): YoutubeTrack | null {
  const candidate = entry as { title?: unknown; url?: unknown; webpage_url?: unknown; id?: unknown; duration?: unknown };
  const rawUrl = firstString(candidate.webpage_url, candidate.url);
  const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : null;
  const url = rawUrl?.startsWith('http')
    ? rawUrl
    : id
      ? `https://www.youtube.com/watch?v=${id}`
      : null;
  if (!url) {
    return null;
  }
  return {
    title: typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim() : url,
    url,
    durationSeconds: typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) ? candidate.duration : null
  };
}

function hasAudioFormat(parsed: {
  requested_downloads?: unknown;
  requested_formats?: unknown;
  formats?: unknown;
}) {
  const requestedDownloads = Array.isArray(parsed.requested_downloads) ? parsed.requested_downloads : [];
  const requestedFormats = Array.isArray(parsed.requested_formats) ? parsed.requested_formats : [];
  const formats = Array.isArray(parsed.formats) ? parsed.formats : [];
  const allFormats = [...requestedDownloads, ...requestedFormats, ...formats];
  return allFormats.some((format) => {
    const candidate = format as { acodec?: unknown; audio_ext?: unknown; vcodec?: unknown };
    return (typeof candidate.acodec === 'string' && candidate.acodec !== 'none')
      || (typeof candidate.audio_ext === 'string' && candidate.audio_ext !== 'none')
      || (typeof candidate.vcodec === 'string' && candidate.vcodec === 'none');
  });
}

function ytDlpCommonArgs(config: AppConfig, playerClients = config.YTDLP_PLAYER_CLIENTS) {
  const args: string[] = [
    '--remote-components',
    config.YTDLP_REMOTE_COMPONENTS,
    '--js-runtimes',
    config.YTDLP_JS_RUNTIME,
    '--extractor-args',
    `youtube:player_client=${playerClients}`
  ];
  const cookiesPath = config.YTDLP_COOKIES_PATH?.trim();
  if (cookiesPath && isRegularFile(cookiesPath)) {
    const writableCookiesPath = prepareWritableCookiesFile(cookiesPath);
    if (writableCookiesPath) {
      args.push('--cookies', writableCookiesPath);
    }
  }
  const cookiesFromBrowser = config.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (cookiesFromBrowser) {
    args.push('--cookies-from-browser', cookiesFromBrowser);
  }
  const potProviderUrl = config.YTDLP_POT_PROVIDER_URL?.trim();
  if (potProviderUrl) {
    args.push(
      '--extractor-args',
      `youtubepot-bgutilhttp:base_url=${potProviderUrl}`
    );
  }
  return args;
}

function isRegularFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function prepareWritableCookiesFile(sourcePath: string) {
  try {
    const directory = join(tmpdir(), 'giada-yt-dlp');
    const runtimePath = join(directory, `youtube-cookies-${process.pid}.txt`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const sourceModifiedAt = statSync(sourcePath).mtimeMs;
    const runtimeModifiedAt = isRegularFile(runtimePath) ? statSync(runtimePath).mtimeMs : -1;
    if (sourceModifiedAt > runtimeModifiedAt) {
      copyFileSync(sourcePath, runtimePath);
      chmodSync(runtimePath, 0o600);
      logger.info('Copied read-only yt-dlp cookies to writable runtime storage', {
        sourcePath,
        runtimePath
      });
    }
    return runtimePath;
  } catch (error) {
    logger.warn('Could not prepare writable yt-dlp cookies file; continuing without cookies', {
      sourcePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function compactYtDlpError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const errorLine = raw.split(/\r?\n/).reverse().find((line) => line.startsWith('ERROR:')) ?? raw.split(/\r?\n/).find(Boolean) ?? raw;
  if (/Sign in to confirm you.re not a bot|cookies-from-browser|authentication/i.test(raw)) {
    return 'YouTube requires authenticated cookies for this server IP. Export fresh Netscape-format cookies to the configured YTDLP_COOKIES_PATH and restart the service.';
  }
  if (/Read-only file system.*cookies/i.test(raw)) {
    return 'yt-dlp could not update its cookie jar because the configured file is read-only. Restart with the writable runtime-cookie copy enabled.';
  }
  if (/HTTP Error 403|Forbidden|unable to download video data/i.test(raw)) {
    return 'YouTube blocked the media download with HTTP 403. Verify fresh cookies, Deno JS challenge support, and yt-dlp EJS remote components; a PO-token provider may still be required.';
  }
  if (/Precondition check failed|Signature extraction failed|Requested format is not available|Only images are available/i.test(raw)) {
    return `YouTube audio extraction failed (${errorLine.replace(/^ERROR:\s*/, '')}). Updating yt-dlp may be required.`;
  }
  return errorLine.replace(/^ERROR:\s*/, '').slice(0, 500);
}

function captureProcessOutput(command: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    timeout.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString('utf8'), 1024 * 1024);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString('utf8'));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code && code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function appendLimited(current: string, next: string, limit = 4000) {
  const combined = current + next;
  return combined.length > limit ? combined.slice(combined.length - limit) : combined;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function isProbablyUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function downsampleDiscordPcmForGemini(input: Buffer) {
  const completeFrames = Math.floor(input.length / (DISCORD_CHANNELS * 2));
  const outputFrames = Math.floor(completeFrames * GEMINI_INPUT_RATE / DISCORD_RATE);
  const output = Buffer.allocUnsafe(outputFrames * 2);

  for (let frame = 0; frame < outputFrames; frame += 1) {
    const sourceFrame = frame * DISCORD_RATE / GEMINI_INPUT_RATE;
    const startFrame = Math.floor(sourceFrame);
    const endFrame = Math.min(completeFrames, Math.floor((frame + 1) * DISCORD_RATE / GEMINI_INPUT_RATE));
    let sum = 0;
    let count = 0;
    for (let index = startFrame; index < endFrame; index += 1) {
      const offset = index * DISCORD_CHANNELS * 2;
      sum += input.readInt16LE(offset);
      sum += input.readInt16LE(offset + 2);
      count += 2;
    }
    output.writeInt16LE(clampInt16(Math.round(sum / Math.max(count, 1))), frame * 2);
  }

  return output;
}

function upsampleGeminiPcmForDiscord(input: Buffer) {
  const inputFrames = Math.floor(input.length / 2);
  const outputFrames = Math.floor(inputFrames * DISCORD_RATE / GEMINI_OUTPUT_RATE);
  const output = Buffer.allocUnsafe(outputFrames * DISCORD_CHANNELS * 2);

  for (let frame = 0; frame < outputFrames; frame += 1) {
    const sourceFrame = Math.min(inputFrames - 1, Math.floor(frame * GEMINI_OUTPUT_RATE / DISCORD_RATE));
    const sample = input.readInt16LE(sourceFrame * 2);
    const offset = frame * DISCORD_CHANNELS * 2;
    output.writeInt16LE(sample, offset);
    output.writeInt16LE(sample, offset + 2);
  }

  return output;
}

function clampInt16(value: number) {
  return Math.max(-32768, Math.min(32767, value));
}

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
