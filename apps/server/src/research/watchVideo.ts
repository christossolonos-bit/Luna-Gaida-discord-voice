import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../config/env.js';
import { LocalVoiceService, resolveLocalVoicePaths } from '../live/localVoiceService.js';
import { logger } from '../logging/logger.js';
import { captureProcessOutput, ytDlpCommonArgs } from './ytDlpSupport.js';

export interface WatchedVideoResult {
  ok: boolean;
  url: string;
  title: string;
  channel?: string;
  durationSeconds?: number | null;
  transcript: string;
  method: 'subtitles' | 'whisper' | 'description';
  error?: string;
}

const VIDEO_HOST_RE = /(?:youtube\.com|youtu\.be|twitch\.tv|tiktok\.com|vimeo\.com)/i;

export function isVideoUrl(url: string) {
  try {
    const parsed = new URL(url);
    return VIDEO_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

export async function watchSharedVideo(config: AppConfig, url: string): Promise<WatchedVideoResult> {
  const maxTranscribeSec = config.lunaVideoMaxTranscribeSec ?? 600;
  const maxChars = config.lunaVideoMaxTranscriptChars ?? 10_000;

  try {
    const metadata = await fetchVideoMetadata(config, url);
    const title = metadata.title || url;
    const channel = metadata.channel;
    const durationSeconds = metadata.durationSeconds;
    const description = metadata.description?.trim() ?? '';
    const transcribeSec = durationSeconds != null
      ? Math.min(durationSeconds, maxTranscribeSec)
      : maxTranscribeSec;

    let transcript = await downloadSubtitleTranscript(config, url);
    if (!transcript) {
      transcript = await fetchSubtitleTranscript(metadata.subtitleUrl);
    }
    let method: WatchedVideoResult['method'] = transcript ? 'subtitles' : 'description';

    if (!transcript && transcribeSec > 0) {
      logger.info('Luna watching video via audio transcription', { url, transcribeSec });
      const whisperText = await transcribeVideoAudio(config, url, transcribeSec);
      if (whisperText.trim()) {
        transcript = whisperText;
        method = 'whisper';
      }
    }

    if (!transcript && description) {
      transcript = `Video description (no captions/audio transcript available):\n${description}`;
      method = 'description';
    }

    if (!transcript) {
      return {
        ok: false,
        url,
        title,
        channel,
        durationSeconds,
        transcript: '',
        method: 'description',
        error: durationSeconds && durationSeconds > maxTranscribeSec
          ? `Video is ${Math.round(durationSeconds / 60)} minutes — too long to transcribe without captions.`
          : 'Could not extract subtitles or audio transcript.'
      };
    }

    logger.info('Luna watched shared video', {
      url,
      method,
      title,
      transcriptChars: transcript.length
    });

    return {
      ok: true,
      url: metadata.webpageUrl || url,
      title,
      channel,
      durationSeconds,
      transcript: transcript.slice(0, maxChars),
      method
    };
  } catch (error) {
    logger.warn('Luna video watch failed', {
      url,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      ok: false,
      url,
      title: url,
      transcript: '',
      method: 'description',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function formatWatchedVideoBlock(result: WatchedVideoResult, who: string) {
  if (!result.ok) {
    return [
      `${who} shared a video you tried to watch: ${result.title}`,
      result.error ? `Could not watch it fully: ${result.error}` : 'Could not watch it fully.'
    ].join('\n');
  }

  const duration = result.durationSeconds
    ? ` (${Math.max(1, Math.round(result.durationSeconds / 60))} min)`
    : '';
  const methodLabel = result.method === 'subtitles'
    ? 'captions'
    : result.method === 'whisper'
      ? 'listened and transcribed'
      : 'description only';

  return [
    `${who} shared a video you actually watched (${methodLabel})${duration}: ${result.title}`,
    result.channel ? `Channel: ${result.channel}` : null,
    `Source: ${result.url}`,
    'Transcript / content (react to what happens — jokes, moments, opinions — not just the title):',
    result.transcript
  ].filter(Boolean).join('\n');
}

async function fetchVideoMetadata(config: AppConfig, url: string) {
  const playerClients = [...new Set([config.YTDLP_PLAYER_CLIENTS.trim() || 'default', 'default'])];
  let lastError: unknown;
  for (const clients of playerClients) {
    try {
      const output = await captureProcessOutput(config.YTDLP_BINARY, [
        '--dump-json',
        '--no-playlist',
        '--skip-download',
        ...ytDlpCommonArgs(config, clients),
        url
      ], 45_000);
      const line = output.split(/\r?\n/).find((candidate) => candidate.trim().startsWith('{'));
      if (!line) throw new Error('yt-dlp returned no metadata');
      const parsed = JSON.parse(line) as {
        title?: string;
        channel?: string;
        uploader?: string;
        duration?: number;
        description?: string;
        webpage_url?: string;
        subtitles?: Record<string, Array<{ ext?: string; url?: string }>>;
        automatic_captions?: Record<string, Array<{ ext?: string; url?: string }>>;
      };
      return {
        title: typeof parsed.title === 'string' ? parsed.title.trim() : url,
        channel: (parsed.channel ?? parsed.uploader)?.trim(),
        durationSeconds: typeof parsed.duration === 'number' ? parsed.duration : null,
        description: typeof parsed.description === 'string' ? parsed.description : '',
        webpageUrl: parsed.webpage_url?.trim() || url,
        subtitleUrl: pickSubtitleUrl(parsed.subtitles, parsed.automatic_captions)
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('yt-dlp metadata failed');
}

async function downloadSubtitleTranscript(config: AppConfig, url: string) {
  const tempDir = mkdtempSync(join(tmpdir(), 'luna-subs-'));
  const outputBase = join(tempDir, 'subs');
  const playerClients = [...new Set([config.YTDLP_PLAYER_CLIENTS.trim() || 'default', 'default'])];
  try {
    let lastError: unknown;
    for (const clients of playerClients) {
      try {
        await captureProcessOutput(config.YTDLP_BINARY, [
          '--write-subs',
          '--write-auto-subs',
          '--sub-langs', 'en,en-US,en-GB,en-orig',
          '--sub-format', 'vtt/best',
          '--convert-subs', 'vtt',
          '--skip-download',
          '-o', outputBase,
          '--no-playlist',
          ...ytDlpCommonArgs(config, clients),
          url
        ], 60_000);
        const files = readdirSync(tempDir)
          .filter((name) => /\.(?:vtt|srt)$/i.test(name))
          .sort((a, b) => a.localeCompare(b));
        for (const file of files) {
          const text = captionTextToPlain(readFileSync(join(tempDir, file), 'utf8'));
          if (text) return text;
        }
        return '';
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      logger.debug('yt-dlp subtitle download failed', {
        url,
        error: lastError instanceof Error ? lastError.message : String(lastError)
      });
    }
    return '';
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function pickSubtitleUrl(
  subtitles?: Record<string, Array<{ ext?: string; url?: string }>>,
  automatic?: Record<string, Array<{ ext?: string; url?: string }>>
) {
  const preferredLangs = ['en-orig', 'en', 'en-US', 'en-GB'];
  for (const bucket of [subtitles, automatic]) {
    if (!bucket) continue;
    for (const lang of preferredLangs) {
      const picked = pickFormatUrl(bucket[lang]);
      if (picked) return picked;
    }
    for (const [lang, entries] of Object.entries(bucket)) {
      if (!lang.toLowerCase().startsWith('en')) continue;
      const picked = pickFormatUrl(entries);
      if (picked) return picked;
    }
  }
  return null;
}

function pickFormatUrl(entries?: Array<{ ext?: string; url?: string }>) {
  if (!entries?.length) return null;
  const preferred = ['vtt', 'srt', 'ttml'];
  for (const ext of preferred) {
    const match = entries.find((entry) => entry.ext === ext && entry.url);
    if (match?.url) return match.url;
  }
  return entries.find((entry) => entry.url)?.url ?? null;
}

async function fetchSubtitleTranscript(subtitleUrl: string | null) {
  if (!subtitleUrl) return '';
  const response = await fetch(subtitleUrl, {
    headers: { 'user-agent': 'giada-assistant/0.1 (Luna subtitles)' },
    signal: AbortSignal.timeout(20_000)
  }).catch(() => null);
  if (!response?.ok) return '';
  const raw = await response.text();
  return captionTextToPlain(raw);
}

export function captionTextToPlain(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('WEBVTT')) return vttToText(trimmed);
  if (trimmed.startsWith('{')) return json3ToText(trimmed);
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2}/m.test(trimmed)) return srtToText(trimmed);
  return vttToText(trimmed);
}

export function vttToText(raw: string) {
  const lines = raw.split(/\r?\n/);
  const chunks: string[] = [];
  let previous = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'WEBVTT' || trimmed.startsWith('NOTE') || /-->/.test(trimmed)) {
      continue;
    }
    if (/^\d+$/.test(trimmed)) continue;
    const text = trimmed.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text === previous) continue;
    chunks.push(text);
    previous = text;
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

export function srtToText(raw: string) {
  const blocks = raw.split(/\r?\n\r?\n/);
  const chunks: string[] = [];
  let previous = '';
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const textLines = lines.filter((line) => !/^\d+$/.test(line) && !/-->/.test(line));
    const text = textLines.join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text === previous) continue;
    chunks.push(text);
    previous = text;
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

export function json3ToText(raw: string) {
  try {
    const parsed = JSON.parse(raw) as {
      events?: Array<{ segs?: Array<{ utf8?: string }> }>;
    };
    const chunks: string[] = [];
    let previous = '';
    for (const event of parsed.events ?? []) {
      const text = (event.segs ?? [])
        .map((seg) => seg.utf8?.replace(/\n/g, ' ').trim() ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || text === previous) continue;
      chunks.push(text);
      previous = text;
    }
    return chunks.join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

async function transcribeVideoAudio(config: AppConfig, url: string, maxSec: number) {
  const tempDir = mkdtempSync(join(tmpdir(), 'luna-video-'));
  const audioBase = join(tempDir, 'audio');
  const playerClients = [...new Set([config.YTDLP_PLAYER_CLIENTS.trim() || 'default', 'default'])];
  try {
    let downloaded = false;
    let lastError: unknown;
    for (const clients of playerClients) {
      try {
        await captureProcessOutput(config.YTDLP_BINARY, [
          '-f', 'ba/bestaudio/best',
          '--extract-audio',
          '--audio-format', 'wav',
          '--postprocessor-args', `ffmpeg:-ar 16000 -ac 1 -t ${maxSec}`,
          '-o', audioBase,
          '--no-playlist',
          ...ytDlpCommonArgs(config, clients),
          url
        ], Math.min(300_000, maxSec * 1000 + 120_000));
        downloaded = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!downloaded) {
      throw lastError instanceof Error ? lastError : new Error('yt-dlp audio download failed');
    }

    const wavPath = `${audioBase}.wav`;
    const paths = resolveLocalVoicePaths({
      pythonBinary: config.LOCAL_VOICE_PYTHON,
      voiceScriptPath: config.LOCAL_VOICE_SCRIPT,
      speakerWav: config.XTTS_SPEAKER_WAV
    });
    const voice = new LocalVoiceService({
      pythonBinary: paths.pythonBinary,
      scriptPath: paths.scriptPath,
      whisperModel: config.WHISPER_MODEL,
      speakerWav: paths.speakerWav,
      ttsLanguage: config.XTTS_LANGUAGE,
      whisperLanguage: config.WHISPER_LANGUAGE,
      whisperInitialPrompt: config.WHISPER_INITIAL_PROMPT,
      whisperNoSpeechThreshold: config.WHISPER_NO_SPEECH_THRESHOLD,
      device: config.LOCAL_VOICE_DEVICE,
      enableLocalTts: false
    });
    try {
      await voice.start();
      const text = await voice.transcribe(wavPath, Math.min(300_000, maxSec * 1000 + 60_000));
      logger.info('Luna transcribed shared video audio', { url, chars: text.length });
      return text;
    } finally {
      await voice.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
