import { extractFishTags, relationshipToFishMood } from './fishAudioExpressions.js';
import { inferBondTier } from '../memory/relationshipBond.js';
import type { AppConfig } from '../config/env.js';

function stripForDeliveryAnalysis(text: string) {
  return text
    .replace(/\*([^*]+)\*/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type FishDeliveryMode =
  | 'neutral'
  | 'excited'
  | 'angry'
  | 'sad'
  | 'whisper'
  | 'shout'
  | 'playful'
  | 'sarcastic'
  | 'flirty'
  | 'calm';

export interface FishAudioVoiceVariants {
  shout?: string | undefined;
  whisper?: string | undefined;
  sad?: string | undefined;
  excited?: string | undefined;
  hostile?: string | undefined;
}

export interface FishAudioDeliveryProfile {
  mode: FishDeliveryMode;
  prosodySpeed: number;
  prosodyVolume: number;
  referenceId?: string | undefined;
}

export interface FishAudioDeliveryContext {
  relationship?: string | null | undefined;
  baseSpeed?: number | undefined;
  voiceVariants?: FishAudioVoiceVariants | undefined;
  dynamic?: boolean | undefined;
}

function emptyScores(): Record<FishDeliveryMode, number> {
  return {
    neutral: 0,
    excited: 0,
    angry: 0,
    sad: 0,
    whisper: 0,
    shout: 0,
    playful: 0,
    sarcastic: 0,
    flirty: 0,
    calm: 0
  };
}

function scoreTagContent(tag: string, scores: Record<FishDeliveryMode, number>) {
  if (/shout|scream|yell|loud/.test(tag)) scores.shout += 4;
  if (/whisper|soft tone|breathy/.test(tag)) scores.whisper += 4;
  if (/sob|cry|weep|heartbroken|moved/.test(tag)) scores.sad += 4;
  if (/angry|furious|frustrated|upset|contempt|hostile|rage/.test(tag)) scores.angry += 3;
  if (/excited|delighted|happy|enthusiastic|hysterical/.test(tag)) scores.excited += 3;
  if (/sad|lonely|disappointed|regret|melanch/.test(tag)) scores.sad += 3;
  if (/flirt|teasing|playful|warm tone/.test(tag)) scores.flirty += 2;
  if (/sarcastic|dry|unimpressed|indifferent|cold tone/.test(tag)) scores.sarcastic += 3;
  if (/calm|relaxed|measured|peaceful/.test(tag)) scores.calm += 2;
  if (/laugh|chuckle|giggle/.test(tag)) scores.playful += 2;
  if (/nervous|anxious|uncertain/.test(tag)) scores.whisper += 1;
  if (/in a hurry|rushed|faster pace/.test(tag)) scores.excited += 2;
  if (/speaking slowly|drawn out|measured pace/.test(tag)) scores.calm += 2;
}

function scorePlainText(plain: string, scores: Record<FishDeliveryMode, number>) {
  if (/!{2,}/.test(plain)) scores.excited += 2;
  if (/\b(wow|amazing|incredible|yes+|omg|hell yeah)\b/.test(plain)) scores.excited += 2;
  if (/\b(hate|furious|damn|idiot|shut up|stop it|enough)\b/.test(plain)) scores.angry += 2;
  if (/\b(cry|tears|sob|heartbroken|miss you)\b/.test(plain)) scores.sad += 2;
  if (/\b(hehe|haha|lol|cute|silly)\b/.test(plain)) scores.playful += 1;
  if (/\b(darling|honey|sweetheart|love you)\b/.test(plain)) scores.flirty += 1;
  if (/\b(sure|whatever|fine|okay then)\b/.test(plain) && /\?/.test(plain)) scores.sarcastic += 1;
}

function pickDominantMode(scores: Record<FishDeliveryMode, number>): FishDeliveryMode {
  let best: FishDeliveryMode = 'neutral';
  let bestScore = 0;
  for (const [mode, score] of Object.entries(scores) as Array<[FishDeliveryMode, number]>) {
    if (mode === 'neutral') continue;
    if (score > bestScore) {
      best = mode;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : 'neutral';
}

function prosodyForMode(mode: FishDeliveryMode, baseSpeed: number): { speed: number; volume: number } {
  switch (mode) {
    case 'shout':
      return { speed: baseSpeed * 1.12, volume: 4 };
    case 'excited':
      return { speed: baseSpeed * 1.1, volume: 2 };
    case 'angry':
      return { speed: baseSpeed * 1.08, volume: 3 };
    case 'playful':
      return { speed: baseSpeed * 1.06, volume: 1 };
    case 'flirty':
      return { speed: baseSpeed * 0.96, volume: -1 };
    case 'sarcastic':
      return { speed: baseSpeed * 0.94, volume: 0 };
    case 'whisper':
      return { speed: baseSpeed * 0.9, volume: -4 };
    case 'sad':
      return { speed: baseSpeed * 0.88, volume: -2 };
    case 'calm':
      return { speed: baseSpeed * 0.92, volume: -1 };
    default:
      return { speed: baseSpeed, volume: 0 };
  }
}

function referenceForMode(
  mode: FishDeliveryMode,
  variants: FishAudioVoiceVariants | undefined
): string | undefined {
  if (!variants) return undefined;
  if (mode === 'shout' && variants.shout) return variants.shout;
  if (mode === 'whisper' && variants.whisper) return variants.whisper;
  if (mode === 'sad' && variants.sad) return variants.sad;
  if (mode === 'excited' && variants.excited) return variants.excited;
  if (mode === 'angry' && variants.shout) return variants.shout;
  if (mode === 'playful' && variants.excited) return variants.excited;
  return undefined;
}

export function analyzeFishTtsDelivery(
  ttsText: string,
  context: FishAudioDeliveryContext = {}
): FishAudioDeliveryProfile {
  const baseSpeed = context.baseSpeed ?? 1;
  const tags = extractFishTags(ttsText);
  const plain = stripForDeliveryAnalysis(ttsText);
  const scores = emptyScores();

  for (const tag of tags) {
    scoreTagContent(tag, scores);
  }
  scorePlainText(plain, scores);

  if (!tags.length && context.relationship) {
    for (const moodTag of relationshipToFishMood(context.relationship)) {
      scoreTagContent(moodTag.replace(/^\[|\]$/g, '').toLowerCase(), scores);
    }
  }

  const mode = pickDominantMode(scores);
  if (context.dynamic === false) {
    return { mode: 'neutral', prosodySpeed: baseSpeed, prosodyVolume: 0 };
  }

  const prosody = prosodyForMode(mode, baseSpeed);
  let referenceId = referenceForMode(mode, context.voiceVariants);
  if (inferBondTier(context.relationship) === 'hostile' && context.voiceVariants?.hostile) {
    referenceId = context.voiceVariants.hostile;
  }

  return {
    mode,
    prosodySpeed: Number(prosody.speed.toFixed(3)),
    prosodyVolume: prosody.volume,
    referenceId
  };
}

export function inferDefaultMoodFromReply(text: string, relationship?: string | null): string | undefined {
  const plain = stripForDeliveryAnalysis(text);
  if (!plain.trim()) return undefined;
  if (/\b(sob|cry|tears|heartbroken|devastated)\b/.test(plain)) return '[sad]';
  if (/\b(shut up|furious|hate you|damn it|piss off)\b/.test(plain) || /!{3,}/.test(plain)) {
    return '[angry]';
  }
  if (/\b(wow|amazing|yes+|finally|let's go)\b/.test(plain) || /!{2}/.test(plain)) return '[excited]';
  if (/\b(secret|quiet|don't tell|between us)\b/.test(plain)) return '[whispering]';
  if (/\b(sorry|apologize|my bad)\b/.test(plain)) return '[empathetic]';
  if (relationship) {
    return relationshipToFishMood(relationship)[0];
  }
  return undefined;
}

export function buildFishDeliveryContext(
  config: AppConfig,
  relationship?: string | null
): FishAudioDeliveryContext {
  return {
    relationship,
    baseSpeed: config.FISH_AUDIO_PROSODY_SPEED,
    dynamic: config.fishAudioDynamicVoice,
    voiceVariants: config.fishAudioVoiceVariants
  };
}
