import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../config/env.js';
import { logger } from '../logging/logger.js';

export function captureProcessOutput(command: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    timeout.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString('utf8'), 1024 * 1024);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString('utf8'));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code && code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function ytDlpCommonArgs(config: AppConfig, playerClients = config.YTDLP_PLAYER_CLIENTS) {
  const args: string[] = [
    '--remote-components',
    config.YTDLP_REMOTE_COMPONENTS,
    '--js-runtimes',
    config.YTDLP_JS_RUNTIME,
    '--extractor-args',
    `youtube:player_client=${playerClients}`
  ];
  const ffmpeg = config.FFMPEG_BINARY?.trim();
  if (ffmpeg) {
    args.push('--ffmpeg-location', ffmpeg);
  }
  const cookiesPath = config.YTDLP_COOKIES_PATH?.trim();
  if (cookiesPath && isRegularFile(cookiesPath)) {
    const writableCookiesPath = prepareWritableCookiesFile(cookiesPath);
    if (writableCookiesPath) {
      args.push('--cookies', writableCookiesPath);
    }
  }
  const cookiesFromBrowser = config.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (cookiesFromBrowser) {
    args.push('--cookies-from-browser', cookiesFromBrowser);
  }
  const potProviderUrl = config.YTDLP_POT_PROVIDER_URL?.trim();
  if (potProviderUrl) {
    args.push(
      '--extractor-args',
      `youtubepot-bgutilhttp:base_url=${potProviderUrl}`
    );
  }
  return args;
}

function isRegularFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function prepareWritableCookiesFile(sourcePath: string) {
  try {
    const directory = join(tmpdir(), 'giada-yt-dlp');
    const runtimePath = join(directory, `youtube-cookies-${process.pid}.txt`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const sourceModifiedAt = statSync(sourcePath).mtimeMs;
    const runtimeModifiedAt = isRegularFile(runtimePath) ? statSync(runtimePath).mtimeMs : -1;
    if (sourceModifiedAt > runtimeModifiedAt) {
      copyFileSync(sourcePath, runtimePath);
      chmodSync(runtimePath, 0o600);
    }
    return runtimePath;
  } catch (error) {
    logger.warn('Could not prepare writable yt-dlp cookies file', {
      sourcePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function appendLimited(current: string, next: string, limit = 4000) {
  const combined = current + next;
  return combined.length > limit ? combined.slice(combined.length - limit) : combined;
}
