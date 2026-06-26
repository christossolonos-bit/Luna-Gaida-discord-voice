import type { AppConfig } from '../config/env.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import { OllamaTextClient } from '../providers/ollamaText.js';
import { stripRoleplayMarkupForSpeech } from '../live/voiceActions.js';
import { sanitizeVoiceReply } from '../live/voiceReply.js';

export class LiveChatBrain {
  private readonly ollama: OllamaTextClient;
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly personality: PersonalityInstructionProvider
  ) {
    this.ollama = new OllamaTextClient(config);
  }

  async generateReply(platform: 'twitch' | 'youtube', author: string, text: string) {
    const system = [
      this.personality.buildInstruction('desktop', { nsfwAllowed: true }),
      'You are Luna replying in a live stream chat.',
      platform === 'youtube'
        ? 'YouTube chat is read aloud on stream via TTS — never type in YouTube chat.'
        : 'Twitch chat replies are posted as text in the channel.',
      'Keep replies short: one or two sentences, under 220 characters.',
      'Be in character, warm and witty. No markdown, no asterisk stage directions.',
      'Do not say you are an AI or bot. Your name is Luna.',
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
      maxCompletionTokens: 120,
      temperature: 0.7
    });

    const cleaned = stripRoleplayMarkupForSpeech(sanitizeVoiceReply(raw));
    const reply = cleaned.slice(0, 220).trim();
    if (!reply) return null;

    this.history.push({ role: 'user', content: `${author}: ${text}` });
    this.history.push({ role: 'assistant', content: reply });
    if (this.history.length > 20) {
      this.history.splice(0, this.history.length - 20);
    }

    return reply;
  }
}
