import { stripFishAudioTagsForDisplay } from './fishAudioExpressions.js';

const ASTERISK_ACTION = /\*([^*]+)\*/g;
const SPOKEN_ASTERISK_ACTION = /\basterisks?\s+([^,.!?;]+?)\s+asterisks?\b/gi;
const ITALIC_ACTION = /_([^_]+)_/g;

function normalizeAction(action: string) {
  return action.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

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

export function mapActionToFishTag(action: string): string | null {
  const key = normalizeAction(action);
  if (!key) return null;
  if (/\blaugh|\bgiggle|\bchuckle|\bha ha|\bhaha/.test(key)) return '[laughing]';
  if (/\bsigh/.test(key)) return '[sighing]';
  if (/\bgasp/.test(key)) return '[gasping]';
  if (/\bgroan|\bmoan/.test(key)) return '[groaning]';
  if (/\byawn/.test(key)) return '[yawning]';
  if (/\bwhisper/.test(key)) return '[whispering]';
  if (/\bshout|\byell/.test(key)) return '[shouting]';
  if (/\bcry|\bsob/.test(key)) return '[sad]';
  return null;
}

export function mapActionToExpression(action: string): string | null {
  const key = normalizeAction(action);
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

export function shouldReactWithMotion(action: string) {
  const key = normalizeAction(action);
  return /\blaugh|\bgiggle|\bchuckle|\bear|\btail|\bperk|\bthump|\bbounce|\bwave|\bnod/.test(key);
}

export function applyVoiceActionsToReply(text: string, options: { fishTts: boolean }) {
  const actions = extractRoleplayActions(text);

  const ttsText = stripRoleplayMarkupForSpeech(
    text.replace(ASTERISK_ACTION, (_, action: string) => {
      const trimmed = action.trim();
      if (options.fishTts) {
        const tag = mapActionToFishTag(trimmed);
        return tag ? `${tag} ` : ' ';
      }
      return ' ';
    }).replace(SPOKEN_ASTERISK_ACTION, ' ').replace(ITALIC_ACTION, ' ')
  );

  const displayText = stripFishAudioTagsForDisplay(stripRoleplayMarkupForSpeech(text));

  return { ttsText, displayText, actions };
}
