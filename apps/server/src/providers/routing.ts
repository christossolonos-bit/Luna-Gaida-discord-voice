import type { GuildRuntimeConfig } from '../platform/store.js';

export type TextProviderRoute =
  | { provider: 'groq'; credential: 'byok' | 'shared'; charge: 'message' | 'none'; reason: string }
  | { provider: 'gemini'; credential: 'byok' | 'paid' | 'private'; charge: 'credits' | 'none'; reason: string }
  | { provider: 'blocked'; credential: 'none'; charge: 'none'; reason: string };

export function routeText(input: {
  runtime: GuildRuntimeConfig;
  hasGroqByok: boolean;
  hasGeminiByok: boolean;
  sharedQuotaAvailable: boolean;
  paidCreditsAvailable: boolean;
}): TextProviderRoute {
  const { runtime } = input;
  if (runtime.settings.textProvider === 'gemini' && input.hasGeminiByok && runtime.features.byokGemini) {
    return { provider: 'gemini', credential: 'byok', charge: 'none', reason: 'guild_gemini_byok' };
  }
  if (runtime.settings.textProvider === 'groq' && input.hasGroqByok && runtime.features.byokGroq) {
    return { provider: 'groq', credential: 'byok', charge: 'none', reason: 'guild_groq_byok' };
  }
  if (runtime.settings.textProvider === 'groq' && runtime.features.groqText && (runtime.planKind !== 'free' || input.sharedQuotaAvailable)) {
    return { provider: 'groq', credential: 'shared', charge: runtime.planKind === 'free' ? 'message' : 'none', reason: 'guild_shared_groq' };
  }
  if (runtime.planKind === 'private' && runtime.features.geminiText) {
    return { provider: 'gemini', credential: 'private', charge: 'none', reason: 'private_plan' };
  }
  if (runtime.planKind === 'paid' && runtime.features.geminiText && input.paidCreditsAvailable) {
    return { provider: 'gemini', credential: 'paid', charge: 'credits', reason: 'paid_gemini' };
  }
  if (input.hasGroqByok && runtime.features.byokGroq) {
    return { provider: 'groq', credential: 'byok', charge: 'none', reason: 'guild_groq_byok_fallback' };
  }
  if (runtime.features.groqText && (runtime.planKind === 'paid' || input.sharedQuotaAvailable)) {
    return {
      provider: 'groq',
      credential: 'shared',
      charge: runtime.planKind === 'free' ? 'message' : 'none',
      reason: runtime.planKind === 'paid' ? 'paid_credit_exhausted' : 'free_shared_quota'
    };
  }
  return { provider: 'blocked', credential: 'none', charge: 'none', reason: 'quota_or_feature_unavailable' };
}

export function textCredits(inputCharacters: number, outputCharacters: number, charactersPerCredit: number) {
  return Math.max(1, Math.ceil((inputCharacters + outputCharacters) / charactersPerCredit));
}

export function voiceCredits(inputSeconds: number, outputSeconds: number, secondsPerCredit: number) {
  return Math.max(1, Math.ceil((inputSeconds + outputSeconds) / secondsPerCredit));
}
