import { describe, expect, it } from 'vitest';
import { FREE_FEATURES, PRIVATE_FEATURES, parsePlanFeatures } from '../src/platform/features.js';
import { guildPersonalitySchema, guildSettingsSchema } from '../src/platform/types.js';
import type { GuildRuntimeConfig } from '../src/platform/store.js';
import { routeText, textCredits, voiceCredits } from '../src/providers/routing.js';

function runtime(kind: GuildRuntimeConfig['planKind'], features = FREE_FEATURES): GuildRuntimeConfig {
  return {
    guildId: '1', planId: '1', planSlug: kind, planKind: kind, features,
    settings: guildSettingsSchema.parse({}),
    personality: guildPersonalitySchema.parse({})
  };
}

describe('plan provider routing', () => {
  it('routes free allowance to shared Groq', () => {
    expect(routeText({ runtime: runtime('free'), hasGroqByok: false, hasGeminiByok: false, sharedQuotaAvailable: true, paidCreditsAvailable: false })).toMatchObject({ provider: 'groq', credential: 'shared', charge: 'message' });
  });

  it('allows Groq BYOK after free quota exhaustion without charging quota', () => {
    expect(routeText({ runtime: runtime('free'), hasGroqByok: true, hasGeminiByok: false, sharedQuotaAvailable: false, paidCreditsAvailable: false })).toMatchObject({ provider: 'groq', credential: 'byok', charge: 'none' });
  });

  it('blocks exhausted free guilds without BYOK', () => {
    expect(routeText({ runtime: runtime('free'), hasGroqByok: false, hasGeminiByok: false, sharedQuotaAvailable: false, paidCreditsAvailable: false }).provider).toBe('blocked');
  });

  it('routes funded paid text to Gemini and exhausted paid text to Groq', () => {
    const paid = runtime('paid', parsePlanFeatures({ geminiText: true, monthlyCredits: 100 }));
    expect(routeText({ runtime: paid, hasGroqByok: false, hasGeminiByok: false, sharedQuotaAvailable: true, paidCreditsAvailable: true }).provider).toBe('gemini');
    expect(routeText({ runtime: paid, hasGroqByok: false, hasGeminiByok: false, sharedQuotaAvailable: true, paidCreditsAvailable: false })).toMatchObject({ provider: 'groq', charge: 'none' });
  });

  it('routes private guilds to private Gemini', () => {
    expect(routeText({ runtime: runtime('private', PRIVATE_FEATURES), hasGroqByok: false, hasGeminiByok: false, sharedQuotaAvailable: true, paidCreditsAvailable: true })).toMatchObject({ provider: 'gemini', credential: 'private', charge: 'none' });
  });
});

describe('usage units', () => {
  it('charges combined input and output characters', () => expect(textCredits(900, 101, 1000)).toBe(2));
  it('charges combined input and output audio duration', () => expect(voiceCredits(6, 5, 10)).toBe(2));
  it('charges a minimum unit for successful turns', () => {
    expect(textCredits(0, 0, 1000)).toBe(1);
    expect(voiceCredits(0, 0, 10)).toBe(1);
  });
});

describe('guild configuration validation', () => {
  it('defaults to fixed, safe free settings', () => {
    const settings = guildSettingsSchema.parse({});
    expect(settings.nsfwEnabled).toBe(false);
    expect(settings.listeningChannelIds).toEqual([]);
    expect(guildPersonalitySchema.parse({})).not.toHaveProperty('revision');
  });
});
