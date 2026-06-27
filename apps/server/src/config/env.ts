import dotenv from 'dotenv';
import { dirname, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseWakePhrases } from '../live/wakePhrase.js';

const here = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  resolve(here, '../../../../../.env'),
  resolve(here, '../../../../.env'),
  resolve(here, '../../../.env'),
  resolve(here, '../../.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(process.cwd(), '../.env'),
  resolve(process.cwd(), '.env')
];

for (const path of [...new Set(envCandidates)].filter((candidate) => existsSync(candidate))) {
  dotenv.config({ path, override: true });
}

const envSchema = z.object({
  GEMINI_MODEL: z.string().default('gemini-live-2.5-flash-native-audio'),
  GEMINI_API_VERSION: z.string().default('v1alpha'),
  NVIDIA_NIM_URL: z.string().url().default('https://integrate.api.nvidia.com/v1/chat/completions'),
  NVIDIA_IMAGE_MODEL: z.string().default('moonshotai/kimi-k2.6'),
  OLLAMA_API_URL: z.string().url().optional(),
  OLLAMA_MODEL: z.string().optional(),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  OLLAMA_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high']).optional(),
  /** @deprecated Use OLLAMA_* for local Luna. Kept for Giada platform Groq Cloud routing. */
  GROQ_API_URL: z.string().url().default('https://api.groq.com/openai/v1/chat/completions'),
  /** @deprecated Use OLLAMA_MODEL for local Luna. */
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  GROQ_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high']).optional(),
  GIADA_POSTGRES_URL: z.string().url().optional(),
  GIADA_MASTER_KEY: z.string().optional(),
  GIADA_PUBLIC_URL: z.string().url().default('http://127.0.0.1:8787'),
  GIADA_WEB_DIST: z.string().default('./apps/web/dist'),
  GIADA_UPLOAD_DIR: z.string().default('./data/uploads'),
  GIADA_OWNER_DISCORD_USER_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  GIADA_SERVER_HOST: z.string().default('127.0.0.1'),
  GIADA_SERVER_PORT: z.coerce.number().int().positive().default(8787),
  GIADA_DATABASE_URL: z.string().default('file:./data/giada.sqlite'),
  GIADA_DEFAULT_LANGUAGE: z.string().default('it-IT'),
  GIADA_ALLOWED_ORIGINS: z.string().default('tauri://localhost,http://localhost:1420'),
  GIADA_MEMORY_TOOLS_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_BEARER_TOKEN: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  DISCORD_PUBLIC_KEY: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_REGISTER_GLOBAL_COMMANDS: z.coerce.boolean().default(false),
  DISCORD_SHARDING_ENABLED: z.coerce.boolean().default(false),
  DISCORD_SHARD_COUNT: z.string().default('auto'),
  DISCORD_SHARD_RESPAWN: z.coerce.boolean().default(true),
  YTDLP_BINARY: z.string().default('yt-dlp'),
  YTDLP_COOKIES_PATH: z.string().optional(),
  YTDLP_COOKIES_FROM_BROWSER: z.string().optional(),
  YTDLP_PLAYER_CLIENTS: z.string().default('default'),
  YTDLP_JS_RUNTIME: z.string().default('deno'),
  YTDLP_REMOTE_COMPONENTS: z.string().default('ejs:github'),
  YTDLP_POT_PROVIDER_URL: z.string().url().optional(),
  FFMPEG_BINARY: z.string().default('ffmpeg'),
  DISCORD_MUSIC_VOLUME: z.coerce.number().min(0).max(1).default(0.35),
  DISCORD_MUSIC_DUCK_VOLUME: z.coerce.number().min(0).max(1).default(0.12),
  DISCORD_VOICE_CHANGER_CONFIG: z.string().default('./config/voice-changer.json'),
  SEARXNG_URL: z.string().url().default('http://searxng:8080'),
  GIF_PROVIDER: z.enum(['auto', 'giphy', 'tenor']).default('auto'),
  GIPHY_API_KEY: z.string().optional(),
  TENOR_API_KEY: z.string().optional(),
  TENOR_CLIENT_KEY: z.string().default('giada-assistant'),
  GIADA_VOICE_PROVIDER: z.enum(['gemini', 'local']).default('gemini'),
  LOCAL_VOICE_PYTHON: z.string().default('python'),
  LOCAL_VOICE_SCRIPT: z.string().default('./scripts/local_voice_service.py'),
  LOCAL_VOICE_DEVICE: z.string().optional(),
  WHISPER_MODEL: z.string().default('base'),
  WHISPER_LANGUAGE: z.string().optional(),
  XTTS_SPEAKER_WAV: z.string().default('./voices/Serafina - Sensual Temptress_pvc_sp92_s31_sb81_v3.mp3'),
  XTTS_LANGUAGE: z.string().default('en'),
  LUNA_WAKE_PHRASES: z.string().default('hey luna,hello luna'),
  LUNA_WAKE_REQUIRED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  LUNA_VOICE_INPUT_MODE: z.enum(['auto', 'ptt']).default('ptt'),
  LUNA_SPEECH_END_SILENCE_MS: z.coerce.number().int().positive().default(5000),
  LUNA_DEBUG_AUDIO: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  LUNA_USER_VOICE_MEMORY: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  LUNA_LIFE_MEMORY: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  LUNA_COMMAND_WINDOW_SEC: z.coerce.number().int().positive().default(8),
  LUNA_WAKE_MODE: z.enum(['split', 'combined']).default('split'),
  LUNA_LISTENING_ACK: z.string().default("Yes, darling? I'm listening."),
  LUNA_ECHO_MUTE_MS: z.coerce.number().int().nonnegative().default(3500),
  LUNA_AUTONOMOUS_REACH_OUT: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_INITIATIVE_MIN_SEC: z.coerce.number().int().min(15).default(60),
  LUNA_INITIATIVE_MAX_SEC: z.coerce.number().int().min(30).default(300),
  LUNA_INITIATIVE_MIN_SILENCE_SEC: z.coerce.number().int().min(10).default(20),
  LUNA_AUTONOMOUS_DM: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_DM_MIN_SEC: z.coerce.number().int().min(60).default(60),
  LUNA_DM_MAX_SEC: z.coerce.number().int().min(120).default(300),
  LUNA_DM_COOLDOWN_HOURS: z.coerce.number().min(1).default(12),
  LUNA_DM_MAX_PER_DAY: z.coerce.number().int().min(1).default(5),
  LUNA_RESEARCH_ENABLED: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_RSS_FEEDS: z.string().default([
    'http://feeds.bbci.co.uk/news/technology/rss.xml',
    'http://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
    'https://www.theverge.com/rss/index.xml',
    'https://feeds.ign.com/ign/games-all',
    'https://feeds.arstechnica.com/arstechnica/index',
    'http://feeds.bbci.co.uk/news/rss.xml'
  ].join(',')),
  LUNA_CURIOSITY_MIN_SEC: z.coerce.number().int().min(60).default(60),
  LUNA_CURIOSITY_MAX_SEC: z.coerce.number().int().min(90).default(300),
  LUNA_RESEARCH_MAX_PER_DAY: z.coerce.number().int().min(1).default(20),
  LUNA_RESEARCH_MAX_READ_CHARS: z.coerce.number().int().min(1000).default(6000),
  LUNA_LINK_TRUSTED_SENDERS: z.string().default('solonaras,travis'),
  WHISPER_INITIAL_PROMPT: z.string().default(''),
  WHISPER_NO_SPEECH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  LUNA_TTS_PROVIDER: z.enum(['xtts', 'fish']).default('xtts'),
  FISH_AUDIO_API_KEY: z.string().optional(),
  FISH_AUDIO_REFERENCE_ID: z.string().optional(),
  FISH_AUDIO_MODEL: z.string().default('s2.1-pro-free'),
  FISH_AUDIO_PROSODY_SPEED: z.coerce.number().min(0.5).max(2).default(1),
  LOCAL_LIVE_CHAT_SCRIPT: z.string().default('./scripts/live_chat_service.py'),
  TWITCH_OAUTH_TOKEN: z.string().optional(),
  TWITCH_USERNAME: z.string().optional(),
  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),
  TWITCH_CHANNEL: z.string().optional(),
  LUNA_CREATOR_NAME: z.string().optional(),
  LUNA_OWNER_TWITCH_LOGIN: z.string().optional(),
  LUNA_TWITCH_LIVE_CHAT: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_TWITCH_LIVE_AUTO_REPLY: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_TWITCH_LIVE_AUTO_TRIGGER: z.string().optional(),
  LUNA_TWITCH_LIVE_TTS: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_TWITCH_LIVE_CHAT_REPLY: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_YOUTUBE_LIVE_CHAT: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_YOUTUBE_LIVE_CHECK_URL: z.string().optional(),
  LUNA_YOUTUBE_LIVE_AUTO_REPLY: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_YOUTUBE_LIVE_AUTO_TRIGGER: z.string().optional(),
  LUNA_YOUTUBE_LIVE_TTS: z.enum(['true', 'false', '1', '0']).optional(),
  LUNA_YOUTUBE_LIVE_POLL_SEC: z.coerce.number().positive().optional(),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REFRESH_TOKEN: z.string().optional()
});

