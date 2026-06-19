import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-live-2.5-flash-native-audio'),
  GEMINI_API_VERSION: z.string().default('v1alpha'),
  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_NIM_URL: z.string().url().default('https://integrate.api.nvidia.com/v1/chat/completions'),
  NVIDIA_IMAGE_MODEL: z.string().default('moonshotai/kimi-k2.6'),
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
  FFMPEG_BINARY: z.string().default('ffmpeg'),
  DISCORD_MUSIC_VOLUME: z.coerce.number().min(0).max(1).default(0.35),
  DISCORD_MUSIC_DUCK_VOLUME: z.coerce.number().min(0).max(1).default(0.12),
  SEARXNG_URL: z.string().url().default('http://searxng:8080'),
  GIF_PROVIDER: z.enum(['auto', 'giphy', 'tenor']).default('auto'),
  GIPHY_API_KEY: z.string().optional(),
  TENOR_API_KEY: z.string().optional(),
  TENOR_CLIENT_KEY: z.string().default('giada-assistant')
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.parse(process.env);
  return {
    ...parsed,
    allowedOrigins: parsed.GIADA_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    databasePath: parsed.GIADA_DATABASE_URL.startsWith('file:')
      ? parsed.GIADA_DATABASE_URL.slice('file:'.length)
      : parsed.GIADA_DATABASE_URL
  };
}
