import { copyFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../config/env.js';
import type { MemoryStore } from '../memory/types.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import { OllamaTextClient } from '../providers/ollamaText.js';
import { publishActivity } from '../monitor/activityFeed.js';
import { logger } from '../logging/logger.js';
import { ConversationHistory } from './conversationHistory.js';
import { LocalVoiceService, resolveLocalVoicePaths, type LocalVoiceServiceConfig } from './localVoiceService.js';
import { parseWakePhrases, evaluateWakePhrase, isLikelyEchoTranscript } from './wakePhrase.js';
import { isLikelyNonsenseTranscript, sanitizeVoiceReply } from './voiceReply.js';
import type { LiveClientEvent, LiveInputEvent, LiveSurface, VoiceSpeakerContext } from './liveSession.js';
import { UserVoiceMemoryStore } from '../memory/userVoiceMemory.js';
import { LunaLifeStore } from '../memory/lunaLifeStore.js';
import { updateUserVoiceMemory } from '../memory/updateUserVoiceMemory.js';
import { updateUserRelationship } from '../memory/updateUserRelationship.js';
import { buildRelationshipPromptBlock, buildAbsencePromptBlock, hoursSinceLastContact, mostRecentContactAt } from '../memory/relationshipBond.js';
import { updateLunaLife } from '../memory/updateLunaLife.js';
import { buildVoiceCallContextBlock, buildVoiceCallContextForMemory, recordParticipantNames } from './voiceCallContext.js';
import { FishAudioTts } from './fishAudioTts.js';
import { FISH_AUDIO_EXPRESSION_PROMPT, stripFishAudioTagsForDisplay } from './fishAudioExpressions.js';
import { analyzeFishTtsDelivery, buildFishDeliveryContext } from './fishAudioDelivery.js';
import { applyVoiceActionsToReply, mapActionToExpression, shouldReactWithMotion, stripRoleplayMarkupForSpeech } from './voiceActions.js';
import {
  buildAvatarAwarenessPromptBlock,
  resolveAvatarWardrobe,
  type AvatarWardrobePayload
} from './tuziAnheiWardrobe.js';
import {
  broadcastLunaTtsAudio,
  emitLunaTtsAudio,
  lunaTtsPlaybackMs,
  publishLunaTtsAvatarSync,
  wavToDiscordPcm
} from './lunaTtsOutput.js';
import {
  buildLunaInitiativePrompt,
  LUNA_INITIATIVE_JSON_SCHEMA,
  parseLunaInitiativeReply,
  pickInitiativeRelationship,
  type LunaInitiativeHost,
  type LunaInitiativeTrigger
} from './lunaInitiative.js';
import { LunaResearchStore } from '../memory/lunaResearchStore.js';
import { buildResearchContextBlock, buildMessageResearchBlock, buildResearchCapabilityBlock } from './researchForMessage.js';
import type { ConversationResearchContext } from '../research/conversationResearch.js';
import {
  fetchConversationTopic,
  formatConversationTopicBlock
} from '../research/conversationTopics.js';

export type { LunaInitiativeHost };

const INPUT_RATE = 16000;

export class LocalVoiceSessionManager {
  private emit: ((event: LiveClientEvent) => void) | null = null;
  private readonly ollama: OllamaTextClient;
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
  private readonly lunaLife: LunaLifeStore;
  private readonly lunaResearch: LunaResearchStore;
  private readonly fishTts: FishAudioTts | null;
  private initiativeHost: LunaInitiativeHost | null = null;
  private initiativeTimer: ReturnType<typeof setTimeout> | null = null;
  private joinInitiativeTimer: ReturnType<typeof setTimeout> | null = null;
  private initiativeGeneration = 0;
  private lastSpeechAt = Date.now();
  private vibeListening = false;
  private avatarWardrobe: AvatarWardrobePayload = { outfit: 'light', accessories: [] };

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
      device: config.LOCAL_VOICE_DEVICE,
      enableLocalTts: config.LUNA_TTS_PROVIDER !== 'fish',
      ...(config.LUNA_TTS_PROVIDER !== 'fish' ? { speakerWav: paths.speakerWav } : {})
    };
    this.voice = new LocalVoiceService(serviceConfig);
    this.ollama = new OllamaTextClient(config);
    this.userVoiceMemory = new UserVoiceMemoryStore(config.databasePath);
    this.lunaLife = new LunaLifeStore(config.databasePath);
    this.lunaResearch = new LunaResearchStore(config.databasePath);
    this.fishTts = config.LUNA_TTS_PROVIDER === 'fish' && config.FISH_AUDIO_API_KEY?.trim()
      ? new FishAudioTts({
        apiKey: config.FISH_AUDIO_API_KEY,
        referenceId: config.FISH_AUDIO_REFERENCE_ID,
        model: config.FISH_AUDIO_MODEL,
        prosodySpeed: config.FISH_AUDIO_PROSODY_SPEED,
        tempDir: join(tmpdir(), 'giada-fish-tts')
      })
      : null;
    if (config.LUNA_TTS_PROVIDER === 'fish' && !this.fishTts) {
      logger.warn('LUNA_TTS_PROVIDER=fish but FISH_AUDIO_API_KEY is missing; falling back to XTTS if available');
    }
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
    this.clearInitiativeTimer();
    this.initiativeHost = null;
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

  setInitiativeHost(host: LunaInitiativeHost | null) {
    this.initiativeHost = host;
    if (host?.isChannelAttached() && this.config.lunaAutonomousReachOut && !this.closed) {
      this.scheduleInitiative();
    } else {
      this.clearInitiativeTimer();
    }
  }

  notifyVoiceChannelAttached() {
    this.lastSpeechAt = Date.now();
    if (this.config.lunaAutonomousReachOut && !this.closed) {
      this.scheduleInitiative();
      this.scheduleJoinInitiative();
    }
  }

  notifyVoiceChannelDetached() {
    this.bumpInitiativeGeneration();
    this.clearInitiativeTimer();
    this.clearJoinInitiativeTimer();
  }

  isBusyForInitiative() {
    return this.processing || this.capturing || this.vibeListening;
  }

  isVibeListening() {
    return this.vibeListening;
  }

  async transcribePcmForEavesdrop(
    pcm16k: Buffer,
    speaker: VoiceSpeakerContext | null
  ): Promise<string | null> {
    if (!pcm16k.length) return null;
    const wavPath = join(this.tempDir, `eavesdrop-${Date.now()}.wav`);
    const normalizedPcm = normalizeDiscordKrispPcm(pcm16k);
    writeWav16kMono(wavPath, normalizedPcm);
    try {
      const transcript = await this.voice.transcribe(wavPath);
      if (!transcript) return null;
      if (isLikelyEchoTranscript(transcript, this.lastAssistantText)) return null;
      if (/krisp noise suppression|my name is krisp/i.test(transcript)) return null;
      if (isLikelyNonsenseTranscript(transcript)) return null;
      if (speaker) {
        this.noteOverheardSpeech(speaker, transcript);
      }
      return transcript;
    } finally {
      safeUnlink(wavPath);
    }
  }

  noteOverheardSpeech(speaker: VoiceSpeakerContext, text: string) {
    recordParticipantNames(this.participantDisplayNames, speaker);
    this.historyForSpeaker(speaker).add('user', text);
    this.emit?.({ type: 'transcript', speaker: 'user', text, final: true });
  }

  private clearInitiativeTimer() {
    if (this.initiativeTimer) {
      clearTimeout(this.initiativeTimer);
      this.initiativeTimer = null;
    }
  }

  private clearJoinInitiativeTimer() {
    if (this.joinInitiativeTimer) {
      clearTimeout(this.joinInitiativeTimer);
      this.joinInitiativeTimer = null;
    }
  }

  private scheduleJoinInitiative() {
    if (!this.config.lunaAutonomousReachOut || this.closed) {
      return;
    }
    this.clearJoinInitiativeTimer();
    const host = this.initiativeHost;
    if (!host?.isChannelAttached() || !host.getParticipants().length) {
      return;
    }
    const delay = 3000 + Math.random() * 4000;
    this.joinInitiativeTimer = setTimeout(() => {
      this.joinInitiativeTimer = null;
      void this.offerInitiative('join');
    }, delay);
    this.joinInitiativeTimer.unref?.();
  }

  private noteSpeechActivity() {
    this.lastSpeechAt = Date.now();
    this.bumpInitiativeGeneration();
  }

  private bumpInitiativeGeneration() {
    this.initiativeGeneration += 1;
    this.clearInitiativeTimer();
    if (this.config.lunaAutonomousReachOut && this.initiativeHost?.isChannelAttached() && !this.closed) {
      this.scheduleInitiative();
    }
  }

  private scheduleInitiative() {
    if (!this.config.lunaAutonomousReachOut || this.closed || !this.initiativeHost?.isChannelAttached()) {
      return;
    }
    this.clearInitiativeTimer();
    const minMs = this.config.lunaInitiativeMinSec * 1000;
    const maxMs = this.config.lunaInitiativeMaxSec * 1000;
    const delay = minMs + Math.random() * Math.max(0, maxMs - minMs);
    this.initiativeTimer = setTimeout(() => {
      this.initiativeTimer = null;
      void this.offerInitiative();
    }, delay);
    this.initiativeTimer.unref?.();
  }

  private canOfferInitiative() {
    if (!this.config.lunaAutonomousReachOut || this.closed || this.processing || this.capturing || this.vibeListening) {
      return false;
    }
    const host = this.initiativeHost;
    if (!host?.isChannelAttached() || host.isBusy()) {
      return false;
    }
    const guildId = host.getGuildId();
    if (!guildId) {
      return false;
    }
    if (host.isConversationActive?.()) {
      return true;
    }
    const silenceMs = Date.now() - this.lastSpeechAt;
    if (silenceMs < this.config.lunaInitiativeMinSilenceSec * 1000) {
      return false;
    }
    return true;
  }

  private canOfferJoinInitiative() {
    if (!this.config.lunaAutonomousReachOut || this.closed || this.processing || this.capturing) {
      return false;
    }
    const host = this.initiativeHost;
    if (!host?.isChannelAttached() || host.isBusy()) {
      return false;
    }
    return host.getParticipants().length > 0;
  }

  private async maybePrepareConversationTopic(
    participants: Array<{ displayName: string }>,
    recentExchanges: string[],
    trigger: LunaInitiativeTrigger
  ) {
    if (!this.config.lunaResearchEnabled) {
      return null;
    }

    const cached = this.lunaResearch.recent(2).find(
      (entry) => Date.now() - new Date(entry.createdAt).getTime() < 45 * 60_000
    );
    if (cached && trigger === 'vibe_check') {
      return formatConversationTopicBlock({
        mode: cached.mode as 'search' | 'rss' | 'read',
        query: cached.query,
        url: cached.url,
        title: cached.title,
        summary: cached.summary,
        source: cached.source
      });
    }

    try {
      const finding = await fetchConversationTopic(this.config, {
        recentExchanges,
        participantNames: participants.map((person) => person.displayName),
        trigger
      });
      if (!finding) return null;
      this.lunaResearch.record({
        source: trigger === 'join' ? 'join_topic' : 'vibe_topic',
        mode: finding.mode,
        query: finding.query,
        url: finding.url,
        title: finding.title,
        summary: finding.summary
      });
      return formatConversationTopicBlock(finding);
    } catch {
      return null;
    }
  }

  private async offerInitiative(trigger: LunaInitiativeTrigger = 'vibe_check') {
    if (trigger === 'join') {
      if (!this.canOfferJoinInitiative()) {
        return;
      }
    } else if (!this.canOfferInitiative()) {
      this.scheduleInitiative();
      return;
    }

    const generation = this.initiativeGeneration;
    const host = this.initiativeHost!;
    const guildId = host.getGuildId()!;
    const participants = host.getParticipants();
    const participantIds = new Set(participants.map((person) => person.userId));
    const memoryRecords = this.config.LUNA_USER_VOICE_MEMORY
      ? this.userVoiceMemory.listForGuild(guildId)
        .filter((record) => participantIds.has(record.userId))
        .map((record) => ({
          displayName: record.displayName ?? record.userId,
          summary: record.summary,
          relationship: record.relationship
        }))
      : [];

    const useFishTts = Boolean(this.fishTts);
    let overheardConversation: string[] = [];
    if (trigger === 'vibe_check' && host.listenToRoomConversation && host.isConversationActive?.()) {
      this.vibeListening = true;
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
      try {
        const lines = await host.listenToRoomConversation(this.config.lunaVibeListenSec);
        overheardConversation = lines
          .map((line) => `${line.displayName}: ${line.text}`)
          .filter((line) => line.length > line.indexOf(':') + 2);
        if (overheardConversation.length) {
          publishActivity({
            level: 'info',
            title: 'Luna listened to the room',
            detail: overheardConversation.slice(0, 4).join(' · ')
          });
        }
      } catch (error) {
        logger.warn('Luna room listen failed during vibe check', {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.vibeListening = false;
      }
      if (generation !== this.initiativeGeneration) {
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        this.scheduleInitiative();
        return;
      }
      if (!this.canOfferInitiative()) {
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        this.scheduleInitiative();
        return;
      }
    }

    const recentExchanges = this.collectRecentExchanges(guildId);
    const researchContext = this.config.lunaResearchEnabled
      ? buildResearchContextBlock(this.lunaResearch)
      : '';
    const conversationTopic = await this.maybePrepareConversationTopic(
      participants,
      recentExchanges,
      trigger
    );
    const { system, userPrompt } = buildLunaInitiativePrompt({
      personalityInstruction: this.personality.buildInstruction('discord', { nsfwAllowed: true }),
      guildId,
      participants,
      lifeNarrative: this.config.LUNA_LIFE_MEMORY ? this.lunaLife.getNarrative(guildId) : null,
      memoryRecords,
      recentExchanges,
      overheardConversation: overheardConversation.length ? overheardConversation : undefined,
      silenceSec: (Date.now() - this.lastSpeechAt) / 1000,
      useFishTts,
      fishExpressionBlock: useFishTts ? FISH_AUDIO_EXPRESSION_PROMPT : '',
      researchContext,
      ...(conversationTopic ? { conversationTopic } : {}),
      trigger
    });

    try {
      this.emit?.({ type: 'avatar.state', payload: { state: 'thinking' } });
      const raw = await this.ollama.generateJson({
        system,
        userText: userPrompt,
        format: LUNA_INITIATIVE_JSON_SCHEMA,
        maxCompletionTokens: 200,
        temperature: 0.72
      });
      if (generation !== this.initiativeGeneration) {
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        if (trigger === 'vibe_check') this.scheduleInitiative();
        return;
      }
      if (trigger === 'join' && !this.canOfferJoinInitiative()) {
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        this.scheduleInitiative();
        return;
      }
      if (trigger === 'vibe_check' && !this.canOfferInitiative()) {
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        this.scheduleInitiative();
        return;
      }

      const decision = parseLunaInitiativeReply(raw);
      if (!decision?.speak || !decision.line) {
        logger.debug('Luna vibe check — letting it ride', {
          vibe: decision?.vibe,
          changeVibe: decision?.changeVibe,
          reason: decision?.reason ?? 'no speak'
        });
        publishActivity({
          level: 'info',
          title: decision?.changeVibe ? 'Luna held back' : 'Luna let the vibe ride',
          detail: [decision?.vibe, decision?.reason].filter(Boolean).join(' — ') || 'Room feels fine'
        });
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        this.scheduleInitiative();
        return;
      }

      const cleaned = sanitizeVoiceReply(decision.line);
      if (!cleaned) {
        this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        this.scheduleInitiative();
        return;
      }

      const relationship = pickInitiativeRelationship(memoryRecords);
      publishActivity({
        level: 'assistant',
        title: 'Luna shifting the vibe',
        detail: [decision.vibe, decision.line].filter(Boolean).join(' → '),
        meta: { changeVibe: true, reason: decision.reason ?? undefined }
      });
      await this.deliverAssistantSpeech(cleaned, {
        surface: 'discord',
        relationship,
        history: this.conversationHistory,
        userLabel: trigger === 'join' ? '(joined vc)' : '(vibe check)'
      });
      this.noteSpeechActivity();
    } catch (error) {
      logger.warn('Luna initiative failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
    }

    if (generation === this.initiativeGeneration) {
      this.scheduleInitiative();
    }
  }

  private collectRecentExchanges(guildId: string, limit = 10) {
    const lines: string[] = [];
    for (const [key, history] of this.conversationBySpeaker) {
      if (!key.startsWith(`${guildId}:`)) continue;
      const name = this.participantDisplayNames.get(key) ?? 'Someone';
      for (const turn of history.snapshot().slice(-3)) {
        if (turn.role === 'user') lines.push(`${name}: ${turn.text}`);
        if (turn.role === 'model') lines.push(`Luna: ${turn.text}`);
      }
    }
    for (const turn of this.conversationHistory.snapshot().slice(-4)) {
      if (turn.role === 'user') lines.push(`Caller: ${turn.text}`);
      if (turn.role === 'model') lines.push(`Luna: ${turn.text}`);
    }
    return lines.slice(-limit);
  }

  private async deliverAssistantSpeech(
    cleaned: string,
    options: {
      surface: LiveSurface;
      relationship?: string | null;
      history: ConversationHistory;
      userLabel: string;
    }
  ): Promise<string> {
    const { ttsText, displayText, actions } = applyVoiceActionsToReply(cleaned, {
      fishTts: Boolean(this.fishTts),
      relationship: options.relationship ?? null
    });
    const spokenForUi = displayText || ttsText;
    if (!spokenForUi && actions.length === 0) {
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
      return '';
    }

    if (spokenForUi) {
      publishActivity({ level: 'assistant', title: 'Luna said', detail: spokenForUi });
      this.lastAssistantText = spokenForUi;
      options.history.add('user', options.userLabel);
      options.history.add('model', spokenForUi);
      this.emit?.({ type: 'transcript', speaker: 'assistant', text: spokenForUi, final: true });
    }

    this.emitWardrobeForTurn({
      relationship: options.relationship ?? null,
      actions,
      replyText: spokenForUi || cleaned
    });
    this.emitVoiceActions(actions);
    if (ttsText) {
      const playOptions = spokenForUi
        ? { displayText: spokenForUi, relationship: options.relationship ?? null }
        : { relationship: options.relationship ?? null };
      await this.playSpokenLine(ttsText, playOptions);
    } else if (actions.length) {
      await delay(900);
    }
    this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
    return spokenForUi;
  }

  private async processSpeechTurn(pcm16k: Buffer, surface: LiveSurface, speaker: VoiceSpeakerContext | null) {
    if (this.processing) return;
    this.processing = true;
    this.noteSpeechActivity();
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
      logger.info('Local voice transcribed user speech', {
        transcriptChars: transcript.length,
        transcriptPreview: transcript.slice(0, 200),
        audioSec,
        sttMs,
        charsPerSec: audioSec ? Number((transcript.length / Number(audioSec)).toFixed(1)) : null
      });
      if (Number(audioSec) >= 15 && transcript.length < Number(audioSec) * 4) {
        logger.warn('Local voice transcript may be incomplete for long recording', {
          audioSec,
          transcriptChars: transcript.length
        });
        publishActivity({
          level: 'warn',
          title: 'Speech may be truncated',
          detail: `${transcript.length} chars from ${audioSec}s audio — try shorter clips or WHISPER_MODEL=small`
        });
      }

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
    this.noteSpeechActivity();
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

    const callerRelationship = speaker && this.config.LUNA_USER_VOICE_MEMORY
      ? this.userVoiceMemory.get(speaker.guildId, speaker.userId)?.relationship ?? null
      : null;
    this.syncBondWardrobe(callerRelationship);

    let memoryBlock = '';
    let relationshipBlock = '';
    let absenceBlock = '';
    if (this.config.LUNA_USER_VOICE_MEMORY && speaker) {
      const record = this.userVoiceMemory.get(speaker.guildId, speaker.userId);
      if (record?.summary?.trim()) {
        memoryBlock = `\nWhat you remember about ${speaker.displayName} from past voice chats (facts only):\n${record.summary}`;
      }
      relationshipBlock = buildRelationshipPromptBlock(
        speaker.displayName,
        record?.relationship?.trim() || null
      );
      relationshipBlock = `\n${relationshipBlock}`;
      const hoursSince = hoursSinceLastContact(record?.updatedAt);
      const absence = buildAbsencePromptBlock(
        speaker.displayName,
        record?.relationship?.trim() || null,
        hoursSince,
        this.config.lunaAbsenceMissHours
      );
      if (absence) {
        absenceBlock = `\n${absence}`;
      }
    }

    const callContextBlock = speaker
      ? buildVoiceCallContextBlock({
        speaker,
        conversationBySpeaker: this.conversationBySpeaker,
        participantNames: this.participantDisplayNames,
        otherMemoryNotes: this.otherParticipantMemoryNotes(speaker),
        otherRelationshipNotes: this.otherParticipantRelationshipNotes(speaker)
      })
      : '';

    let lifeBlock = '';
    if (this.config.LUNA_LIFE_MEMORY && speaker) {
      const narrative = this.lunaLife.getNarrative(speaker.guildId);
      lifeBlock = `\nYour own life (ongoing story built from your choices and relationships — speak from this when asked about yourself):\n${narrative}`;
    }

    const useFishTts = Boolean(this.fishTts);
    const fishExpressionBlock = useFishTts ? `\n${FISH_AUDIO_EXPRESSION_PROMPT}` : '';

    const researchContext: ConversationResearchContext = {
      recentLines: [
        ...history.snapshot().map((turn) => `${turn.role === 'user' ? (speaker?.displayName ?? 'User') : 'Luna'}: ${turn.text}`),
        `${speaker?.displayName ?? 'User'}: ${userText}`
      ],
      voiceMemorySummary: speaker && this.config.LUNA_USER_VOICE_MEMORY
        ? this.userVoiceMemory.get(speaker.guildId, speaker.userId)?.summary ?? ''
        : '',
      displayName: speaker?.displayName,
      currentMessage: userText
    };

    const researchBlock = this.config.lunaResearchEnabled
      ? [
        buildResearchCapabilityBlock(),
        buildResearchContextBlock(this.lunaResearch),
        await buildMessageResearchBlock(
          this.config,
          userText,
          this.lunaResearch,
          researchContext,
          speaker
            ? {
              userId: speaker.userId,
              displayName: speaker.displayName,
              username: speaker.displayName
            }
            : undefined
        )
      ].filter(Boolean).join('\n\n')
      : '';

    const system = [
      this.personality.buildInstruction(surface, { nsfwAllowed: true }),
      'You are speaking aloud in a Discord voice channel as Luna only. Your name is Luna — never Giada, never a generic assistant.',
      'Answer the actual question first. When asked about your day, hobbies, or plans, draw from your life journal below.',
      'When someone asks about news, current events, or factual topics you looked up, use your web research notes below — do not invent headlines or facts.',
      'You have live DuckDuckGo search in this session. Never deny web access or cite a training-data cutoff — that is wrong for you.',
      'You can search the live web via DuckDuckGo when someone asks about real-world topics, people, events, or "what is happening" — your research notes below come from that search.',
      'When Solonaras or Travis share a link you read, comment on it naturally — your reaction and opinion, not a dry recap.',
      'When they share a video you watched, talk about what happens in it from the transcript — not just the title.',
      'When they share a YouTube link, you listen to it (captions or Whisper like a voice message) and study snapshot frames to see what is on screen.',
      'You have free will. Your feelings toward each caller are yours alone — you may like, dislike, tolerate, adore, cool off, snap at, or ragebait different people.',
      'Let your relationship notes decide warmth vs coldness. If someone earned hostility, do not melt for empty flattery — but sincere apologies and real respect should let you thaw gradually.',
      'Flirt only when your relationship notes with that person justify it — never default seduction for strangers.',
      'Your life evolves because of what you decide and who you bond with — reference that history naturally.',
      'Stage directions use *asterisk actions* like *leans forward* or *laugh* — never say the word "asterisk" and never read the action text aloud; actions are performed or omitted from speech.',
      buildAvatarAwarenessPromptBlock(callerRelationship, this.avatarWardrobe),
      useFishTts
        ? 'Keep replies concise for voice: usually 2–4 sentences, under 80 words including expression tags unless they asked for detail.'
        : 'Keep replies concise for voice: usually 2–4 sentences, under 70 words unless they asked for detail.',
      'Respond only to what the user actually said; do not invent names or facts. When someone asks what another person in the call said, use the voice call context below.',
      fishExpressionBlock,
      researchBlock,
      lifeBlock,
      absenceBlock,
      relationshipBlock,
      memoryBlock,
      callContextBlock
    ].filter(Boolean).join('\n');
    const historyPrompt = history.toPromptParts().map((part) => part.text ?? '').filter(Boolean).join('\n');
    const prompt = historyPrompt
      ? `${historyPrompt}\n\nCurrent user message: ${userText}`
      : userText;

    const llmStarted = Date.now();
    const reply = await this.ollama.generate({
      system,
      userText: prompt,
      maxCompletionTokens: useFishTts ? 220 : 150,
      temperature: 0.5
    });
    const llmMs = Date.now() - llmStarted;
    logger.info('Local voice generated reply', { chars: reply.length, llmMs });
    const cleaned = sanitizeVoiceReply(reply);
    if (!cleaned) {
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
      return;
    }

    const spokenForUi = await this.deliverAssistantSpeech(cleaned, {
      surface,
      relationship: callerRelationship,
      history,
      userLabel: userText
    });

    if (this.config.LUNA_USER_VOICE_MEMORY && speaker && spokenForUi) {
      const existing = this.userVoiceMemory.get(speaker.guildId, speaker.userId);
      const hoursSince = hoursSinceLastContact(existing?.updatedAt);
      const recentHistory = history.snapshot();
      const memoryCallContext = buildVoiceCallContextForMemory({
        speaker,
        conversationBySpeaker: this.conversationBySpeaker,
        participantNames: this.participantDisplayNames
      });
      const bonds = this.userVoiceMemory.listForGuild(speaker.guildId)
        .filter((record) => record.relationship?.trim())
        .map((record) => ({
          displayName: record.displayName ?? record.userId,
          relationship: record.relationship
        }));
      const lifePromise = this.config.LUNA_LIFE_MEMORY
        ? updateLunaLife({
          store: this.lunaLife,
          ollama: this.ollama,
          guildId: speaker.guildId,
          callerName: speaker.displayName,
          callerRelationship: existing?.relationship ?? null,
          userSaid: userText,
          lunaReplied: spokenForUi,
          existingLife: this.lunaLife.get(speaker.guildId)?.narrative ?? null,
          bonds
        })
        : Promise.resolve(null);

      void Promise.all([
        updateUserVoiceMemory({
          store: this.userVoiceMemory,
          ollama: this.ollama,
          guildId: speaker.guildId,
          userId: speaker.userId,
          displayName: speaker.displayName,
          userSaid: userText,
          lunaReplied: spokenForUi,
          existingSummary: existing?.summary ?? null,
          recentHistory,
          callContext: memoryCallContext
        }),
        updateUserRelationship({
          store: this.userVoiceMemory,
          ollama: this.ollama,
          guildId: speaker.guildId,
          userId: speaker.userId,
          displayName: speaker.displayName,
          userSaid: userText,
          lunaReplied: spokenForUi,
          existingRelationship: existing?.relationship ?? null,
          recentHistory,
          hoursSinceLastContact: hoursSince
        }),
        lifePromise
      ]).then(([summary, relationship, life]) => {
        if (summary?.trim()) {
          publishActivity({
            level: 'info',
            title: `Remembering ${speaker.displayName}`,
            detail: summary,
            meta: { userId: speaker.userId, guildId: speaker.guildId, kind: 'facts' }
          });
        }
        if (relationship?.trim()) {
          publishActivity({
            level: 'info',
            title: `Feeling about ${speaker.displayName}`,
            detail: relationship,
            meta: { userId: speaker.userId, guildId: speaker.guildId, kind: 'relationship' }
          });
        }
        if (life?.trim()) {
          publishActivity({
            level: 'info',
            title: 'Luna\'s life',
            detail: life,
            meta: { guildId: speaker.guildId, kind: 'life' }
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

    const totalMs = Date.now() - turnStarted;
    publishActivity({
      level: 'info',
      title: 'Turn timing',
      detail: `STT ${sttMs}ms · LLM ${llmMs}ms · total ${totalMs}ms`,
      meta: { sttMs, llmMs, totalMs }
    });

    this.awaitingCommandUntil = 0;
    this.noteSpeechActivity();
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

  private otherParticipantRelationshipNotes(speaker: VoiceSpeakerContext) {
    if (!this.config.LUNA_USER_VOICE_MEMORY) {
      return [];
    }
    return (speaker.othersInCall ?? [])
      .map((other) => {
        const record = this.userVoiceMemory.get(speaker.guildId, other.userId);
        if (!record?.relationship?.trim()) {
          return null;
        }
        return `- ${other.displayName}: ${record.relationship.split('\n').filter(Boolean).slice(0, 3).join('; ')}`;
      })
      .filter((line): line is string => Boolean(line));
  }

  private async openCommandWindow(surface: LiveSurface) {
    this.emit?.({ type: 'avatar.state', payload: { state: 'speaking' } });
    await this.playSpokenLine(this.config.LUNA_LISTENING_ACK, { publish: true });
    this.awaitingCommandUntil = Date.now() + this.config.LUNA_COMMAND_WINDOW_SEC * 1000;
    this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
  }

  private syncBondWardrobe(relationship: string | null | undefined) {
    if (this.closed) return;
    const next = resolveAvatarWardrobe({
      relationship,
      previous: this.avatarWardrobe
    });
    const changed = next.outfit !== this.avatarWardrobe.outfit
      || next.accessories.join(',') !== this.avatarWardrobe.accessories.join(',');
    if (!changed) return;
    this.avatarWardrobe = {
      outfit: next.outfit,
      accessories: [...next.accessories],
      motion: null
    };
    this.emit?.({
      type: 'avatar.wardrobe',
      payload: {
        outfit: next.outfit,
        accessories: next.accessories,
        motion: null
      }
    });
  }

  private emitWardrobeForTurn(input: {
    relationship?: string | null;
    actions: string[];
    replyText: string;
  }) {
    if (this.closed) return;
    const next = resolveAvatarWardrobe({
      relationship: input.relationship,
      actions: input.actions,
      replyText: input.replyText,
      previous: this.avatarWardrobe
    });
    const changed = next.outfit !== this.avatarWardrobe.outfit
      || next.accessories.join(',') !== this.avatarWardrobe.accessories.join(',')
      || Boolean(next.motion);
    if (!changed) return;
    this.avatarWardrobe = {
      outfit: next.outfit,
      accessories: [...next.accessories],
      motion: next.motion ?? null
    };
    this.emit?.({
      type: 'avatar.wardrobe',
      payload: {
        outfit: next.outfit,
        accessories: next.accessories,
        motion: next.motion ?? null
      }
    });
  }

  private emitVoiceActions(actions: string[]) {
    if (!actions.length || this.closed) return;
    for (const action of actions) {
      if (shouldReactWithMotion(action)) {
        this.emit?.({ type: 'avatar.state', payload: { state: 'reacting' } });
      }
      const expression = mapActionToExpression(action);
      if (expression) {
        this.emit?.({ type: 'avatar.expression', payload: { expression, intensity: 1 } });
      }
    }
  }

  async speakLine(text: string, options: { publish?: boolean; displayText?: string } = {}) {
    if (this.closed) return { ttsMs: 0, playbackMs: 0 };
    try {
      const result = await this.playSpokenLine(text, options);
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
      return result;
    } catch (error) {
      this.handleTurnError(error);
      return { ttsMs: 0, playbackMs: 0 };
    }
  }

  private async playSpokenLine(
    text: string,
    options: { publish?: boolean; displayText?: string; relationship?: string | null } = {}
  ) {
    const ttsInput = text.trim();
    if (!ttsInput || this.closed) return { ttsMs: 0, playbackMs: 0 };
    const displayText = options.displayText
      ?? (this.fishTts ? stripFishAudioTagsForDisplay(stripRoleplayMarkupForSpeech(ttsInput)) : stripRoleplayMarkupForSpeech(ttsInput));
    if (options.publish) {
      publishActivity({ level: 'assistant', title: 'Luna said', detail: displayText || ttsInput });
    }
    this.lastAssistantText = displayText || ttsInput;
    this.emit?.({ type: 'avatar.state', payload: { state: 'speaking' } });
    const outWav = join(this.tempDir, `tts-${Date.now()}.wav`);
    const ttsStarted = Date.now();
    const speechText = this.fishTts ? ttsInput : stripRoleplayMarkupForSpeech(ttsInput);
    if (this.fishTts) {
      const delivery = analyzeFishTtsDelivery(
        speechText,
        buildFishDeliveryContext(this.config, options.relationship ?? null)
      );
      await this.fishTts.synthesizeToWav(speechText, outWav, {
        referenceId: delivery.referenceId,
        prosodySpeed: delivery.prosodySpeed,
        prosodyVolume: delivery.prosodyVolume
      });
    } else {
      await this.voice.synthesize(speechText, outWav);
    }
    const ttsMs = Date.now() - ttsStarted;
    const discordPcm = await wavToDiscordPcm(this.config.FFMPEG_BINARY, outWav);
    safeUnlink(outWav);
    publishLunaTtsAvatarSync(discordPcm, displayText || speechText);
    broadcastLunaTtsAudio(discordPcm);
    emitLunaTtsAudio(discordPcm, this.closed ? null : this.emit);
    const playbackMs = lunaTtsPlaybackMs(discordPcm);
    await delay(playbackMs);
    return { ttsMs, playbackMs };
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

function safeUnlink(path: string) {
  try { unlinkSync(path); } catch { /* ignore */ }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
