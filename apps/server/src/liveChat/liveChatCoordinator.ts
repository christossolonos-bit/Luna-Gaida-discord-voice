import type { AppConfig } from '../config/env.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import { publishActivity } from '../monitor/activityFeed.js';
import { logger } from '../logging/logger.js';
import { LiveChatBrain } from './liveChatBrain.js';
import { TwitchChatClient } from './twitchChatClient.js';
import { YoutubeChatWorker } from './youtubeChatWorker.js';

type Platform = 'twitch' | 'youtube';

interface IncomingChatMessage {
  platform: Platform;
  id: string;
  author: string;
  text: string;
}

export interface LiveChatCoordinatorOptions {
  speakTts?: (text: string) => Promise<boolean>;
}

export class LiveChatCoordinator {
  private readonly brain: LiveChatBrain;
  private readonly twitch: TwitchChatClient;
  private readonly youtube: YoutubeChatWorker;
  private readonly seenIds = new Set<string>();
  private readonly inFlight = new Set<string>();
  private lastReplyAt = 0;
  private started = false;
  private youtubeRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private warnedYoutubeTts = false;

  constructor(
    private readonly config: AppConfig,
    personality: PersonalityInstructionProvider,
    private readonly options: LiveChatCoordinatorOptions = {}
  ) {
    this.twitch = new TwitchChatClient(config);
    this.youtube = new YoutubeChatWorker(config);
    this.brain = new LiveChatBrain(config, personality);
    this.twitch.onMessage((message) => {
      void this.handleMessage(message);
    });
    this.youtube.onMessage((message) => {
      void this.handleMessage(message);
    });
  }

  async start() {
    if (this.started) return;
    this.started = true;

    if (this.config.twitchLiveChat) {
      await this.twitch.start();
      publishActivity({
        level: 'success',
        title: 'Twitch chat',
        detail: `Listening in #${this.config.twitchChannel}`
      });
    }

    if (this.config.youtubeLiveChat && this.config.youtubeCheckUrl) {
      await this.startYoutubeWithRetry();
    }
  }

  async stop() {
    this.started = false;
    if (this.youtubeRestartTimer) {
      clearTimeout(this.youtubeRestartTimer);
      this.youtubeRestartTimer = null;
    }
    await Promise.allSettled([this.twitch.close(), this.youtube.close()]);
  }

  private async startYoutubeWithRetry() {
    try {
      await this.youtube.start();
      publishActivity({
        level: 'success',
        title: 'YouTube live chat (read → TTS)',
        detail: this.config.youtubeCheckUrl ?? ''
      });
    } catch (error) {
      logger.error('Failed to start YouTube live chat', {
        error: error instanceof Error ? error.message : String(error)
      });
      publishActivity({
        level: 'error',
        title: 'YouTube live chat failed',
        detail: error instanceof Error ? error.message : String(error)
      });
      if (this.started) {
        this.youtubeRestartTimer = setTimeout(() => {
          this.youtubeRestartTimer = null;
          void this.startYoutubeWithRetry();
        }, 30_000);
      }
    }
  }

  private async handleMessage(message: IncomingChatMessage) {
    if (!message.id || this.seenIds.has(message.id)) return;
    this.seenIds.add(message.id);
    if (this.seenIds.size > 5000) {
      this.seenIds.clear();
    }

    publishActivity({
      level: 'user',
      title: `${message.platform} · ${message.author}`,
      detail: message.text,
      meta: { platform: message.platform }
    });

    const autoReply = message.platform === 'twitch'
      ? this.config.twitchAutoReply
      : this.config.youtubeAutoReply;
    if (!autoReply) return;

    const trigger = message.platform === 'twitch'
      ? this.config.twitchAutoTrigger
      : this.config.youtubeAutoTrigger;
    if (!this.shouldReply(trigger, message.text, message.author)) return;

    const key = `${message.platform}:${message.id}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);

    try {
      const now = Date.now();
      const cooldownMs = 1500;
      if (now - this.lastReplyAt < cooldownMs) {
        await delay(cooldownMs - (now - this.lastReplyAt));
      }

      const reply = await this.brain.generateReply(message.platform, message.author, message.text);
      if (!reply) return;

      if (message.platform === 'twitch') {
        await this.twitch.reply(reply);
      } else {
        const spoke = await this.options.speakTts?.(reply) ?? false;
        if (!spoke) {
          if (!this.warnedYoutubeTts) {
            this.warnedYoutubeTts = true;
            logger.warn('YouTube chat TTS skipped — join Luna to a Discord voice channel first');
            publishActivity({
              level: 'warn',
              title: 'YouTube TTS needs Discord voice',
              detail: 'Join Luna to a voice channel so she can speak YouTube chat replies on stream. The reply text is still shown here.'
            });
          }
        }
      }

      this.lastReplyAt = Date.now();
      publishActivity({
        level: 'assistant',
        title: message.platform === 'youtube' ? 'Luna spoke (YouTube TTS)' : `Luna → ${message.platform}`,
        detail: reply,
        meta: { platform: message.platform, to: message.author, mode: message.platform === 'youtube' ? 'tts' : 'chat' }
      });
    } catch (error) {
      logger.warn('Live chat reply failed', {
        platform: message.platform,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.inFlight.delete(key);
    }
  }

  private shouldReply(trigger: string, text: string, author: string) {
    const botNames = [
      this.config.twitchUsername,
      this.config.lunaCreatorName,
      'luna',
      'solosluna'
    ].filter(Boolean) as string[];

    const authorKey = author.toLowerCase().replace(/^@/, '');
    if (botNames.some((name) => authorKey === name.toLowerCase().replace(/^@/, ''))) {
      return false;
    }

    const normalized = text.trim();
    if (!normalized) return false;

    if (trigger === 'all') return true;
    if (trigger === 'mention') {
      return /\bluna\b/i.test(normalized) || /@luna\b/i.test(normalized);
    }
    if (trigger === 'question') {
      return normalized.includes('?');
    }
    return /\bluna\b/i.test(normalized);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
