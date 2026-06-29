import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../config/env.js';
import { FishAudioTts } from './fishAudioTts.js';
import { logger } from '../logging/logger.js';
import { buildFishTtsFromReply } from './voiceActions.js';
import { analyzeFishTtsDelivery, buildFishDeliveryContext } from './fishAudioDelivery.js';
import { MAX_DM_TTS_CHARS, splitDmTtsText } from './lunaDmTtsSplit.js';

export { MAX_DM_TTS_CHARS, splitDmTtsText } from './lunaDmTtsSplit.js';

export interface LunaDmVoiceAttachment {
  buffer: Buffer;
  name: string;
}

let cachedFishTts: FishAudioTts | null = null;
let cachedFishKey = '';

function getFishTts(config: AppConfig) {
  const apiKey = config.FISH_AUDIO_API_KEY?.trim();
  if (!apiKey || config.LUNA_TTS_PROVIDER !== 'fish') {
    return null;
  }
  const key = `${apiKey}|${config.FISH_AUDIO_REFERENCE_ID ?? ''}|${config.FISH_AUDIO_MODEL}`;
  if (!cachedFishTts || cachedFishKey !== key) {
    cachedFishTts = new FishAudioTts({
      apiKey,
      referenceId: config.FISH_AUDIO_REFERENCE_ID,
      model: config.FISH_AUDIO_MODEL,
      prosodySpeed: config.FISH_AUDIO_PROSODY_SPEED,
      tempDir: join(tmpdir(), 'giada-fish-dm-tts')
    });
    cachedFishKey = key;
  }
  return cachedFishTts;
}

export function prepareDmTtsChunks(text: string, relationship?: string | null) {
  return splitDmTtsText(text, MAX_DM_TTS_CHARS)
    .map((chunk) => buildFishTtsFromReply(chunk, { relationship }).ttsText.trim())
    .filter(Boolean);
}

/** @deprecated Use prepareDmTtsChunks — kept for callers expecting a single string. */
export function prepareDmTtsText(text: string, relationship?: string | null) {
  return prepareDmTtsChunks(text, relationship).join(' ');
}

async function mergeMp3Parts(
  ffmpegBinary: string,
  tempDir: string,
  partPaths: string[],
  outPath: string
) {
  const listPath = join(tempDir, 'concat.txt');
  const listContent = partPaths
    .map((partPath) => `file '${partPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(listPath, listContent, 'utf8');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBinary, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      outPath
    ], { windowsHide: true });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg concat exited with code ${code}`));
    });
  });
}

export async function buildLunaDmVoiceAttachment(
  config: AppConfig,
  text: string,
  relationship?: string | null
): Promise<LunaDmVoiceAttachment | null> {
  if (!config.lunaDmTtsEnabled) {
    return null;
  }

  const fish = getFishTts(config);
  if (!fish) {
    return null;
  }

  const chunks = prepareDmTtsChunks(text, relationship);
  if (!chunks.length) {
    return null;
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'luna-dm-tts-'));
  const outPath = join(tempDir, 'luna.mp3');
  const delivery = analyzeFishTtsDelivery(
    chunks.join(' '),
    buildFishDeliveryContext(config, relationship ?? null)
  );
  const synthOptions = {
    referenceId: delivery.referenceId,
    prosodySpeed: delivery.prosodySpeed,
    prosodyVolume: delivery.prosodyVolume
  };

  try {
    const partPaths: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const partPath = join(tempDir, `part-${index}.mp3`);
      await fish.synthesizeToFile(chunks[index]!, partPath, 'mp3', synthOptions);
      partPaths.push(partPath);
    }

    if (partPaths.length === 1) {
      writeFileSync(outPath, readFileSync(partPaths[0]!));
    } else {
      await mergeMp3Parts(config.FFMPEG_BINARY, tempDir, partPaths, outPath);
    }

    const buffer = readFileSync(outPath);
    if (!buffer.length) {
      return null;
    }

    logger.info('Luna DM voice attachment ready', {
      bytes: buffer.length,
      chars: text.trim().length,
      parts: partPaths.length
    });
    return { buffer, name: 'luna.mp3' };
  } catch (error) {
    logger.warn('Luna DM voice attachment failed', {
      error: error instanceof Error ? error.message : String(error),
      parts: chunks.length
    });
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
