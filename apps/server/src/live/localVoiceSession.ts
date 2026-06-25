import { copyFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../config/env.js';
import type { MemoryStore } from '../memory/types.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import { GroqTextClient } from '../providers/groq.js';
import { publishActivity } from '../monitor/activityFeed.js';
import { logger } from '../logging/logger.js';
import { ConversationHistory } from './conversationHistory.js';
import { LocalVoiceService, resolveLocalVoicePaths, type LocalVoiceServiceConfig } from './localVoiceService.js';
import { parseWakePhrases, evaluateWakePhrase, isLikelyEchoTranscript } from './wakePhrase.js';
import { isLikelyNonsenseTranscript, sanitizeVoiceReply } from './voiceReply.js';
import type { LiveClientEvent, LiveInputEvent, LiveSurface, VoiceSpeakerContext } from './liveSession.js';
import { UserVoiceMemoryStore } from '../memory/userVoiceMemory.js';
import { updateUserVoiceMemory } from '../memory/updateUserVoiceMemory.js';
import { buildVoiceCallContextBlock, recordParticipantNames } from './voiceCallContext.js';

const INPUT_RATE = 16000;
const DISCORD_RATE = 48000;
const DISCORD_CHANNELS = 2;

export class LocalVoiceSessionManager {
  private emit: ((event: LiveClientEvent) => void) | null = null;
  private readonly groq: GroqTextClient;
  private readonly voice: LocalVoiceService;
  private readonly conversationHistory = new ConversationHistory(10);
  private readonly conversationBySpeaker = new Map<string, ConversationHistory>();
  private readonly participantDisplayNames = new Map<string, string>();
  private turnPcm = Buffer.alloc(0);
  private capturing = false;
  private processing = false;
  private inputQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private lastAssistantText = '';
  private awaitingCommandUntil = 0;
  private currentSpeaker: VoiceSpeakerContext | null = null;
  private readonly tempDir: string;
  private readonly userVoiceMemory: UserVoiceMemoryStore;

  constructor(
    private readonly config: AppConfig,
    _memory: MemoryStore,
    private readonly personality: PersonalityInstructionProvider
  ) {
    const paths = resolveLocalVoicePaths({
      pythonBinary: config.LOCAL_VOICE_PYTHON,
      voiceScriptPath: config.LOCAL_VOICE_SCRIPT,
      speakerWav: config.XTTS_SPEAKER_WAV
    });
    const serviceConfig: LocalVoiceServiceConfig = {
      ...paths,
      whisperModel: config.WHISPER_MODEL,
      ttsLanguage: config.XTTS_LANGUAGE,
      whisperLanguage: config.WHISPER_LANGUAGE,
      whisperInitialPrompt: config.WHISPER_INITIAL_PROMPT,
      whisperNoSpeechThreshold: config.WHISPER_NO_SPEECH_THRESHOLD,
      device: config.LOCAL_VOICE_DEVICE
    };
    this.voice = new LocalVoiceService(serviceConfig);
    this.groq = new GroqTextClient(config);
    this.userVoiceMemory = new UserVoiceMemoryStore(config.databasePath);
    this.tempDir = join(tmpdir(), 'giada-local-voice');
    mkdirSync(this.tempDir, { recursive: true });
    void this.voice.start().catch((error) => {
      logger.error('Failed to start local voice worker', {
        error: error instanceof Error ? error.message : String(error)
      });
      this.emitStatus('error', error instanceof Error ? error.message : String(error));
    });
  }

  setEmitter(emit: (event: LiveClientEvent) => void) {
    this.emit = emit;
  }

  emitCurrentStatus() {
    this.emitStatus(this.closed ? 'offline' : 'connected');
  }

  async connect(_surface: LiveSurface = 'desktop') {
    this.emitStatus('connected');
    this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
  }

  async handleInput(input: LiveInputEvent, surface: LiveSurface = 'desktop') {
    if (this.closed) return;
    if (input.type === 'interrupt') {
      this.turnPcm = Buffer.alloc(0);
      this.capturing = false;
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
      return;
    }
    if (input.type === 'text' && input.text?.trim()) {
      const text = input.text.trim();
      this.inputQueue = this.inputQueue.then(() => this.processTextTurn(text, surface)).catch((error) => {
        this.handleTurnError(error);
      });
      return;
    }
    if (input.type === 'activityStart') {
      this.turnPcm = Buffer.alloc(0);
      this.capturing = true;
      if (input.speaker) {
        this.currentSpeaker = input.speaker;
      }
      return;
    }
    if (input.type === 'audio' && input.data && this.capturing) {
      this.turnPcm = Buffer.concat([this.turnPcm, Buffer.from(input.data, 'base64')]);
      return;
    }
    if (input.type === 'activityEnd') {
      const pcm = this.turnPcm;
      const speaker = this.currentSpeaker;
      this.turnPcm = Buffer.alloc(0);
      this.capturing = false;
      this.currentSpeaker = null;
      if (!pcm.length) {
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        return;
      }
      this.inputQueue = this.inputQueue.then(() => this.processSpeechTurn(pcm, surface, speaker)).catch((error) => {
        this.handleTurnError(error);
      });
    }
  }

  close() {
    this.closed = true;
    this.turnPcm = Buffer.alloc(0);
    this.capturing = false;
    this.lastAssistantText = '';
    this.awaitingCommandUntil = 0;
    this.conversationBySpeaker.clear();
    this.participantDisplayNames.clear();
    void this.voice.close();
    this.emitStatus('offline');
  }

  dispose() {
    this.close();
  }

  private async processSpeechTurn(pcm16k: Buffer, surface: LiveSurface, speaker: VoiceSpeakerContext | null) {
    if (this.processing) return;
    this.processing = true;
    const audioSec = (pcm16k.length / (INPUT_RATE * 2)).toFixed(1);
    try {
      const turnStarted = Date.now();
      this.emit?.({ type: 'avatar.state', payload: { state: 'thinking' } });
      const wavPath = join(this.tempDir, `stt-${Date.now()}.wav`);
      const normalizedPcm = normalizeDiscordKrispPcm(pcm16k);
      const pcmPeak = measurePcmPeak(normalizedPcm);
      const pcmRms = measurePcmRms(normalizedPcm);
      writeWav16kMono(wavPath, normalizedPcm);
      const sttStarted = Date.now();
      const transcript = await this.voice.transcribe(wavPath);
      const sttMs = Date.now() - sttStarted;
      if (!transcript) {
        saveDebugWav(wavPath, join(dirname(this.config.databasePath), 'debug-audio'), this.config.LUNA_DEBUG_AUDIO);
      }
      safeUnlink(wavPath);
      if (!transcript) {
        const clipped = pcmPeak > 24000;
        publishActivity({
          level: 'info',
          title: 'No speech detected',
          detail: `${audioSec}s · peak ${pcmPeak} · rms ${Math.round(pcmRms)}${clipped ? ' · audio may be clipped' : ''}`
        });
        logger.info('Local voice STT returned empty transcript', { audioSec, pcmPeak, pcmRms, clipped, sttMs });
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        return;
      }
      publishActivity({ level: 'user', title: 'You said', detail: `${transcript} (${audioSec}s audio)` });
      if (isLikelyEchoTranscript(transcript, this.lastAssistantText)) {
        publishActivity({ level: 'info', title: 'Ignored echo', detail: transcript });
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        return;
      }
      if (/krisp noise suppression|my name is krisp/i.test(transcript)) {
        publishActivity({ level: 'warn', title: 'Ignored STT hallucination', detail: transcript });
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        return;
      }
      if (isLikelyNonsenseTranscript(transcript)) {
        publishActivity({ level: 'warn', title: 'Ignored nonsense transcript', detail: transcript });
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        return;
      }
      logger.info('Local voice transcribed user speech', { transcript: transcript.slice(0, 200), audioSec, sttMs });

      if (!this.config.LUNA_WAKE_REQUIRED) {
        this.emit?.({ type: 'transcript', speaker: 'user', text: transcript, final: true });
        await this.replyToUserText(transcript, surface, { turnStarted, sttMs, speaker });
        return;
      }

      const inCommandWindow = Date.now() <= this.awaitingCommandUntil;
      if (inCommandWindow) {
        this.awaitingCommandUntil = 0;
        publishActivity({ level: 'success', title: 'Question received', detail: transcript });
        this.emit?.({ type: 'transcript', speaker: 'user', text: transcript, final: true });
        await this.replyToUserText(transcript, surface, { speaker });
        return;
      }

      const wake = evaluateWakePhrase({
        text: transcript,
        phrases: this.config.wakePhrases,
        required: this.config.LUNA_WAKE_REQUIRED
      });
      if (!wake.accepted) {
        publishActivity({
          level: 'info',
          title: 'Heard but ignored (say wake phrase)',
          detail: `"${transcript}" — try "hey luna"`
        });
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        return;
      }

      if (wake.accepted && (wake.wakeOnly || this.config.LUNA_WAKE_MODE === 'split')) {
        if (this.config.LUNA_WAKE_MODE === 'split' && !wake.wakeOnly) {
          publishActivity({
            level: 'info',
            title: 'Wake first, then your question',
            detail: 'Say "hey luna", wait for Luna, then ask separately'
          });
        }
        publishActivity({
          level: 'success',
          title: 'Wake phrase detected',
          detail: `Speak your question after Luna answers (${this.config.LUNA_COMMAND_WINDOW_SEC}s)`
        });
        await this.openCommandWindow(surface);
        return;
      }

      publishActivity({ level: 'success', title: 'Wake phrase detected', detail: 'One reply, then back to sleep' });
      this.emit?.({ type: 'transcript', speaker: 'user', text: wake.text, final: true });
      await this.replyToUserText(wake.text, surface, { speaker });
    } finally {
      this.processing = false;
    }
  }

  private async processTextTurn(text: string, surface: LiveSurface) {
    if (this.processing) return;
    this.processing = true;
    try {
      this.emit?.({ type: 'avatar.state', payload: { state: 'thinking' } });
      await this.replyToUserText(text, surface);
    } finally {
      this.processing = false;
    }
  }

  private async replyToUserText(
    userText: string,
    surface: LiveSurface,
    timing?: { turnStarted?: number; sttMs?: number; speaker?: VoiceSpeakerContext | null }
  ) {
    const turnStarted = timing?.turnStarted ?? Date.now();
    const sttMs = timing?.sttMs ?? 0;
    const speaker = timing?.speaker ?? null;
    if (speaker) {
      recordParticipantNames(this.participantDisplayNames, speaker);
    }
    const history = this.historyForSpeaker(speaker);

    let memoryBlock = '';
    if (this.config.LUNA_USER_VOICE_MEMORY && speaker) {
      const record = this.userVoiceMemory.get(speaker.guildId, speaker.userId);
      if (record?.summary?.trim()) {
        memoryBlock = `\nWhat you remember about ${speaker.displayName} from past voice chats (bullet notes, may be incomplete):\n${record.summary}`;
      }
    }

    const callContextBlock = speaker
      ? buildVoiceCallContextBlock({
        speaker,
        conversationBySpeaker: this.conversationBySpeaker,
        participantNames: this.participantDisplayNames,
        otherMemoryNotes: this.otherParticipantMemoryNotes(speaker)
      })
      : '';

    const system = `${this.personality.buildInstruction(surface, { nsfwAllowed: true })}\nYou are speaking aloud in a Discord voice channel as Luna only. Your name is Luna — never Giada, never a generic assistant. Reply in at most 2 short sentences and under 40 words. Respond only to what the user actually said; do not invent names, facts, or context. When someone asks what another person in the call said, use the voice call context below. Stay in Luna's seductive voice.${memoryBlock}${callContextBlock}`;
    const historyPrompt = history.toPromptParts().map((part) => part.text ?? '').filter(Boolean).join('\n');
    const prompt = historyPrompt
      ? `${historyPrompt}\n\nCurrent user message: ${userText}`
      : userText;

    const llmStarted = Date.now();
    const reply = await this.groq.generate({
      apiKey: 'ollama',
      system,
      userText: prompt,
      maxCompletionTokens: 80,
      temperature: 0.35
    });
    const llmMs = Date.now() - llmStarted;
    logger.info('Local voice generated reply', { chars: reply.length, llmMs });
    const cleaned = sanitizeVoiceReply(reply);
    if (!cleaned) {
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
      return;
    }

    publishActivity({ level: 'assistant', title: 'Luna said', detail: cleaned });
    this.lastAssistantText = cleaned;

    history.add('user', userText);
    history.add('model', cleaned);
    this.emit?.({ type: 'transcript', speaker: 'assistant', text: cleaned, final: true });

    if (this.config.LUNA_USER_VOICE_MEMORY && speaker) {
      const existing = this.userVoiceMemory.get(speaker.guildId, speaker.userId);
      const recentHistory = history.snapshot();
      void updateUserVoiceMemory({
        store: this.userVoiceMemory,
        groq: this.groq,
        guildId: speaker.guildId,
        userId: speaker.userId,
        displayName: speaker.displayName,
        userSaid: userText,
        lunaReplied: cleaned,
        existingSummary: existing?.summary ?? null,
        recentHistory,
        callContext: callContextBlock
      }).then((summary) => {
        if (summary?.trim()) {
          publishActivity({
            level: 'info',
            title: `Remembering ${speaker.displayName}`,
            detail: summary
          });
        }
      }).catch((error) => {
        logger.warn('Failed to update Luna voice user memory', {
          guildId: speaker.guildId,
          userId: speaker.userId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    const { ttsMs, playbackMs } = await this.playSpokenLine(cleaned);
    const totalMs = Date.now() - turnStarted;
    publishActivity({
      level: 'info',
      title: 'Turn timing',
      detail: `STT ${sttMs}ms · LLM ${llmMs}ms · TTS ${ttsMs}ms · total ${totalMs}ms`,
      meta: { sttMs, llmMs, ttsMs, playbackMs, totalMs }
    });

    this.awaitingCommandUntil = 0;
    this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
  }

  private historyForSpeaker(speaker: VoiceSpeakerContext | null) {
    if (!speaker) {
      return this.conversationHistory;
    }
    const key = `${speaker.guildId}:${speaker.userId}`;
    let history = this.conversationBySpeaker.get(key);
    if (!history) {
      history = new ConversationHistory(12);
      this.conversationBySpeaker.set(key, history);
    }
    return history;
  }

  private otherParticipantMemoryNotes(speaker: VoiceSpeakerContext) {
    if (!this.config.LUNA_USER_VOICE_MEMORY) {
      return [];
    }
    return (speaker.othersInCall ?? [])
      .map((other) => {
        const record = this.userVoiceMemory.get(speaker.guildId, other.userId);
        if (!record?.summary?.trim()) {
          return null;
        }
        const bullets = record.summary.split('\n').filter(Boolean).slice(0, 3).join('; ');
        return `- ${other.displayName}: ${bullets}`;
      })
      .filter((line): line is string => Boolean(line));
  }

  private async openCommandWindow(surface: LiveSurface) {
    this.emit?.({ type: 'avatar.state', payload: { state: 'speaking' } });
    await this.playSpokenLine(this.config.LUNA_LISTENING_ACK, { publish: true });
    this.awaitingCommandUntil = Date.now() + this.config.LUNA_COMMAND_WINDOW_SEC * 1000;
    this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
  }

  private async playSpokenLine(text: string, options: { publish?: boolean } = {}) {
    const cleaned = text.trim();
    if (!cleaned || this.closed) return { ttsMs: 0, playbackMs: 0 };
    if (options.publish) {
      publishActivity({ level: 'assistant', title: 'Luna said', detail: cleaned });
    }
    this.lastAssistantText = cleaned;
    this.emit?.({ type: 'avatar.state', payload: { state: 'speaking' } });
    const outWav = join(this.tempDir, `tts-${Date.now()}.wav`);
    const ttsStarted = Date.now();
    await this.voice.synthesize(cleaned, outWav);
    const ttsMs = Date.now() - ttsStarted;
    const discordPcm = await wavToDiscordPcm(this.config.FFMPEG_BINARY, outWav);
    safeUnlink(outWav);
    this.emitFullPcmAudio(discordPcm);
    const playbackMs = pcmDurationMs(discordPcm, DISCORD_RATE, DISCORD_CHANNELS) + 1_000;
    await delay(playbackMs);
    return { ttsMs, playbackMs };
  }

  private emitFullPcmAudio(discordPcm: Buffer) {
    if (this.closed || !discordPcm.length) return;
    logger.info('Local voice playing full TTS clip', {
      pcmBytes: discordPcm.length,
      durationMs: pcmDurationMs(discordPcm, DISCORD_RATE, DISCORD_CHANNELS)
    });
    this.emit?.({
      type: 'audio',
      data: discordPcm.toString('base64'),
      mimeType: 'audio/pcm;rate=48000;channels=2'
    });
  }

  private handleTurnError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Local voice turn failed', { error: message });
    this.emitStatus('error', message);
    this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
  }

  private emitStatus(status: 'offline' | 'connecting' | 'connected' | 'error', reason?: string) {
    this.emit?.({ type: 'status', status, ...(reason ? { reason } : {}) });
  }
}

function measurePcmPeak(pcm: Buffer) {
  let peak = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }
  return peak;
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

/** Level Discord/Krisp audio for Whisper without clipping. */
function normalizeDiscordKrispPcm(pcm: Buffer, targetPeak = 14000, maxGain = 2.5) {
  if (pcm.length < 4) return pcm;
  const peak = measurePcmPeak(pcm);
  const silenceFloor = 80;
  if (peak < silenceFloor) return pcm;

  let gain = 1;
  if (peak > 22000) {
    gain = targetPeak / peak;
  } else if (peak < targetPeak * 0.85) {
    gain = Math.min(targetPeak / peak, maxGain);
  }
  if (gain >= 0.98 && gain <= 1.02) return pcm;

  const out = Buffer.allocUnsafe(pcm.length);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    out.writeInt16LE(clampInt16(Math.round(pcm.readInt16LE(offset) * gain)), offset);
  }
  return out;
}

function saveDebugWav(sourcePath: string, debugDir: string, keepAll: boolean) {
  try {
    mkdirSync(debugDir, { recursive: true });
    copyFileSync(sourcePath, join(debugDir, 'last-failed-stt.wav'));
    if (keepAll) {
      copyFileSync(sourcePath, join(debugDir, `stt-failed-${Date.now()}.wav`));
    }
  } catch (error) {
    logger.warn('Failed to save debug STT wav', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function clampInt16(value: number) {
  return Math.max(-32768, Math.min(32767, value));
}

function writeWav16kMono(path: string, pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(INPUT_RATE, 24);
  header.writeUInt32LE(INPUT_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

async function wavToDiscordPcm(ffmpegBinary: string, wavPath: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(ffmpegBinary, [
      '-hide_banner', '-loglevel', 'error',
      '-i', wavPath,
      '-af', 'aresample=48000:resampler=soxr',
      '-f', 's16le',
      '-ar', String(DISCORD_RATE),
      '-ac', String(DISCORD_CHANNELS),
      'pipe:1'
    ], { windowsHide: true });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) logger.warn('ffmpeg wav decode stderr', { message });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

function pcmDurationMs(pcm: Buffer, sampleRate: number, channels: number) {
  const bytesPerSecond = sampleRate * channels * 2;
  if (bytesPerSecond <= 0 || pcm.length <= 0) return 0;
  return Math.max(0, Math.round((pcm.length / bytesPerSecond) * 1000));
}

function safeUnlink(path: string) {
  try { unlinkSync(path); } catch { /* ignore */ }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
