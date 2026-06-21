import type { LiveClientEvent, LiveInputEvent, LiveSurface } from '../live/liveSession.js';
import { textCredits, voiceCredits } from '../providers/routing.js';
import type { PlanFeatures } from './features.js';
import type { PlatformStore, UsageReservation } from './store.js';

export class LiveUsageMeter {
  private reservation: UsageReservation | null = null;
  private mode: 'text' | 'voice' | null = null;
  private inputCharacters = 0;
  private outputCharacters = 0;
  private inputAudioBytes = 0;
  private outputAudioBytes = 0;

  constructor(
    private readonly store: PlatformStore,
    private readonly guildId: string,
    private readonly features: PlanFeatures,
    private readonly settings: { browserTextEnabled: boolean; browserVoiceEnabled: boolean }
  ) {}

  beforeInput = async (input: LiveInputEvent, surface: LiveSurface) => {
    if (surface !== 'browser') return;
    if (input.type === 'text' && input.text?.trim()) {
      if (!this.settings.browserTextEnabled || !this.features.geminiText) throw new Error('browser_text_not_enabled');
      await this.finish(false);
      const usage = await this.store.getUsage(this.guildId);
      const remaining = usage.unlimited ? Number.MAX_SAFE_INTEGER : usage.creditLimit - usage.creditsUsed;
      const estimated = textCredits(input.text.length, this.features.maxMessageLength, this.features.textCharactersPerCredit);
      this.reservation = usage.unlimited ? null : await this.store.reserveUsage(this.guildId, `browser:text:${crypto.randomUUID()}`, 'text_credit', Math.min(remaining, estimated));
      if (!usage.unlimited && !this.reservation) throw new Error('credits_exhausted');
      this.mode = 'text';
      this.inputCharacters = input.text.length;
    }
    if (input.type === 'activityStart') {
      if (!this.settings.browserVoiceEnabled || !this.features.geminiVoice) throw new Error('browser_voice_not_enabled');
      await this.finish(false);
      const usage = await this.store.getUsage(this.guildId);
      const remaining = usage.unlimited ? Number.MAX_SAFE_INTEGER : usage.creditLimit - usage.creditsUsed;
      const estimate = Math.max(1, Math.ceil(240 / this.features.voiceSecondsPerCredit));
      this.reservation = usage.unlimited ? null : await this.store.reserveUsage(this.guildId, `browser:voice:${crypto.randomUUID()}`, 'voice_credit', Math.min(remaining, estimate));
      if (!usage.unlimited && !this.reservation) throw new Error('credits_exhausted');
      this.mode = 'voice';
    }
    if (input.type === 'audio' && input.data && this.mode === 'voice') this.inputAudioBytes += Buffer.from(input.data, 'base64').length;
  };

  onEvent = (event: LiveClientEvent) => {
    if (event.type === 'transcript' && event.speaker === 'assistant' && this.mode === 'text') this.outputCharacters += event.text.length;
    if (event.type === 'audio' && this.mode === 'voice') this.outputAudioBytes += Buffer.from(event.data, 'base64').length;
    if (event.type === 'avatar.state' && event.payload.state === 'idle') void this.finish(true);
  };

  async finish(commit: boolean) {
    const reservation = this.reservation;
    this.reservation = null;
    if (reservation) {
      const actual = this.mode === 'text'
        ? textCredits(this.inputCharacters, this.outputCharacters, this.features.textCharactersPerCredit)
        : voiceCredits(this.inputAudioBytes / 32000, this.outputAudioBytes / 48000, this.features.voiceSecondsPerCredit);
      await this.store.reconcileUsage(reservation, actual, commit);
    }
    this.mode = null;
    this.inputCharacters = 0;
    this.outputCharacters = 0;
    this.inputAudioBytes = 0;
    this.outputAudioBytes = 0;
  }
}
