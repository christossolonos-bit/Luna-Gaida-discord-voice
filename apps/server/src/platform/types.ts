import { z } from 'zod';
import { personalitySchema } from '../personality/service.js';

export const guildSettingsSchema = z.object({
  listeningChannelIds: z.array(z.string().regex(/^\d+$/)).max(50).default([]),
  voiceWatchChannelIds: z.array(z.string().regex(/^\d+$/)).max(20).default([]),
  nickname: z.string().trim().min(1).max(32).nullable().default(null),
  avatarUrl: z.string().url().nullable().default(null),
  nsfwEnabled: z.boolean().default(false),
  textProvider: z.enum(['auto', 'groq', 'gemini']).default('auto'),
  voiceProvider: z.enum(['auto', 'gemini']).default('auto'),
  browserTextEnabled: z.boolean().default(true),
  browserVoiceEnabled: z.boolean().default(false),
  voiceChanger: z.object({
    enabled: z.boolean().default(false),
    name: z.string().trim().min(1).max(80).default('bypass'),
    ffmpegFilter: z.string().trim().min(1).max(2000).default('anull')
  }).default({}),
  musicVolume: z.number().min(0).max(1).default(0.35),
  musicDuckVolume: z.number().min(0).max(1).default(0.12)
});

export const guildPersonalitySchema = personalitySchema.omit({ revision: true }).extend({
  customInstructions: z.string().max(8000).default('')
});

export type GuildSettings = z.infer<typeof guildSettingsSchema>;
export type GuildPersonality = z.infer<typeof guildPersonalitySchema>;

export type CredentialProvider = 'gemini' | 'groq' | 'nvidia';
export type UsageKind = 'message' | 'text_credit' | 'voice_credit' | 'adjustment';
