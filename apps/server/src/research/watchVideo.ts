import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../config/env.js';
import { LocalVoiceService, resolveLocalVoicePaths } from '../live/localVoiceService.js';
import { describeVideoSnapshots } from './videoVision.js';
import { logger } from '../logging/logger.js';
import { captureProcessOutput, ytDlpCommonArgs } from './ytDlpSupport.js';

export interface WatchedVideoResult {
  ok: boolean;
  url: string;
  title: string;
  channel?: string;
  durationSeconds?: number | null;
  transcript: string;
  visualDescription?: string;
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
    let visualDescription = '';

    const wantsVision = config.lunaVideoVisionEnabled;
    const needsClip = !transcript || wantsVision;

    if (needsClip && transcribeSec > 0) {
      const clip = await downloadVideoClip(config, url, transcribeSec);
      if (clip) {
        try {
          if (!transcript) {
            logger.info('Luna listening to video audio (Whisper)', { url, transcribeSec });
            const whisperText = await transcribeClipAudio(config, clip.videoPath, transcribeSec);
            if (whisperText.trim()) {
              transcript = whisperText;
              method = 'whisper';
            }
          }

          if (wantsVision) {
            visualDescription = await captureVideoVisualNotes(config, clip.videoPath, title, url, transcribeSec);
          }
        } finally {
          rmSync(clip.tempDir, { recursive: true, force: true });
        }
      } else {
        if (!transcript) {
          logger.info('Luna listening to video audio (Whisper)', { url, transcribeSec });
          const whisperText = await transcribeVideoAudio(config, url, transcribeSec);
          if (whisperText.trim()) {
            transcript = whisperText;
            method = 'whisper';
          }
        }
        if (wantsVision) {
          visualDescription = await captureVideoVisualNotesFromThumbnail(config, url, title);
        }
      }
    } else if (wantsVision) {
      visualDescription = await captureVideoVisualNotesFromThumbnail(config, url, title);
    }

    if (!transcript && description) {
      transcript = `Video description (no captions/audio transcript available):\n${description}`;
      method = 'description';
    }

