import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { logger } from '../logging/logger.js';

export interface LocalVoiceServiceConfig {
  pythonBinary: string;
  scriptPath: string;
  whisperModel: string;
  speakerWav: string;
  ttsLanguage: string;
  whisperLanguage?: string | undefined;
  whisperInitialPrompt?: string | undefined;
  whisperNoSpeechThreshold?: number | undefined;
  device?: string | undefined;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LocalVoiceService {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(private readonly config: LocalVoiceServiceConfig) {}

  async start() {
    if (this.ready) return this.ready;
    this.ready = this.spawnWorker();
    return this.ready;
  }

  async transcribe(wavPath: string, timeoutMs = 120_000) {
    await this.start();
    const response = await this.request({ op: 'stt', wav: wavPath }, timeoutMs);
    return String(response.text ?? '').trim();
  }

  async synthesize(text: string, outWav: string, timeoutMs = 300_000) {
    await this.start();
    await this.request({ op: 'tts', text, out: outWav }, timeoutMs);
    return outWav;
  }

  async ping(timeoutMs = 10_000) {
    await this.start();
    await this.request({ op: 'ping' }, timeoutMs);
  }

  async close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Local voice service closed'));
    }
    this.pending.clear();
    if (this.process && !this.process.killed) {
      this.process.stdin.end();
      this.process.kill();
    }
    this.process = null;
    this.ready = null;
  }

  private async spawnWorker() {
    if (!existsSync(this.config.scriptPath)) {
      throw new Error(`Local voice script not found: ${this.config.scriptPath}`);
    }
    if (!existsSync(this.config.speakerWav)) {
      throw new Error(`XTTS speaker reference not found: ${this.config.speakerWav}`);
    }

    const payload = JSON.stringify({
      whisper_model: this.config.whisperModel,
      speaker_wav: this.config.speakerWav,
      tts_language: this.config.ttsLanguage,
      whisper_language: this.config.whisperLanguage ?? null,
      whisper_initial_prompt: this.config.whisperInitialPrompt ?? null,
      whisper_no_speech_threshold: this.config.whisperNoSpeechThreshold ?? 0.35,
      device: this.config.device ?? null
    });

    const child = spawn(this.config.pythonBinary, [this.config.scriptPath, payload], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.process = child;

    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) logger.debug('Local voice worker stderr', { message: message.slice(0, 500) });
    });

    child.on('exit', (code, signal) => {
      if (!this.closed) {
        logger.error('Local voice worker exited unexpectedly', { code, signal });
      }
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Local voice worker exited (${code ?? signal ?? 'unknown'})`));
      }
      this.pending.clear();
      this.process = null;
      this.ready = null;
    });

    await new Promise<void>((resolveReady, rejectReady) => {
      const rl = createInterface({ input: child.stdout });
      const startupTimer = setTimeout(() => {
        rl.close();
        rejectReady(new Error('Timed out waiting for local voice worker to become ready'));
      }, 300_000);

      rl.once('line', (line) => {
        clearTimeout(startupTimer);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.type === 'ready') {
            logger.info('Local voice worker ready', {
              device: message.device,
              whisperModel: message.whisper_model ?? this.config.whisperModel
            });
            rl.on('line', (payload) => this.handleLine(payload));
            resolveReady();
            return;
          }
          rejectReady(new Error(String(message.message ?? 'Local voice worker failed to start')));
        } catch (error) {
          rejectReady(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  private handleLine(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      logger.warn('Ignored malformed local voice worker message', { line: line.slice(0, 200) });
      return;
    }

    const id = typeof message.id === 'string' ? message.id : null;
    if (!id) {
      if (message.type === 'error') {
        logger.error('Local voice worker error', { message: message.message });
      }
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.type === 'error') {
      pending.reject(new Error(String(message.message ?? 'Local voice worker request failed')));
      return;
    }
    pending.resolve(message);
  }

  private request(body: Record<string, unknown>, timeoutMs: number) {
    if (!this.process || this.closed) {
      return Promise.reject(new Error('Local voice worker is not running'));
    }
    const id = randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Local voice worker timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
    });
  }
}

export function resolveLocalVoicePaths(config: {
  pythonBinary: string;
  voiceScriptPath: string;
  speakerWav: string;
}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoots = [
    resolve(process.cwd()),
    resolve(process.cwd(), '../..'),
    resolve(here, '../../../..'),
    resolve(here, '../../../../..')
  ];

  const resolveFile = (path: string) => {
    if (isAbsolute(path) && existsSync(path)) return path;
    for (const root of projectRoots) {
      const candidate = resolve(root, path);
      if (existsSync(candidate)) return candidate;
    }
    return isAbsolute(path) ? path : resolve(process.cwd(), path);
  };

  return {
    pythonBinary: config.pythonBinary,
    scriptPath: resolveFile(config.voiceScriptPath),
    speakerWav: resolveFile(config.speakerWav)
  };
}
