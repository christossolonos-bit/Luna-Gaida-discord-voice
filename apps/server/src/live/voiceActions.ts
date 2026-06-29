import {
  stripFishAudioTagsForDisplay,
  mapActionToFishTags,
  prepareFishTtsText,
  type FishTtsEnrichContext
} from './fishAudioExpressions.js';
import { inferDefaultMoodFromReply } from './fishAudioDelivery.js';

const ASTERISK_ACTION = /\*([^*]+)\*/g;
const SPOKEN_ASTERISK_ACTION = /\basterisks?\s+([^,.!?;]+?)\s+asterisks?\b/gi;
const ITALIC_ACTION = /_([^_]+)_/g;

/** Remove roleplay stage directions so TTS never reads "*" or "asterisk". */
export function stripRoleplayMarkupForSpeech(text: string) {
  return text
    .replace(ASTERISK_ACTION, ' ')
    .replace(SPOKEN_ASTERISK_ACTION, ' ')
    .replace(ITALIC_ACTION, ' ')
    .replace(/\*+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractRoleplayActions(text: string) {
  const actions: string[] = [];
  for (const pattern of [ASTERISK_ACTION, SPOKEN_ASTERISK_ACTION, ITALIC_ACTION]) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const action = match[1]?.trim();
      if (action) actions.push(action);
    }
  }
  return actions;
}

export { mapActionToFishTag, mapActionToFishTags } from './fishAudioExpressions.js';

/** Convert LLM reply to Fish TTS input with tags; display text stays clean for UI. */
export function buildFishTtsFromReply(text: string, context: FishTtsEnrichContext = {}) {
  const actions: string[] = [];
  const ttsWithActions = stripRoleplayMarkupForSpeech(
    text.replace(ASTERISK_ACTION, (_, action: string) => {
      const trimmed = action.trim();
      if (trimmed) actions.push(trimmed);
      const tags = mapActionToFishTags(trimmed);
      return tags.length ? `${tags.join('')} ` : ' ';
    })
  );

  const ttsText = prepareFishTtsText(ttsWithActions, {
    ...context,
    actions,
    defaultMood: context.defaultMood ?? inferDefaultMoodFromReply(text, context.relationship)
  });
  const displayText = stripFishAudioTagsForDisplay(stripRoleplayMarkupForSpeech(text));

  return { ttsText, displayText, actions };
}

export function mapActionToExpression(action: string): string | null {
  const native = mapActionToTuziAnheiExpressions(action);
  if (native.length) return native[0]!;

  const key = action.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key) return null;
  if (/\blaugh|\bgiggle|\bchuckle|\bsmile|\bgrin/.test(key)) return 'happy';
  if (/\bsigh|\bsad|\bcry|\bsob|\bfrown/.test(key)) return 'sad';
  if (/\bangry|\bglare|\bscowl/.test(key)) return 'angry';
  if (/\bsurprise|\bgasp|\bshock/.test(key)) return 'surprised';
  if (/\bblush|\bshy|\bembarrass/.test(key)) return 'shy';
  if (/\bwink|\bflirt|\btease/.test(key)) return 'happy';
  if (/\bear|\btail|\bperk|\bthump|\bbounce/.test(key)) return 'happy';
  return null;
}

function mapActionToTuziAnheiExpressions(action: string): string[] {
  const key = action.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key) return [];

  if (/\blaugh|\bgiggle|\bchuckle|\bsmile|\bgrin/.test(key)) return ['lianhong'];
  if (/\bsigh|\bsad|\bcry|\bsob|\bfrown|\btear/.test(key)) return ['liulei'];
  if (/\bangry|\bglare|\bscowl|\bfurious/.test(key)) return ['heilian'];
  if (/\bsurprise|\bgasp|\bshock/.test(key)) return ['yihuo'];
  if (/\bblush|\bshy|\bembarrass/.test(key)) return ['lianhong'];
  if (/\bconfus|\bpuzzle|\bhuh/.test(key)) return ['yihuo'];
  if (/\bsweat|\bnervous|\banxious/.test(key)) return ['hanzhu'];
  if (/\bbreak|\bmeltdown|\bsnap/.test(key)) return ['benghuai'];
  if (/\bheart|\blove|\badore/.test(key)) return ['aixin'];
  if (/\bstar|\bsparkle|\bshine/.test(key)) return ['xingxing'];
  if (/\bblood|\bcreepy|\bscary/.test(key)) return ['xueji'];
  if (/\bear|\btail|\bperk|\bbounce/.test(key)) return ['xingxing'];

  return [];
}

export function shouldReactWithMotion(action: string) {
  const key = action.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return /\blaugh|\bgiggle|\bchuckle|\bear|\btail|\bperk|\bthump|\bbounce|\bwave|\bnod/.test(key);
}

export function applyVoiceActionsToReply(
  text: string,
  options: { fishTts: boolean; relationship?: string | null }
) {
  if (options.fishTts) {
    return buildFishTtsFromReply(text, { relationship: options.relationship });
  }

  const actions = extractRoleplayActions(text);
  const ttsText = stripRoleplayMarkupForSpeech(text);
  const displayText = stripRoleplayMarkupForSpeech(text);
  return { ttsText, displayText, actions };
}