    if (!transcript && !visualDescription) {
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
          : 'Could not extract subtitles, audio, or video snapshots.'
      };
    }

    if (!transcript) {
      transcript = '(No audio transcript available — use the visual snapshot notes.)';
      method = 'description';
    }

    logger.info('Luna watched shared video', {
      url,
      method,
      title,
      transcriptChars: transcript.length,
      hasVisualNotes: Boolean(visualDescription)
    });

    return {
      ok: true,
      url: metadata.webpageUrl || url,
      title,
      channel,
      durationSeconds,
      transcript: transcript.slice(0, maxChars),
      visualDescription: visualDescription.trim() || undefined,
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
  const methodLabel = result.method === 'whisper'
    ? 'listened and transcribed'
    : result.method === 'subtitles'
      ? 'captions'
      : 'description only';

  return [
    `${who} shared a video you actually watched (${methodLabel})${duration}: ${result.title}`,
    result.channel ? `Channel: ${result.channel}` : null,
    `Source: ${result.url}`,
    result.visualDescription
      ? `What you saw on screen (snapshot vision):\n${result.visualDescription}`
      : null,
    'Transcript / audio (react to what happens — jokes, moments, opinions — not just the title):',
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
          '-x',
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

    const wavPath = findDownloadedAudioFile(tempDir, audioBase);
    if (!wavPath) {
      throw new Error('yt-dlp did not produce an audio file for transcription');
    }

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

function findDownloadedAudioFile(tempDir: string, audioBase: string) {
  const prefix = basename(audioBase);
  const candidates = readdirSync(tempDir)
    .filter((name) => name.startsWith(prefix) && /\.(?:wav|m4a|webm|opus|mp3|mp4)$/i.test(name))
    .sort((a, b) => {
      const score = (file: string) => (file.endsWith('.wav') ? 0 : 1);
      return score(a) - score(b);
    })
    .map((name) => join(tempDir, name));
  return candidates[0] ?? null;
}

interface DownloadedVideoClip {
  tempDir: string;
  videoPath: string;
}

async function downloadVideoClip(config: AppConfig, url: string, maxSec: number): Promise<DownloadedVideoClip | null> {
  const tempDir = mkdtempSync(join(tmpdir(), 'luna-clip-'));
  const videoBase = join(tempDir, 'clip');
  const playerClients = [...new Set([config.YTDLP_PLAYER_CLIENTS.trim() || 'default', 'default'])];
  try {
    let lastError: unknown;
    for (const clients of playerClients) {
      try {
        await captureProcessOutput(config.YTDLP_BINARY, [
          '-f', 'bv*[height<=720]+ba/b[height<=720]/best[height<=720]',
          '--merge-output-format', 'mp4',
          '--postprocessor-args', `ffmpeg:-t ${maxSec}`,
          '-o', videoBase,
          '--no-playlist',
          ...ytDlpCommonArgs(config, clients),
          url
        ], Math.min(300_000, maxSec * 1000 + 120_000));
        const videoPath = findDownloadedVideoFile(tempDir, videoBase);
        if (!videoPath) {
          throw new Error('yt-dlp did not produce a video file');
        }
        return { tempDir, videoPath };
      } catch (error) {
        lastError = error;
      }
    }
    logger.warn('Video clip download failed', {
      url,
      error: lastError instanceof Error ? lastError.message : String(lastError)
    });
    rmSync(tempDir, { recursive: true, force: true });
    return null;
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function findDownloadedVideoFile(tempDir: string, videoBase: string) {
  const prefix = basename(videoBase);
  const candidates = readdirSync(tempDir)
    .filter((name) => name.startsWith(prefix) && /\.(?:mp4|mkv|webm|mov)$/i.test(name))
    .map((name) => join(tempDir, name));
  return candidates[0] ?? null;
}

async function transcribeClipAudio(config: AppConfig, videoPath: string, maxSec: number) {
  const wavPath = `${videoPath}.luna-audio.wav`;
  await captureProcessOutput(config.FFMPEG_BINARY, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', videoPath,
    '-ar', '16000',
    '-ac', '1',
    '-t', String(maxSec),
    '-y',
    wavPath
  ], Math.min(300_000, maxSec * 1000 + 60_000));

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
    return await voice.transcribe(wavPath, Math.min(300_000, maxSec * 1000 + 60_000));
  } finally {
    await voice.close();
    try {
      rmSync(wavPath, { force: true });
    } catch {
      // ignore
    }
  }
}

export function pickFrameTimestamps(durationSec: number, count: number) {
  const safeDuration = Math.max(durationSec, 2);
  if (count <= 1) {
    return [Math.min(Math.max(1, safeDuration * 0.5), safeDuration - 0.5)];
  }
  const ratios = [0.08, 0.45, 0.82, 0.2, 0.65];
  return ratios
    .slice(0, count)
    .map((ratio) => Math.max(0.5, Math.min(safeDuration - 0.5, safeDuration * ratio)));
}

async function extractVideoFrames(config: AppConfig, videoPath: string, durationSec: number, count: number) {
  const timestamps = pickFrameTimestamps(durationSec, count);
  const frames: Array<{ label: string; jpeg: Buffer }> = [];
  const tempDir = dirname(videoPath);

  for (const [index, timestamp] of timestamps.entries()) {
    const framePath = join(tempDir, `frame-${index}-${Math.round(timestamp)}.jpg`);
    try {
      await captureProcessOutput(config.FFMPEG_BINARY, [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', String(timestamp),
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '4',
        '-y',
        framePath
      ], 45_000);
      frames.push({
        label: `Snapshot at ${Math.round(timestamp)}s`,
        jpeg: readFileSync(framePath)
      });
    } catch (error) {
      logger.debug('Video frame extraction failed', {
        videoPath,
        timestamp,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return frames;
}

async function probeVideoDurationSec(config: AppConfig, videoPath: string) {
  try {
    const output = await captureProcessOutput(config.FFMPEG_BINARY, [
      '-hide_banner',
      '-i', videoPath
    ], 20_000);
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
}

async function captureVideoVisualNotes(
  config: AppConfig,
  videoPath: string,
  title: string,
  _url: string,
  fallbackDurationSec: number
) {
  const duration = (await probeVideoDurationSec(config, videoPath)) ?? fallbackDurationSec;
  const frames = await extractVideoFrames(config, videoPath, duration, config.lunaVideoVisionFrames ?? 3);
  if (!frames.length) {
    return '';
  }
  return describeVideoSnapshots(config, frames, title).catch((error) => {
    logger.warn('Video snapshot vision failed', {
      title,
      error: error instanceof Error ? error.message : String(error)
    });
    return '';
  });
}

export function extractYoutubeVideoId(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.replace(/^\//, '').split('/')[0] ?? null;
    }
    if (parsed.hostname.includes('youtube.com')) {
      return parsed.searchParams.get('v');
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchYoutubeThumbnailJpeg(videoId: string) {
  for (const quality of ['maxresdefault', 'hqdefault', 'mqdefault']) {
    const thumbUrl = `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
    const response = await fetch(thumbUrl, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!response?.ok) continue;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 1000) {
      return buffer;
    }
  }
  return null;
}

async function captureVideoVisualNotesFromThumbnail(config: AppConfig, url: string, title: string) {
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) return '';
  const jpeg = await fetchYoutubeThumbnailJpeg(videoId);
  if (!jpeg) return '';
  return describeVideoSnapshots(
    config,
    [{ label: 'Video thumbnail', jpeg }],
    title
  ).catch((error) => {
    logger.warn('Video thumbnail vision failed', {
      title,
      error: error instanceof Error ? error.message : String(error)
    });
    return '';
  });
}
