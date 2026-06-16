import {
  Behavior,
  DynamicRetrievalConfigMode,
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
import { createToolRegistry, type RegisteredTool } from '../tools/registry.js';
import { logger } from '../logging/logger.js';

export type LiveClientEvent =
  | { type: 'status'; status: 'offline' | 'connecting' | 'connected' | 'error'; reason?: string }
  | { type: 'audio'; data: string; mimeType: 'audio/pcm;rate=24000' }
  | { type: 'transcript'; speaker: 'user' | 'assistant'; text: string; final?: boolean }
  | { type: 'avatar.expression'; payload: { expression: string; intensity: number } }
  | { type: 'avatar.state'; payload: { state: string } }
  | { type: 'avatar.model.change'; payload: { modelName: string } };

export interface LiveInputEvent {
  type: 'text' | 'audio' | 'video' | 'mode' | 'interrupt';
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

  constructor(
    private readonly config: AppConfig,
    private readonly memory: MemoryRepository,
    private readonly personality: PersonalityService
  ) {
    this.ai = config.GEMINI_API_KEY
      ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY, httpOptions: { apiVersion: config.GEMINI_API_VERSION } })
      : null;
    this.tools = createToolRegistry();
  }

  setEmitter(emit: (event: LiveClientEvent) => void) {
    this.emit = emit;
  }

  async connect(surface: 'desktop' | 'discord' = 'desktop') {
    if (!this.ai) {
      this.emit?.({ type: 'status', status: 'error', reason: 'GEMINI_API_KEY is not configured' });
      return;
    }
    if (this.session) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.emit?.({ type: 'status', status: 'connecting' });
    this.connecting = this.open(surface).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async handleInput(input: LiveInputEvent, surface: 'desktop' | 'discord' = 'desktop') {
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

    if (input.type === 'text' && input.text?.trim()) {
      this.session.sendRealtimeInput({ text: this.decorateUserText(input.text.trim()) });
    } else if (input.type === 'audio' && input.data) {
      this.session.sendRealtimeInput({ audio: { data: input.data, mimeType: input.mimeType ?? 'audio/pcm;rate=16000' } });
    } else if (input.type === 'video' && input.data) {
      this.session.sendRealtimeInput({ video: { data: input.data, mimeType: input.mimeType ?? 'image/jpeg' } });
    }
  }

  close() {
    this.session?.close();
    this.session = null;
    this.emit?.({ type: 'status', status: 'offline' });
  }

  private async open(surface: 'desktop' | 'discord') {
    const memoryContext = this.memory
      .listForContext(surface)
      .map((record) => `- [${record.privacy}/${record.source}] ${record.summary ?? record.content}`)
      .join('\n');
    const systemInstruction = [
      this.personality.buildInstruction(memoryContext, surface),
      surface === 'discord'
        ? 'Discord voice input may include speaker metadata immediately before audio. Use it only to know who is speaking; do not answer the metadata itself.'
        : null
    ].filter(Boolean).join('\n');
    const config = this.buildConfig(systemInstruction);
    this.session = await this.ai!.live.connect({
      model: this.config.GEMINI_MODEL,
      config,
      callbacks: {
        onopen: () => {
          this.emit?.({ type: 'status', status: 'connected' });
          this.emit?.({ type: 'avatar.state', payload: { state: 'listening' } });
        },
        onmessage: (message: LiveServerMessage) => {
          void this.handleMessage(message, surface);
        },
        onerror: (error) => {
          logger.error('Gemini Live session error', error);
          this.emit?.({ type: 'status', status: 'error', reason: error.message });
        },
        onclose: (event) => {
          logger.warn('Gemini Live session closed', event.reason);
          this.session = null;
          this.emit?.({ type: 'status', status: 'offline', reason: event.reason });
        }
      }
    });
  }

  private decorateUserText(text: string) {
    if (!this.passive) {
      return text;
    }
    return `Passive listening mode is enabled. Decide whether this merits a spoken response. If it does not, stay silent.\n\nUser/input: ${text}`;
  }

  private buildConfig(systemInstruction: string): LiveConnectConfig {
    return {
      responseModalities: [Modality.AUDIO],
      systemInstruction,
      enableAffectiveDialog: true,
      proactivity: { proactiveAudio: true },
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
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.OFF }
      ],
      tools: [
        {
          googleSearch: {},
          googleSearchRetrieval: {
            dynamicRetrievalConfig: { mode: DynamicRetrievalConfigMode.MODE_DYNAMIC }
          }
        },
        {
          functionDeclarations: this.tools.map((tool) => normalizeDeclaration(tool.declaration))
        }
      ]
    } as LiveConnectConfig;
  }

  private async handleMessage(message: LiveServerMessage, surface: 'desktop' | 'discord') {
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
        const tool = this.tools.find((candidate) => candidate.declaration.name === call.name);
        const id = call.id ?? `${call.name ?? 'tool'}-${functionResponses.length}`;
        const name = call.name ?? 'unknown';
        if (!tool) {
          functionResponses.push({ id, name, response: { error: 'unknown_tool' } });
          continue;
        }
        try {
          const response = await tool.run(call.args, {
            surface,
            memory: this.memory,
            emitClientEvent: (event) => this.emit?.(event as LiveClientEvent)
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
