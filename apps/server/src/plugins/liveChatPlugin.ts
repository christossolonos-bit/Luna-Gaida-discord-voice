import type { GiadaPlugin } from './plugin.js';
import type { AppConfig } from '../config/env.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import { logger } from '../logging/logger.js';
import { LiveChatCoordinator } from '../liveChat/liveChatCoordinator.js';
import type { DiscordPlugin } from './discord/discordPlugin.js';

export class LiveChatPlugin implements GiadaPlugin {
  name = 'live-chat';
  private coordinator: LiveChatCoordinator | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly personality: PersonalityInstructionProvider,
    private readonly discord?: DiscordPlugin
  ) {}

  async start() {
    const enabled = this.config.twitchLiveChat
      || (this.config.youtubeLiveChat && Boolean(this.config.youtubeCheckUrl));
    if (!enabled) {
      logger.info('Live chat plugin disabled (no Twitch/YouTube config)');
      return;
    }

    this.coordinator = new LiveChatCoordinator(this.config, this.personality, {
      speakTts: async (text) => this.discord?.speakLiveChatTts(text) ?? false
    });
    await this.coordinator.start();
    logger.info('Live chat plugin started', {
      twitch: this.config.twitchLiveChat,
      youtube: this.config.youtubeLiveChat,
      youtubeMode: 'read-tts'
    });
  }

  async stop() {
    await this.coordinator?.stop();
    this.coordinator = null;
  }
}
