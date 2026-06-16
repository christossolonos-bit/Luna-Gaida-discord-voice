import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  type AudioPlayer,
  type VoiceConnection
} from '@discordjs/voice';
import { PassThrough } from 'node:stream';
import prism from 'prism-media';
import type { AppConfig } from '../../config/env.js';
import { LiveSessionManager, type LiveClientEvent } from '../../live/liveSession.js';
import type { MemoryRepository } from '../../memory/repository.js';
import type { PersonalityService } from '../../personality/service.js';
import { logger } from '../../logging/logger.js';

const DISCORD_RATE = 48000;
const DISCORD_CHANNELS = 2;
const GEMINI_INPUT_RATE = 16000;
const GEMINI_OUTPUT_RATE = 24000;
const SPEECH_END_SILENCE_MS = 900;

export class DiscordVoiceBridge {
  private readonly live: LiveSessionManager;
  private readonly player: AudioPlayer;
  private readonly output = new PassThrough({ highWaterMark: 1024 * 1024 });
  private connection: VoiceConnection | null = null;
  private channelId: string | null = null;
  private speakingHandler: ((userId: string) => void) | null = null;
  private readonly activeInputUsers = new Set<string>();
  private inputQueue: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(
    private readonly guildId: string,
    private readonly botUserId: string,
    private readonly resolveSpeakerName: (userId: string) => string,
    config: AppConfig,
    memory: MemoryRepository,
    personality: PersonalityService
  ) {
    this.live = new LiveSessionManager(config, memory, personality);
    this.live.setEmitter((event) => this.handleLiveEvent(event));

    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });
    this.player.on('error', (error) => {
      logger.error('Discord voice audio player failed', {
        guildId: this.guildId,
        error: error.message
      });
    });
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (!this.destroyed && !this.output.destroyed) {
        this.player.play(createAudioResource(this.output, { inputType: StreamType.Raw }));
      }
    });
    this.player.play(createAudioResource(this.output, { inputType: StreamType.Raw }));
  }

  attach(connection: VoiceConnection, channelId: string) {
    if (this.connection !== connection) {
      this.detachReceiver();
      this.connection = connection;
    }
    this.channelId = channelId;
    connection.subscribe(this.player);
    void entersState(connection, VoiceConnectionStatus.Ready, 15_000)
      .then((readyConnection) => {
        if (this.connection !== readyConnection) {
          return;
        }
        this.attachReceiver(readyConnection);
      })
      .catch((error) => {
        logger.warn('Discord voice connection did not become ready for audio bridge', {
          guildId: this.guildId,
          channelId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  destroy() {
    this.destroyed = true;
    this.detachReceiver();
    this.player.stop(true);
    this.output.destroy();
    this.live.close();
    this.connection = null;
    this.channelId = null;
  }

  private attachReceiver(connection: VoiceConnection) {
    if (this.speakingHandler) {
      return;
    }
    this.speakingHandler = (userId) => {
      if (userId === this.botUserId || this.activeInputUsers.has(userId)) {
        return;
      }
      this.receiveUserSpeech(connection, userId);
    };
    connection.receiver.speaking.on('start', this.speakingHandler);
  }

  private detachReceiver() {
    if (this.connection && this.speakingHandler) {
      this.connection.receiver.speaking.off('start', this.speakingHandler);
    }
    this.speakingHandler = null;
    this.activeInputUsers.clear();
  }

  private receiveUserSpeech(connection: VoiceConnection, userId: string) {
    this.activeInputUsers.add(userId);
    this.queueGeminiText([
      'Discord voice metadata:',
      `Speaker display name: ${this.resolveSpeakerName(userId)}`,
      `Speaker user ID: ${userId}`,
      'Treat the following audio as spoken by this speaker. Do not respond to this metadata by itself.'
    ].join('\n'));

    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: SPEECH_END_SILENCE_MS
      }
    });
    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: DISCORD_CHANNELS,
      rate: DISCORD_RATE
    });

    opusStream
      .pipe(decoder)
      .on('data', (chunk: Buffer) => {
        const pcm16k = downsampleDiscordPcmForGemini(chunk);
        if (pcm16k.length > 0) {
          this.queueGeminiInput(pcm16k);
        }
      })
      .once('end', () => {
        this.activeInputUsers.delete(userId);
      })
      .once('close', () => {
        this.activeInputUsers.delete(userId);
      })
      .once('error', (error) => {
        this.activeInputUsers.delete(userId);
        logger.warn('Discord voice receive stream failed', {
          guildId: this.guildId,
          channelId: this.channelId,
          userId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private queueGeminiText(text: string) {
    this.inputQueue = this.inputQueue
      .then(() => this.live.handleInput({
        type: 'text',
        text
      }, 'discord'))
      .catch((error) => {
        logger.warn('Failed to forward Discord voice speaker metadata to Gemini Live', {
          guildId: this.guildId,
          channelId: this.channelId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private queueGeminiInput(pcm: Buffer) {
    const data = pcm.toString('base64');
    this.inputQueue = this.inputQueue
      .then(() => this.live.handleInput({
        type: 'audio',
        data,
        mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}`
      }, 'discord'))
      .catch((error) => {
        logger.warn('Failed to forward Discord voice audio to Gemini Live', {
          guildId: this.guildId,
          channelId: this.channelId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private handleLiveEvent(event: LiveClientEvent) {
    if (event.type !== 'audio') {
      return;
    }
    const pcm24k = Buffer.from(event.data, 'base64');
    const discordPcm = upsampleGeminiPcmForDiscord(pcm24k);
    if (discordPcm.length > 0 && !this.output.destroyed) {
      this.output.write(discordPcm);
    }
  }
}

function downsampleDiscordPcmForGemini(input: Buffer) {
  const completeFrames = Math.floor(input.length / (DISCORD_CHANNELS * 2));
  const outputFrames = Math.floor(completeFrames * GEMINI_INPUT_RATE / DISCORD_RATE);
  const output = Buffer.allocUnsafe(outputFrames * 2);

  for (let frame = 0; frame < outputFrames; frame += 1) {
    const sourceFrame = frame * DISCORD_RATE / GEMINI_INPUT_RATE;
    const startFrame = Math.floor(sourceFrame);
    const endFrame = Math.min(completeFrames, Math.floor((frame + 1) * DISCORD_RATE / GEMINI_INPUT_RATE));
    let sum = 0;
    let count = 0;
    for (let index = startFrame; index < endFrame; index += 1) {
      const offset = index * DISCORD_CHANNELS * 2;
      sum += input.readInt16LE(offset);
      sum += input.readInt16LE(offset + 2);
      count += 2;
    }
    output.writeInt16LE(clampInt16(Math.round(sum / Math.max(count, 1))), frame * 2);
  }

  return output;
}

function upsampleGeminiPcmForDiscord(input: Buffer) {
  const inputFrames = Math.floor(input.length / 2);
  const outputFrames = Math.floor(inputFrames * DISCORD_RATE / GEMINI_OUTPUT_RATE);
  const output = Buffer.allocUnsafe(outputFrames * DISCORD_CHANNELS * 2);

  for (let frame = 0; frame < outputFrames; frame += 1) {
    const sourceFrame = Math.min(inputFrames - 1, Math.floor(frame * GEMINI_OUTPUT_RATE / DISCORD_RATE));
    const sample = input.readInt16LE(sourceFrame * 2);
    const offset = frame * DISCORD_CHANNELS * 2;
    output.writeInt16LE(sample, offset);
    output.writeInt16LE(sample, offset + 2);
  }

  return output;
}

function clampInt16(value: number) {
  return Math.max(-32768, Math.min(32767, value));
}
