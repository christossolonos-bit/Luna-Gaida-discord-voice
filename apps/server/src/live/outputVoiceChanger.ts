import { spawn } from 'node:child_process';
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { logger } from '../logging/logger.js';

export interface VoiceChangerConfig {
  enabled: boolean;
  name: string;
  ffmpegFilter: string;
}

export class OutputVoiceChanger {
  private profile: VoiceChangerConfig;
  private processor: ReturnType<typeof spawn> | null = null;
  private available = true;
  private destroyed = false;
  private stderr = '';
  private readonly configChangeHandler = () => this.reloadProfile();
  private readonly watchesConfig: boolean;

  constructor(
    private readonly ffmpegBinary: string,
    private readonly configPath: string,
    private readonly sampleRate: number,
    private readonly onAudio: (pcm: Buffer) => void,
    profileOverride?: VoiceChangerConfig
  ) {
    this.profile = profileOverride ?? loadVoiceChangerConfig(configPath);
    this.watchesConfig = !profileOverride;
    if (this.watchesConfig) watchFile(this.configPath, { interval: 1_000 }, this.configChangeHandler);
  }

  process(pcm: Buffer) {
    if (!pcm.length || this.destroyed) return;
    if (!this.profile.enabled || !this.available) {
      this.onAudio(pcm);
      return;
    }
    this.ensureProcessor();
    const stdin = this.processor?.stdin;
    if (!stdin?.writable) {
      this.onAudio(pcm);
      return;
    }
    stdin.write(pcm);
  }

  reset() {
    this.stopProcessor();
  }

  destroy() {
    this.destroyed = true;
    if (this.watchesConfig) unwatchFile(this.configPath, this.configChangeHandler);
    this.stopProcessor();
  }

  private ensureProcessor() {
    if (this.processor || this.destroyed) return;
    this.stderr = '';
    const processor = spawn(this.ffmpegBinary, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 's16le',
      '-ar', String(this.sampleRate),
      '-ac', '1',
      '-i', 'pipe:0',
      '-af', this.profile.ffmpegFilter,
      '-f', 's16le',
      '-ar', String(this.sampleRate),
      '-ac', '1',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.processor = processor;
    processor.stdout.on('data', (chunk: Buffer) => this.onAudio(chunk));
    processor.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2_000);
    });
    processor.once('error', (error) => this.disableAfterFailure(processor, error.message));
    processor.once('close', (code) => {
      if (this.processor !== processor) return;
      this.disableAfterFailure(processor, this.stderr.trim() || `ffmpeg exited with code ${code}`);
    });
  }

  private reloadProfile() {
    if (this.destroyed) return;
    const next = loadVoiceChangerConfig(this.configPath);
    if (
      next.enabled === this.profile.enabled
      && next.name === this.profile.name
      && next.ffmpegFilter === this.profile.ffmpegFilter
    ) return;
    this.stopProcessor();
    this.profile = next;
    this.available = true;
  }

  private disableAfterFailure(processor: ReturnType<typeof spawn>, error: string) {
    if (this.processor !== processor) return;
    this.processor = null;
    this.available = false;
    logger.warn('Web/app voice changer failed; bypassing effect', {
      name: this.profile.name,
      error
    });
  }

  private stopProcessor() {
    const processor = this.processor;
    this.processor = null;
    if (!processor) return;
    processor.stdin?.end();
    processor.kill('SIGKILL');
  }
}

function loadVoiceChangerConfig(configPath: string): VoiceChangerConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<VoiceChangerConfig>;
    if (typeof parsed.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error('name must be a non-empty string');
    if (typeof parsed.ffmpegFilter !== 'string' || !parsed.ffmpegFilter.trim() || parsed.ffmpegFilter.length > 2_000) {
      throw new Error('ffmpegFilter must be a non-empty string of at most 2000 characters');
    }
    return {
      enabled: parsed.enabled,
      name: parsed.name.trim(),
      ffmpegFilter: parsed.ffmpegFilter.trim()
    };
  } catch (error) {
    logger.warn('Could not load web/app voice changer configuration; using bypass mode', {
      configPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return { enabled: false, name: 'bypass', ffmpegFilter: 'anull' };
  }
}
