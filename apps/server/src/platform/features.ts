import { z } from 'zod';

export const planFeaturesSchema = z.object({
  geminiText: z.boolean().default(false),
  geminiVoice: z.boolean().default(false),
  groqText: z.boolean().default(true),
  nvidiaVision: z.boolean().default(true),
  kimiFallback: z.boolean().default(true),
  nsfw: z.boolean().default(false),
  browserChat: z.boolean().default(false),
  webSearch: z.boolean().default(true),
  music: z.boolean().default(true),
  voiceChanger: z.boolean().default(false),
  customPersonality: z.boolean().default(false),
  customIdentity: z.boolean().default(false),
  byokGemini: z.boolean().default(false),
  byokGroq: z.boolean().default(true),
  byokNvidia: z.boolean().default(false),
  monthlyMessages: z.number().int().nonnegative().default(100),
  monthlyCredits: z.number().int().nonnegative().default(0),
  textCharactersPerCredit: z.number().int().positive().default(1000),
  voiceSecondsPerCredit: z.number().positive().default(10),
  maxPersonalityLength: z.number().int().positive().default(8000),
  maxMessageLength: z.number().int().positive().default(8000)
});

export type PlanFeatures = z.infer<typeof planFeaturesSchema>;

export const FREE_FEATURES: PlanFeatures = planFeaturesSchema.parse({});
export const PAID_FEATURES: PlanFeatures = planFeaturesSchema.parse({
  geminiText: true,
  geminiVoice: true,
  nsfw: true,
  browserChat: true,
  voiceChanger: true,
  customPersonality: true,
  customIdentity: true,
  byokGemini: true,
  byokNvidia: true,
  monthlyMessages: 0,
  monthlyCredits: 1000
});
export const PRIVATE_FEATURES: PlanFeatures = planFeaturesSchema.parse({
  geminiText: true,
  geminiVoice: true,
  nsfw: true,
  browserChat: true,
  voiceChanger: true,
  customPersonality: true,
  customIdentity: true,
  byokGemini: true,
  byokNvidia: true,
  monthlyMessages: 0,
  monthlyCredits: 0
});

export function parsePlanFeatures(value: unknown): PlanFeatures {
  return planFeaturesSchema.parse(value ?? {});
}