export type AppConfig = ReturnType<typeof loadConfig>;

function envString(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function envFlag(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key];
    if (value === undefined) continue;
    if (value === '1' || value.toLowerCase() === 'true') return true;
    if (value === '0' || value.toLowerCase() === 'false') return false;
  }
  return undefined;
}

export function loadConfig() {
  const parsed = envSchema.parse(process.env);
  const twitchUsername = parsed.TWITCH_USERNAME ?? envString('twitch_username', 'TWITCH_USERNAME');
  const twitchChannel = parsed.TWITCH_CHANNEL ?? envString('twitch_channel', 'TWITCH_CHANNEL');
  const twitchClientId = parsed.TWITCH_CLIENT_ID ?? envString('twitch_client_id', 'TWITCH_CLIENT_ID');
  const twitchClientSecret = parsed.TWITCH_CLIENT_SECRET ?? envString('twitch_client_secret', 'TWITCH_CLIENT_SECRET');
  const twitchOAuthToken = parsed.TWITCH_OAUTH_TOKEN ?? envString('TWITCH_OAUTH_TOKEN');
  const twitchLiveChat = envFlag('LUNA_TWITCH_LIVE_CHAT') ?? Boolean(twitchOAuthToken && twitchChannel);
  const youtubeLiveChat = envFlag('LUNA_YOUTUBE_LIVE_CHAT') ?? false;

  const ollamaApiUrl = parsed.OLLAMA_API_URL
    ?? envString('OLLAMA_API_URL')
    ?? envString('GROQ_API_URL')
    ?? 'http://127.0.0.1:11434/v1/chat/completions';
  const ollamaModel = parsed.OLLAMA_MODEL
    ?? envString('OLLAMA_MODEL')
    ?? envString('GROQ_MODEL')
    ?? 'qwen3.5:4b';
  const ollamaTimeoutMs = parsed.OLLAMA_TIMEOUT_MS
    ?? parsed.GROQ_TIMEOUT_MS;
  const ollamaReasoningEffort = parsed.OLLAMA_REASONING_EFFORT
    ?? parsed.GROQ_REASONING_EFFORT
    ?? 'none';

  return {
    ...parsed,
    ollamaApiUrl,
    ollamaModel,
    ollamaTimeoutMs,
    ollamaReasoningEffort,
    twitchUsername,
    twitchChannel,
    twitchClientId,
    twitchClientSecret,
    twitchOAuthToken,
    twitchLiveChat,
    twitchAutoReply: envFlag('LUNA_TWITCH_LIVE_AUTO_REPLY') ?? true,
    twitchAutoTrigger: parsed.LUNA_TWITCH_LIVE_AUTO_TRIGGER ?? envString('LUNA_TWITCH_LIVE_AUTO_TRIGGER') ?? 'all',
    twitchTts: envFlag('LUNA_TWITCH_LIVE_TTS') ?? true,
    twitchChatReply: envFlag('LUNA_TWITCH_LIVE_CHAT_REPLY') ?? false,
    youtubeLiveChat,
    youtubeCheckUrl: parsed.LUNA_YOUTUBE_LIVE_CHECK_URL ?? envString('LUNA_YOUTUBE_LIVE_CHECK_URL'),
    youtubeAutoReply: envFlag('LUNA_YOUTUBE_LIVE_AUTO_REPLY') ?? true,
    youtubeTts: envFlag('LUNA_YOUTUBE_LIVE_TTS') ?? true,
    youtubeAutoTrigger: parsed.LUNA_YOUTUBE_LIVE_AUTO_TRIGGER ?? envString('LUNA_YOUTUBE_LIVE_AUTO_TRIGGER') ?? 'all',
    youtubePollSec: parsed.LUNA_YOUTUBE_LIVE_POLL_SEC ?? 0.5,
    lunaCreatorName: parsed.LUNA_CREATOR_NAME ?? envString('LUNA_CREATOR_NAME'),
    lunaOwnerTwitchLogin: parsed.LUNA_OWNER_TWITCH_LOGIN ?? envString('LUNA_OWNER_TWITCH_LOGIN'),
    lunaAutonomousReachOut: envFlag('LUNA_AUTONOMOUS_REACH_OUT') ?? parsed.GIADA_VOICE_PROVIDER === 'local',
    lunaInitiativeMinSec: parsed.LUNA_INITIATIVE_MIN_SEC,
    lunaInitiativeMaxSec: Math.max(parsed.LUNA_INITIATIVE_MAX_SEC, parsed.LUNA_INITIATIVE_MIN_SEC + 10),
    lunaInitiativeMinSilenceSec: parsed.LUNA_INITIATIVE_MIN_SILENCE_SEC,
    lunaAutonomousDm: envFlag('LUNA_AUTONOMOUS_DM') ?? parsed.GIADA_VOICE_PROVIDER === 'local',
    lunaDmMinSec: parsed.LUNA_DM_MIN_SEC,
    lunaDmMaxSec: Math.max(parsed.LUNA_DM_MAX_SEC, parsed.LUNA_DM_MIN_SEC + 60),
    lunaDmCooldownHours: parsed.LUNA_DM_COOLDOWN_HOURS,
    lunaDmMaxPerDay: parsed.LUNA_DM_MAX_PER_DAY,
    lunaResearchEnabled: envFlag('LUNA_RESEARCH_ENABLED') ?? parsed.GIADA_VOICE_PROVIDER === 'local',
    lunaRssFeeds: parsed.LUNA_RSS_FEEDS.split(',').map((feed) => feed.trim()).filter(Boolean),
    lunaCuriosityMinSec: parsed.LUNA_CURIOSITY_MIN_SEC,
    lunaCuriosityMaxSec: Math.max(parsed.LUNA_CURIOSITY_MAX_SEC, parsed.LUNA_CURIOSITY_MIN_SEC + 60),
    lunaResearchMaxPerDay: parsed.LUNA_RESEARCH_MAX_PER_DAY,
    lunaResearchMaxReadChars: parsed.LUNA_RESEARCH_MAX_READ_CHARS,
    lunaLinkTrustedSenders: parsed.LUNA_LINK_TRUSTED_SENDERS
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    youtubeClientId: parsed.YOUTUBE_CLIENT_ID ?? envString('YOUTUBE_CLIENT_ID', 'youtube_client_id'),
    youtubeClientSecret: parsed.YOUTUBE_CLIENT_SECRET ?? envString('YOUTUBE_CLIENT_SECRET', 'youtube_client_secret'),
    youtubeRefreshToken: parsed.YOUTUBE_REFRESH_TOKEN ?? envString('YOUTUBE_REFRESH_TOKEN', 'youtube_refresh_token'),
    liveChatScriptPath: resolveProjectFile(parsed.LOCAL_LIVE_CHAT_SCRIPT),
    wakePhrases: parseWakePhrases(parsed.LUNA_WAKE_PHRASES),
    DISCORD_VOICE_CHANGER_CONFIG: resolveProjectFile(parsed.DISCORD_VOICE_CHANGER_CONFIG),
    allowedOrigins: parsed.GIADA_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    databasePath: resolveDatabasePath(parsed.GIADA_DATABASE_URL),
    webDistPath: resolveProjectFile(parsed.GIADA_WEB_DIST),
    uploadDir: resolveProjectFile(parsed.GIADA_UPLOAD_DIR)
  };
}

function resolveProjectFile(path: string) {
  if (isAbsolute(path)) return path;
  const candidates = [
    resolve(process.cwd(), path),
    resolve(here, '../../../', path),
    resolve(here, '../../../../', path),
    resolve(here, '../../../../../', path)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** SQLite path anchored to the repo root so voice memory is not split across cwd folders. */
function resolveDatabasePath(url: string) {
  const path = url.startsWith('file:') ? url.slice('file:'.length) : url;
  if (isAbsolute(path)) return path;
  const repoRoot = resolve(here, '../../../');
  return resolve(repoRoot, path);
}
