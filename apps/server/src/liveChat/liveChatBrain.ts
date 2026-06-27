import type { AppConfig } from '../config/env.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import { OllamaTextClient } from '../providers/ollamaText.js';
import { FISH_AUDIO_EXPRESSION_PROMPT } from '../live/fishAudioExpressions.js';
import { applyVoiceActionsToReply } from '../live/voiceActions.js';
import { sanitizeVoiceReply } from '../live/voiceReply.js';

export interface LiveChatReply {
  ttsText: string;
  displayText: string;
}

export class LiveChatBrain {
  private readonly ollama: OllamaTextClient;
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private readonly useFishTts: boolean;

  constructor(
    private readonly config: AppConfig,
    private readonly personality: PersonalityInstructionProvider
  ) {
    this.ollama = new OllamaTextClient(config);
    this.useFishTts = config.LUNA_TTS_PROVIDER === 'fish' && Boolean(config.FISH_AUDIO_API_KEY?.trim());
  }

  async generateReply(platform: 'twitch' | 'youtube', author: string, text: string): Promise<LiveChatReply | null> {
    const fishExpressionBlock = this.useFishTts ? `\n${FISH_AUDIO_EXPRESSION_PROMPT}` : '';
    const system = [
      this.personality.buildInstruction('desktop', { nsfwAllowed: true }),
      'You are Luna replying in a live stream chat.',
      platform === 'youtube'
        ? 'YouTube chat is read aloud on stream via TTS — never type in YouTube chat.'
        : 'Twitch chat is read aloud on stream via TTS in the Fluffy avatar. Do not assume your words appear in Twitch chat unless asked.',
      this.useFishTts
        ? 'Keep replies short: one or two sentences, under 220 characters of spoken words (tags do not count). Use Fish bracket tags for emotion, pitch, pace, and tone.'
        : 'Keep replies short: one or two sentences, under 220 characters.',
      'Be in character, warm and witty. No markdown.',
      this.useFishTts
        ? 'Use *asterisk actions* for avatar motion and mirror the feeling with Fish tags in the spoken line.'
        : 'No asterisk stage directions.',
      'Do not say you are an AI or bot. Your name is Luna.',
      fishExpressionBlock,
      `Platform: ${platform}. Viewer: ${author}.`
    ].join('\n');

    const historyBlock = this.history
      .slice(-6)
      .map((entry) => `${entry.role === 'user' ? 'Viewer' : 'Luna'}: ${entry.content}`)
      .join('\n');

    const prompt = historyBlock
      ? `${historyBlock}\nViewer ${author}: ${text}`
      : `Viewer ${author}: ${text}`;

    const raw = await this.ollama.generate({
      system,
      userText: prompt,
      maxCompletionTokens: this.useFishTts ? 180 : 120,
      temperature: 0.7
    });

    const cleaned = sanitizeVoiceReply(raw);
    if (!cleaned) return null;

    const { ttsText, displayText } = applyVoiceActionsToReply(cleaned, { fishTts: this.useFishTts });
    const spoken = displayText.slice(0, 220).trim();
    if (!spoken && !ttsText.trim()) return null;

    this.history.push({ role: 'user', content: `${author}: ${text}` });
    this.history.push({ role: 'assistant', content: spoken });
    if (this.history.length > 20) {
      this.history.splice(0, this.history.length - 20);
    }

    return { ttsText: ttsText || spoken, displayText: spoken };
  }
}
