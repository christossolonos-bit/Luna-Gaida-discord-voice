import type { AppConfig } from '../config/env.js';
import type { LiveClientEvent, LiveInputEvent, LiveSurface } from '../live/liveSession.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import type { PlatformStore, UsageReservation } from '../platform/store.js';
import { GroqTextClient } from '../providers/groq.js';
import { routeText } from '../providers/routing.js';
import { generateDiscordTextWithNvidia } from '../plugins/discord/nvidiaVision.js';
import { createToolRegistry } from '../tools/registry.js';
import type { RealtimeSession } from './realtimeServer.js';

export class BrowserRealtimeSession implements RealtimeSession {
  private emit: ((event: LiveClientEvent) => void) | null = null;
  private readonly groq: GroqTextClient;

  constructor(
    private readonly config: AppConfig,
    private readonly store: PlatformStore,
    private readonly guildId: string,
    private readonly personality: PersonalityInstructionProvider,
    private readonly gemini: RealtimeSession | null
  ) {
    this.groq = new GroqTextClient(config, store);
  }

  setEmitter(emit: (event: LiveClientEvent) => void) {
    this.emit = emit;
    this.gemini?.setEmitter((event) => {
      if (event.type !== 'status') emit(event);
    });
  }

  emitCurrentStatus() {
    this.emit?.({ type: 'status', status: 'connected' });
  }

  async connect(surface: LiveSurface = 'browser') {
    this.emit?.({ type: 'status', status: 'connected' });
    if (this.gemini) await this.gemini.connect(surface);
  }

  async handleInput(input: LiveInputEvent, surface: LiveSurface = 'browser') {
    if (input.type === 'text' || input.type === 'activityStart') await this.refreshVoiceChanger();
    if (input.type !== 'text' || !input.text?.trim()) {
      if (!this.gemini) throw new Error('browser_voice_not_available');
      return this.gemini.handleInput(input, surface);
    }
    const runtime = await this.store.getGuildRuntime(this.guildId);
    if (input.text.length > runtime.features.maxMessageLength) throw new Error('message_too_long_for_plan');
    const credentials = await this.store.listCredentials(this.guildId);
    const usage = await this.store.getUsage(this.guildId);
    const route = routeText({
      runtime,
      hasGroqByok: credentials.some((item) => item.provider === 'groq'),
      hasGeminiByok: credentials.some((item) => item.provider === 'gemini'),
      sharedQuotaAvailable: usage.unlimited || usage.messagesUsed < usage.messageLimit,
      paidCreditsAvailable: usage.unlimited || usage.creditsUsed < usage.creditLimit
    });
    if (route.provider === 'gemini') {
      if (this.gemini) return this.gemini.handleInput(input, surface);
    }
    if (route.provider === 'blocked') throw new Error('monthly_allowance_exhausted');
    let reservation: UsageReservation | null = null;
    if (route.charge === 'message') {
      reservation = await this.store.reserveUsage(this.guildId, `browser:groq:${crypto.randomUUID()}`, 'message', 1);
      if (!reservation) throw new Error('monthly_allowance_exhausted');
    }
    try {
      const apiKey = route.credential === 'byok' ? await this.store.getCredential(this.guildId, 'groq') ?? undefined : undefined;
      const tools = createToolRegistry({ searxngUrl: this.config.SEARXNG_URL, memoryToolsEnabled: this.config.GIADA_MEMORY_TOOLS_ENABLED })
        .filter((tool) => tool.declaration.name !== 'searchWeb' || runtime.features.webSearch);
      const text = await this.groq.generate({
        ...(apiKey ? { apiKey } : {}),
        system: this.personality.buildInstruction('browser'),
        userText: input.text.trim(),
        tools: tools.map((tool) => tool.declaration),
        executeTools: async (calls) => Promise.all(calls.map(async (call) => {
          const tool = tools.find((candidate) => candidate.declaration.name === call.function.name);
          if (!tool) return { id: call.id, name: call.function.name, response: { ok: false, error: 'unknown_tool' } };
          return {
            id: call.id,
            name: call.function.name,
            response: await tool.run(parseArguments(call.function.arguments), { surface: 'browser', memory: this.store.guildMemory(this.guildId) })
          };
        }))
      });
      if (reservation) await this.store.reconcileUsage(reservation, 1, true);
      this.emit?.({ type: 'transcript', speaker: 'assistant', text, final: true });
      this.emit?.({ type: 'avatar.state', payload: { state: 'idle' } });
    } catch (error) {
      try {
        if (!runtime.features.kimiFallback) throw error;
        const byokNvidia = runtime.features.byokNvidia ? await this.store.getCredential(this.guildId, 'nvidia') : null;
        const sharedNvidia = !byokNvidia ? await this.store.pickProviderKey('nvidia') : null;
        const nvidiaKey = byokNvidia ?? sharedNvidia?.value;
        if (!nvidiaKey) throw error;
        const text = await generateDiscordTextWithNvidia(
          { ...this.config, nvidiaApiKey: nvidiaKey },
          this.personality.buildInstruction('browser'),
          [{ text: input.text.trim() }],
          runtime.features.nsfw && runtime.settings.nsfwEnabled
        );
        if (reservation) await this.store.reconcileUsage(reservation, 1, true);
        this.emit?.({ type: 'transcript', speaker: 'assistant', text, final: true });
        this.emit?.({ type: 'avatar.state', payload: { state: 'idle' } });
      } catch {
        if (reservation) await this.store.reconcileUsage(reservation, 0, false);
        throw error;
      }
    }
  }

  close() { this.gemini?.close(); }
  dispose() { this.gemini?.dispose(); }

  private async refreshVoiceChanger() {
    if (!this.gemini?.setVoiceChangerProfile) return;
    const runtime = await this.store.getGuildRuntime(this.guildId);
    this.gemini.setVoiceChangerProfile({
      ...runtime.settings.voiceChanger,
      enabled: runtime.features.voiceChanger && runtime.settings.voiceChanger.enabled
    });
  }
}

function parseArguments(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
