import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import type { AppConfig } from '../config/env.js';
import { logger } from '../logging/logger.js';

export interface LiveChatMessage {
  platform: 'youtube';
  id: string;
  author: string;
  text: string;
  timestamp?: number | undefined;
}

type MessageListener = (message: LiveChatMessage) => void;

export class YoutubeChatWorker {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private closed = false;
  private listener: MessageListener | null = null;

  constructor(private readonly config: AppConfig) {}

  onMessage(listener: MessageListener) {
    this.listener = listener;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this.spawnWorker();
    return this.ready;
  }

  async close() {
    this.closed = true;
    if (this.process && !this.process.killed) {
      this.process.stdin.end();
      this.process.kill();
    }
    this.process = null;
    this.ready = null;
  }

  private async spawnWorker() {
    if (!this.config.youtubeCheckUrl) {
      throw new Error('LUNA_YOUTUBE_LIVE_CHECK_URL is not configured');
    }
    if (!existsSync(this.config.liveChatScriptPath)) {
      throw new Error(`Live chat script not found: ${this.config.liveChatScriptPath}`);
    }

    const workerConfig = {
      check_url: this.config.youtubeCheckUrl,
      poll_sec: this.config.youtubePollSec
    };

    this.process = spawn(
      this.config.LOCAL_VOICE_PYTHON,
      [this.config.liveChatScriptPath, JSON.stringify(workerConfig)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );

    this.process.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message) {
        logger.warn('YouTube chat worker stderr', { message: message.slice(0, 500) });
      }
    });

    this.process.on('exit', (code) => {
      if (!this.closed) {
        logger.warn('YouTube chat worker exited', { code });
        this.process = null;
        this.ready = null;
      }
    });

    const rl = createInterface({ input: this.process.stdout });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => settle(), 8_000);
      rl.on('line', (line) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(payload.type ?? '');
        if (type === 'starting' || type === 'waiting' || type === 'ready') {
          settle();
        }
        this.handleWorkerEvent(payload);
      });
      this.process?.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      this.process?.on('exit', (code) => {
        if (!settled && code !== 0 && !this.closed) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`YouTube chat worker exited before ready (${code ?? 'unknown'})`));
        }
      });
    });
  }

  private handleWorkerEvent(payload: Record<string, unknown>) {
    const type = String(payload.type ?? '');
    if (type === 'ready') {
      logger.info('YouTube live chat connected', { videoId: payload.video_id });
      return;
    }
    if (type === 'waiting' || type === 'starting') {
      logger.info('YouTube live chat worker', { status: type, message: payload.message });
      return;
    }
    if (type === 'offline') {
      logger.info('YouTube live stream ended or chat closed', { videoId: payload.video_id });
      return;
    }
    if (type === 'chat') {
      const message: LiveChatMessage = {
        platform: 'youtube',
        id: String(payload.id ?? ''),
        author: String(payload.author ?? 'viewer'),
        text: String(payload.text ?? ''),
        timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : undefined
      };
      if (message.id && message.text) {
        this.listener?.(message);
      }
      return;
    }
    if (type === 'error') {
      logger.error('YouTube chat worker error', { message: payload.message });
    }
  }
}
