import {
  ActivityHandling,
  Behavior,
  FunctionResponseScheduling,
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Modality,
  Type,
  type LiveConnectConfig,
  type LiveServerMessage,
  type Session
} from '@google/genai';
import type { AppConfig } from '../config/env.js';
import type { MemoryRepository } from '../memory/repository.js';
import type { PersonalityService } from '../personality/service.js';
import { createToolRegistry, isToolAvailableForSurface, type MusicController, type RegisteredTool, type ToolContext } from '../tools/registry.js';
import { logger } from '../logging/logger.js';

export type LiveSurface = 'desktop' | 'discord' | 'browser';

export type LiveClientEvent =
  | { type: 'status'; status: 'offline' | 'connecting' | 'connected' | 'error'; reason?: string }
  | { type: 'audio'; data: string; mimeType: 'audio/pcm;rate=24000' }
  | { type: 'transcript'; speaker: 'user' | 'assistant'; text: string; final?: boolean }
  | { type: 'avatar.expression'; payload: { expression: string; intensity: number } }
  | { type: 'avatar.state'; payload: { state: string } }
  | { type: 'avatar.model.change'; payload: { modelName: string } };

export interface LiveInputEvent {
  type: 'text' | 'audio' | 'audioStreamEnd' | 'activityStart' | 'activityEnd' | 'video' | 'mode' | 'interrupt' | 'turnComplete';
  data?: string | undefined;
  mimeType?: string | undefined;
  text?: string | undefined;
  passive?: boolean | undefined;
}

