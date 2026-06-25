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
  GROQ_API_URL: z.string().url().default('https://api.groq.com/openai/v1/chat/completions'),
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
  WHISPER_INITIAL_PROMPT: z.string().default(''),
  WHISPER_NO_SPEECH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35)
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.parse(process.env);
  return {
    ...parsed,
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
