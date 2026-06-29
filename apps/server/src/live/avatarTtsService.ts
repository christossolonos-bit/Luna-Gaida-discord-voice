import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../config/env.js';
import { publishActivity } from '../monitor/activityFeed.js';
import { logger } from '../logging/logger.js';
import { broadcastAvatarEvent } from '../ws/avatarBroadcast.js';
import { FishAudioTts } from './fishAudioTts.js';
import { applyVoiceActionsToReply, stripRoleplayMarkupForSpeech } from './voiceActions.js';
import { analyzeFishTtsDelivery, buildFishDeliveryContext } from './fishAudioDelivery.js';
import { LocalVoiceService, resolveLocalVoicePaths } from './localVoiceService.js';
import {
  broadcastLunaTtsAudio,
  lunaTtsPlaybackMs,
  publishLunaTtsAvatarSync,
  wavToDiscordPcm
} from './lunaTtsOutput.js';

/** Standalone Luna TTS for avatar/Electron when Discord voice is not connected. */
export class AvatarTtsService {
  private readonly fishTts: FishAudioTts | null;
  private readonly voice: LocalVoiceService | null;
  private readonly tempDir: string;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly config: AppConfig) {
    const paths = resolveLocalVoicePaths({
      pythonBinary: config.LOCAL_VOICE_PYTHON,
      voiceScriptPath: config.LOCAL_VOICE_SCRIPT,
      speakerWav: config.XTTS_SPEAKER_WAV
    });
    this.fishTts = config.LUNA_TTS_PROVIDER === 'fish' && config.FISH_AUDIO_API_KEY?.trim()
      ? new FishAudioTts({
        apiKey: config.FISH_AUDIO_API_KEY,
        referenceId: config.FISH_AUDIO_REFERENCE_ID,
        model: config.FISH_AUDIO_MODEL,
        prosodySpeed: config.FISH_AUDIO_PROSODY_SPEED,
        tempDir: join(tmpdir(), 'giada-fish-tts')
      })
      : null;
    this.voice = config.LUNA_TTS_PROVIDER !== 'fish'
      ? new LocalVoiceService({
        ...paths,
        whisperModel: config.WHISPER_MODEL,
        ttsLanguage: config.XTTS_LANGUAGE,
        whisperLanguage: config.WHISPER_LANGUAGE,
        whisperInitialPrompt: config.WHISPER_INITIAL_PROMPT,
        whisperNoSpeechThreshold: config.WHISPER_NO_SPEECH_THRESHOLD,
        device: config.LOCAL_VOICE_DEVICE,
        enableLocalTts: true,
        speakerWav: paths.speakerWav
      })
      : null;
    this.tempDir = join(tmpdir(), 'giada-avatar-tts');
    mkdirSync(this.tempDir, { recursive: true });
    if (this.voice) {
      void this.voice.start().catch((error) => {
        logger.error('Failed to start avatar TTS voice worker', {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  async speakLine(text: string, options: { publish?: boolean; displayText?: string } = {}) {
    let result = { ttsMs: 0, playbackMs: 0 };
    this.queue = this.queue.then(async () => {
      result = await this.playLine(text, options);
    });
    await this.queue;
    return result;
  }

  dispose() {
    this.closed = true;
    void this.voice?.close();
  }

  private async playLine(text: string, options: { publish?: boolean; displayText?: string }) {
    const trimmed = text.trim();
    if (!trimmed || this.closed) return { ttsMs: 0, playbackMs: 0 };

    let ttsText: string;
    let displayText: string;
    if (options.displayText) {
      ttsText = trimmed;
      displayText = options.displayText;
    } else if (this.fishTts) {
      const prepared = applyVoiceActionsToReply(trimmed, { fishTts: true });
      ttsText = prepared.ttsText;
      displayText = prepared.displayText;
    } else {
      ttsText = stripRoleplayMarkupForSpeech(trimmed);
      displayText = ttsText;
    }
    if (!ttsText) return { ttsMs: 0, playbackMs: 0 };
    if (options.publish) {
      publishActivity({ level: 'assistant', title: 'Luna said', detail: displayText || ttsText });
    }

    broadcastAvatarEvent({ type: 'avatar.state', payload: { state: 'speaking' } });
    const outWav = join(this.tempDir, `avatar-tts-${Date.now()}.wav`);
    const ttsStarted = Date.now();
    try {
      if (this.fishTts) {
        const delivery = analyzeFishTtsDelivery(ttsText, buildFishDeliveryContext(this.config));
        await this.fishTts.synthesizeToWav(ttsText, outWav, {
          referenceId: delivery.referenceId,
          prosodySpeed: delivery.prosodySpeed,
          prosodyVolume: delivery.prosodyVolume
        });
      } else if (this.voice) {
        await this.voice.synthesize(ttsText, outWav);
      } else {
        throw new Error('No TTS provider configured for avatar playback');
      }
      const ttsMs = Date.now() - ttsStarted;
      const discordPcm = await wavToDiscordPcm(this.config.FFMPEG_BINARY, outWav);
      publishLunaTtsAvatarSync(discordPcm, displayText || ttsText);
      broadcastLunaTtsAudio(discordPcm);
      const playbackMs = lunaTtsPlaybackMs(discordPcm);
      await delay(playbackMs);
      broadcastAvatarEvent({ type: 'avatar.state', payload: { state: 'idle' } });
      return { ttsMs, playbackMs };
    } finally {
      safeUnlink(outWav);
    }
  }
}

function safeUnlink(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