export class LiveSessionManager {
  private readonly ai: GoogleGenAI | null;
  private readonly tools: RegisteredTool[];
  private session: Session | null = null;
  private connecting: Promise<void> | null = null;
  private emit: ((event: LiveClientEvent) => void) | null = null;
  private passive = false;
  private desiredSurface: LiveSurface | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private sessionId = 0;
  private currentStatus: 'offline' | 'connecting' | 'connected' | 'error' = 'offline';
  private currentStatusReason: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly memory: MemoryRepository,
    private readonly personality: PersonalityService,
    private readonly toolContextProviders: { music?: MusicController; memoryTags?: string[] } = {}
  ) {
    this.ai = config.GEMINI_API_KEY
      ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY, httpOptions: { apiVersion: config.GEMINI_API_VERSION } })
      : null;
    this.tools = createToolRegistry({ searxngUrl: config.SEARXNG_URL });
  }

  setEmitter(emit: (event: LiveClientEvent) => void) {
    this.emit = emit;
  }

  emitCurrentStatus() {
    this.emitStatus(this.currentStatus, this.currentStatusReason);
  }

  async connect(surface: LiveSurface = 'desktop') {
    this.desiredSurface = surface;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.ai) {
      this.emitStatus('error', 'GEMINI_API_KEY is not configured');
      return;
    }
    if (this.session) {
      this.emitStatus('connected');
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
      return;
    }
    if (this.connecting) {
      this.emitStatus('connecting');
      return this.connecting;
    }

    this.emitStatus('connecting');
    this.connecting = this.open(surface)
      .catch((error) => {
        logger.warn('Gemini Live open failed', {
          surface,
          error: error instanceof Error ? error.message : String(error)
        });
        this.session = null;
        this.emitStatus('error', error instanceof Error ? error.message : String(error));
        this.scheduleReconnect(surface);
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  async handleInput(input: LiveInputEvent, surface: LiveSurface = 'desktop') {
    if (input.type === 'mode') {
      this.passive = Boolean(input.passive);
      return;
    }
    if (input.type === 'interrupt') {
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
      return;
    }
    await this.connect(surface);
    if (!this.session) {
      return;
    }

    if (input.type === 'turnComplete') {
      this.session.sendClientContent({ turnComplete: true });
    } else if (input.type === 'text' && input.text?.trim()) {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: this.decorateUserText(input.text.trim()) }] }],
        turnComplete: true
      });
    } else if (input.type === 'audio' && input.data) {
      this.session.sendRealtimeInput({ audio: { data: input.data, mimeType: input.mimeType ?? 'audio/pcm;rate=16000' } });
    } else if (input.type === 'audioStreamEnd') {
      this.session.sendRealtimeInput({ audioStreamEnd: true });
    } else if (input.type === 'activityStart') {
      this.session.sendRealtimeInput({ activityStart: {} });
    } else if (input.type === 'activityEnd') {
      this.session.sendRealtimeInput({ activityEnd: {} });
    } else if (input.type === 'video' && input.data) {
      this.session.sendRealtimeInput({ video: { data: input.data, mimeType: input.mimeType ?? 'image/jpeg' } });
    }
  }

  close() {
    this.desiredSurface = null;
    this.sessionId += 1;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.session?.close();
    this.session = null;
    this.emitStatus('offline');
  }

  private async open(surface: LiveSurface) {
    const openedSessionId = this.sessionId + 1;
    this.sessionId = openedSessionId;
    const memoryContext = this.memory
      .listForContext(surface, 20, this.toolContextProviders.memoryTags ?? [])
      .map((record) => `- [${record.privacy}/${record.source}] ${record.summary ?? record.content}`)
      .join('\n');
    const systemInstruction = [
      this.personality.buildInstruction(memoryContext, surface),
      'When you need current web information, links, documentation, or news, use the searchWeb tool. Do not rely on provider Google Search grounding.',
      surface === 'discord'
        ? [
          `You are speaking in a Discord voice channel. Always reply in ${this.config.GIADA_DEFAULT_LANGUAGE} unless the user explicitly asks for or speaks another language.`,
          `If the audio transcription looks like the wrong language, assume the user is still speaking ${this.config.GIADA_DEFAULT_LANGUAGE} and answer in ${this.config.GIADA_DEFAULT_LANGUAGE}.`,
          'When users ask you to play, search for, pause, resume, stop, seek, or change music volume in voice, use the Discord music tools instead of describing how to do it.',
          'Be concise and respond after each completed user voice turn.'
        ].join(' ')
        : null
    ].filter(Boolean).join('\n');
    const config = this.buildConfig(systemInstruction, surface);
    let openedSession: Session | null = null;
    let sessionEndedDuringOpen = false;
    const session = await this.ai!.live.connect({
      model: this.config.GEMINI_MODEL,
      config,
      callbacks: {
        onopen: () => {
          if (!this.isCurrentSession(openedSessionId, surface)) {
            return;
          }
          this.reconnectAttempts = 0;
          this.emitStatus('connected');
          this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        },
        onmessage: (message: LiveServerMessage) => {
          if (!this.isCurrentSession(openedSessionId, surface)) {
            return;
          }
          void this.handleMessage(message, surface);
        },
        onerror: (error) => {
          if (!this.isCurrentSession(openedSessionId, surface)) {
            return;
          }
          logger.error('Gemini Live session error', {
            surface,
            error: error.message
          });
          sessionEndedDuringOpen = true;
          if (!openedSession || this.session === openedSession) {
            this.session = null;
          }
          this.emitStatus('error', error.message);
          this.scheduleReconnect(surface);
        },
        onclose: (event) => {
          if (!this.isCurrentSession(openedSessionId, surface)) {
            return;
          }
          logger.warn('Gemini Live session closed', {
            surface,
            reason: event.reason || null
          });
          sessionEndedDuringOpen = true;
          if (!openedSession || this.session === openedSession) {
            this.session = null;
          }
          this.emitStatus('offline', event.reason);
          this.scheduleReconnect(surface);
        }
      }
    });
    openedSession = session;

    if (sessionEndedDuringOpen || this.desiredSurface !== surface || this.sessionId !== openedSessionId) {
      session.close();
      return;
    }
    this.session = session;
  }

  private scheduleReconnect(surface: LiveSurface) {
    if (this.desiredSurface !== surface || this.reconnectTimer || !this.ai) {
      return;
    }
    const delayMs = Math.min(1_500 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts += 1;
    logger.warn('Scheduling Gemini Live reconnect', {
      surface,
      delayMs,
      attempt: this.reconnectAttempts
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.desiredSurface === surface && !this.session) {
        void this.connect(surface);
      }
    }, delayMs);
  }

  private isCurrentSession(sessionId: number, surface: LiveSurface) {
    return this.sessionId === sessionId && this.desiredSurface === surface;
  }

  private emitStatus(status: 'offline' | 'connecting' | 'connected' | 'error', reason?: string) {
    this.currentStatus = status;
    this.currentStatusReason = reason;
    this.emit?.(reason
      ? { type: 'status', status, reason }
      : { type: 'status', status });
  }

  private decorateUserText(text: string) {
    if (!this.passive) {
      return text;
    }
    return `Passive listening mode is enabled. Decide whether this merits a spoken response. If it does not, stay silent.\n\nUser/input: ${text}`;
  }

  private buildConfig(systemInstruction: string, surface: LiveSurface): LiveConnectConfig {
    return {
      responseModalities: [Modality.AUDIO],
      systemInstruction,
      enableAffectiveDialog: true,
      proactivity: surface === 'discord' ? { proactiveAudio: false } : { proactiveAudio: true },
      realtimeInputConfig: surface === 'discord'
        ? {
          automaticActivityDetection: { disabled: true },
          activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS
        }
        : undefined,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      speechConfig: {
        languageCode: this.config.GIADA_DEFAULT_LANGUAGE
      },
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.OFF },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.OFF },
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.OFF },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.OFF },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.OFF },
        { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.OFF }
      ],
      tools: [
        {
              functionDeclarations: this.tools
                .filter((tool) => isToolAvailableForSurface(tool, surface))
                .map((tool) => normalizeDeclaration(tool.declaration))
        }
      ]
    } as LiveConnectConfig;
  }

  private async handleMessage(message: LiveServerMessage, surface: LiveSurface) {
    if (message.serverContent?.interrupted) {
      this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
      return;
    }

    const textParts = extractTextParts(message);
    const outputText = (message.serverContent?.outputTranscription?.text ?? textParts).trim();
    if (outputText) {
      this.emit?.({ type: 'transcript', speaker: 'assistant', text: outputText, final: Boolean(message.serverContent?.turnComplete) });
    }

    const inputText = message.serverContent?.inputTranscription?.text?.trim();
    if (inputText) {
      this.emit?.({ type: 'transcript', speaker: 'user', text: inputText, final: Boolean(message.serverContent?.turnComplete) });
    }

    const audioParts = extractAudioParts(message);
    for (const audio of audioParts) {
      this.emit?.({ type: 'avatar.state', payload: { state: 'speaking' } });
      this.emit?.({ type: 'audio', data: audio.data, mimeType: audio.mimeType });
    }

    if (message.toolCall?.functionCalls?.length) {
      const functionResponses: Record<string, unknown>[] = [];
      for (const call of message.toolCall.functionCalls) {
        const tool = this.tools.find((candidate) => candidate.declaration.name === call.name && isToolAvailableForSurface(candidate, surface));
        const id = call.id ?? `${call.name ?? 'tool'}-${functionResponses.length}`;
        const name = call.name ?? 'unknown';
        if (!tool) {
          logger.warn('Gemini Live requested unknown tool', {
            surface,
            name
          });
          functionResponses.push({ id, name, response: { error: 'unknown_tool' } });
          continue;
        }
        try {
          const toolContext: ToolContext = {
            surface,
            memory: this.memory,
            emitClientEvent: (event) => this.emit?.(event as LiveClientEvent)
          };
          if (this.toolContextProviders.music) {
            toolContext.music = this.toolContextProviders.music;
          }
          logger.info('Gemini Live requested tool', {
            surface,
            name,
            musicControllerAvailable: Boolean(toolContext.music)
          });
          const response = await tool.run(call.args, toolContext);
          logger.info('Gemini Live tool completed', {
            surface,
            name,
            response: summarizeToolResponse(response)
          });
          const functionResponse: Record<string, unknown> = {
            id,
            name,
            response,
          };
          if (call.name === 'changeExpression' || call.name === 'setAvatarState' || call.name === 'changeModel') {
            functionResponse.scheduling = FunctionResponseScheduling.SILENT;
          }
          functionResponses.push(functionResponse);
        } catch (error) {
          logger.warn('Gemini Live tool failed', {
            surface,
            name,
            error: error instanceof Error ? error.message : String(error)
          });
          functionResponses.push({
            id,
            name,
            response: { error: error instanceof Error ? error.message : String(error) }
          });
        }
      }
      this.session?.sendToolResponse({ functionResponses: functionResponses as never });
    }

    if (message.serverContent?.turnComplete) {
      this.emit?.({ type: 'avatar.state', payload: { state: 'idle' } });
    }
  }
}

