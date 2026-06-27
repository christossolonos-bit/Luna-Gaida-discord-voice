import { mkdirSync, writeFileSync } from 'node:fs';
import { logger } from '../logging/logger.js';

export interface FishAudioTtsConfig {
  apiKey: string;
  referenceId?: string | undefined;
  model: string;
  tempDir: string;
  prosodySpeed?: number;
}

export class FishAudioTts {
  constructor(private readonly config: FishAudioTtsConfig) {
    mkdirSync(config.tempDir, { recursive: true });
  }

  async synthesizeToWav(text: string, outWav: string) {
    if (!this.config.apiKey.trim()) {
      throw new Error('FISH_AUDIO_API_KEY is not configured');
    }

    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      throw new Error('Fish Audio TTS received empty text');
    }

    logger.info('Fish Audio TTS request', {
      chars: cleaned.length,
      model: this.config.model,
      hasExpressionTags: /\[[^\]]+\]/.test(cleaned)
    });

    await this.request(cleaned, outWav);
  }

  private async request(text: string, outPath: string) {
    const body: Record<string, unknown> = {
      text,
      format: 'wav',
      sample_rate: 44100,
      normalize: true,
      prosody: {
        speed: this.config.prosodySpeed ?? 1,
        volume: 0,
        normalize_loudness: true
      }
    };
    if (this.config.referenceId?.trim()) {
      body.reference_id = this.config.referenceId.trim();
    }

    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey.trim()}`,
        'Content-Type': 'application/json',
        model: this.config.model
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Fish Audio TTS failed (${response.status}): ${detail.slice(0, 400)}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) {
      throw new Error('Fish Audio TTS returned empty audio');
    }
    writeFileSync(outPath, audio);
  }
}
