import { mkdirSync, writeFileSync } from 'node:fs';
import { logger } from '../logging/logger.js';

export interface FishAudioTtsConfig {
  apiKey: string;
  referenceId?: string | undefined;
  model: string;
  tempDir: string;
  prosodySpeed?: number;
}

export interface FishTtsSynthesisOptions {
  referenceId?: string | undefined;
  prosodySpeed?: number | undefined;
  prosodyVolume?: number | undefined;
}

export class FishAudioTts {
  constructor(private readonly config: FishAudioTtsConfig) {
    mkdirSync(config.tempDir, { recursive: true });
  }

  async synthesizeToWav(text: string, outWav: string, options: FishTtsSynthesisOptions = {}) {
    await this.synthesizeToFile(text, outWav, 'wav', options);
  }

  async synthesizeToFile(
    text: string,
    outPath: string,
    format: 'wav' | 'mp3' = 'wav',
    options: FishTtsSynthesisOptions = {}
  ) {
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

    await this.request(cleaned, outPath, format, options);
  }

  private async request(
    text: string,
    outPath: string,
    format: 'wav' | 'mp3' = 'wav',
    options: FishTtsSynthesisOptions = {}
  ) {
    const speed = options.prosodySpeed ?? this.config.prosodySpeed ?? 1;
    const volume = options.prosodyVolume ?? 0;
    const body: Record<string, unknown> = {
      text,
      format,
      normalize: true,
      prosody: {
        speed,
        volume,
        normalize_loudness: true
      }
    };
    if (format === 'wav') {
      body.sample_rate = 44100;
    }
    const referenceId = options.referenceId?.trim() || this.config.referenceId?.trim();
    if (referenceId) {
      body.reference_id = referenceId;
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