function normalizeDeclaration(declaration: Record<string, unknown>) {
  void Type;
  return structuredClone(declaration) as Record<string, unknown>;
}

function summarizeToolResponse(response: Record<string, unknown>) {
  const summary: Record<string, unknown> = {};
  for (const key of ['ok', 'error', 'blocked', 'reason', 'title', 'url', 'durationSeconds', 'stopped']) {
    if (key in response) {
      summary[key] = response[key];
    }
  }
  return Object.keys(summary).length ? summary : { keys: Object.keys(response) };
}

function extractAudioParts(message: LiveServerMessage): Array<{ data: string; mimeType: 'audio/pcm;rate=24000' }> {
  const parts = message.serverContent?.modelTurn?.parts ?? [];
  return parts
    .map((part) => part.inlineData)
    .filter((inlineData): inlineData is { data: string; mimeType?: string } => typeof inlineData?.data === 'string' && inlineData.data.length > 0)
    .filter((inlineData) => !inlineData.mimeType || inlineData.mimeType.startsWith('audio/'))
    .map((inlineData) => ({
      data: inlineData.data,
      mimeType: normalizeAudioMimeType(inlineData.mimeType)
    }));
}

function normalizeAudioMimeType(mimeType: string | undefined): 'audio/pcm;rate=24000' {
  if (mimeType === 'audio/pcm;rate=24000') {
    return mimeType;
  }
  return 'audio/pcm;rate=24000';
}

function extractTextParts(message: LiveServerMessage) {
  return (message.serverContent?.modelTurn?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}
