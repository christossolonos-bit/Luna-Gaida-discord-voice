import tmi from 'tmi.js';
import type { AppConfig } from '../config/env.js';
import { logger } from '../logging/logger.js';

export interface TwitchChatMessage {
  platform: 'twitch';
  id: string;
  author: string;
  text: string;
  timestamp: number;
}

type MessageListener = (message: TwitchChatMessage) => void;

export class TwitchChatClient {
  private client: tmi.Client | null = null;
  private listener: MessageListener | null = null;

  constructor(private readonly config: AppConfig) {}

  onMessage(listener: MessageListener) {
    this.listener = listener;
  }

  async start() {
    if (this.client) return;
    const username = this.config.twitchUsername;
    const token = this.config.twitchOAuthToken;
    const channel = this.config.twitchChannel;
    if (!username || !token || !channel) {
      throw new Error('Twitch chat requires twitch_username, TWITCH_OAUTH_TOKEN, and twitch_channel');
    }

    this.client = new tmi.Client({
      options: { debug: false },
      connection: { reconnect: true, secure: true },
      identity: {
        username,
        password: token
      },
      channels: [channel.replace(/^#/, '')]
    });

    this.client.on('message', (_channelName, tags, message, self) => {
      if (self) return;
      const text = message.trim();
      if (!text) return;
      this.listener?.({
        platform: 'twitch',
        id: tags.id ?? `${tags['user-id'] ?? 'unknown'}:${Date.now()}`,
        author: tags['display-name'] ?? tags.username ?? 'viewer',
        text,
        timestamp: tags.tmiSentTs ? Number(tags.tmiSentTs) : Date.now()
      });
    });

    this.client.on('connected', (_addr, port) => {
      logger.info('Twitch live chat connected', { channel, port });
    });

    await this.client.connect();
  }

  async reply(text: string) {
    if (!this.client) {
      throw new Error('Twitch chat is not connected');
    }
    const channel = this.config.twitchChannel?.replace(/^#/, '') ?? '';
    await this.client.say(channel, text.slice(0, 500));
  }

  async close() {
    if (!this.client) return;
    await this.client.disconnect();
    this.client = null;
  }
}
