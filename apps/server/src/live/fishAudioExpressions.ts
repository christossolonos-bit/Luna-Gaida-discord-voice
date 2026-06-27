/** Fish Audio S2 bracket cues — passed to the LLM; tags steer delivery, not spoken aloud. */

import { inferBondTier } from '../memory/relationshipBond.js';

export const FISH_AUDIO_EXPRESSION_PROMPT = [
  'Fish Audio S2 voice direction — your reply is synthesized with rich emotional control. Use [square bracket] tags liberally.',
  'Tags are NOT read aloud. They control pitch, pace, tone, breath, and emotion at that moment in the line.',
  '',
  'RULES:',
  '- Up to 3 tags per sentence; combine emotion + tone + effect (e.g. [flirty][soft tone][chuckling]).',
  '- Sentence emotions: place tags at the START of each sentence.',
  '- Word-level control: place tags IMMEDIATELY BEFORE the word or phrase they affect.',
  '  Example: "I [whispering] did not expect that" or "That is [very excited] amazing!"',
  '- Vary pitch and pace across sentences — do not use one flat mood for the whole reply.',
  '- Match tags to how YOU feel about this caller, your relationship, and your life — never generic cheer.',
  '- Use *asterisk actions* for avatar motion; ALSO mirror the feeling with Fish tags in the spoken line.',
  '',
  'BASIC EMOTIONS: [happy] [sad] [angry] [excited] [calm] [nervous] [confident] [surprised] [curious] [sarcastic]',
  '  [bored] [flirty] [empathetic] [grateful] [frustrated] [disappointed] [hopeful] [nostalgic] [lonely]',
  '  [indifferent] [disdainful] [relaxed] [proud] [embarrassed] [jealous] [determined] [moved] [delighted] [upset]',
  '',
  'ADVANCED: [anxious] [uncertain] [confused] [regretful] [compassionate] [contemptuous] [sympathetic]',
  '  [optimistic] [pessimistic] [guilty] [ashamed] [envious] [hysterical] [resigned]',
  '  Intensity: [slightly sad] [very excited] [extremely angry] [warm and happy] [dry and unimpressed]',
  '',
  'TONE / VOLUME: [whispering] [soft tone] [shouting] [screaming] [in a hurry tone]',
  '  [warm tone] [cold tone] [breathy] [playful tone] [teasing tone] [serious tone]',
  '',
  'PITCH & PACE (natural language — S2 understands these):',
  '  [slightly higher pitch] [lower pitch] [deeper voice] [pitch up] [speaking slowly] [faster pace]',
  '  [drawn out] [rushed] [measured pace] [sing-song tone]',
  '',
  'SOUND EFFECTS (anywhere): [laughing] [chuckling] [sighing] [gasping] [groaning] [panting] [yawning]',
  '  [sobbing] [crying loudly] [clearing throat]',
  'PAUSES: [break] [long-break]',
  'SPECIAL: [audience laughing] [background laughter]',
  '',
  'EMOTION ARCS across sentences (example):',
  '[curious] What do you mean by that?',
  '[uncertain][soft tone] I am not sure I like where this is going.',
  '[flirty][slightly higher pitch] Unless you are asking nicely.',
  '',
  'Free-form tags work: [laughing nervously] [warm whisper] [cool and distant] [playfully annoyed]',
  'Write spoken words after tags. Never explain the tags.'
].join('\n');

export interface FishTtsEnrichContext {
  relationship?: string | null | undefined;
  actions?: string[];
  defaultMood?: string;
}

const SENTENCE_END = /(?<=[.!?…])\s+/;
const LEADING_TAGS = /^\s*((?:\[[^\]]+\]\s*)+)/;

export function stripFishAudioTagsForDisplay(text: string) {
  return text
    .replace(/\[[^\]]+\]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAction(action: string) {
  return action.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function mapActionToFishTags(action: string): string[] {
  const key = normalizeAction(action);
  if (!key) return [];

  const tags: string[] = [];
  const push = (...items: string[]) => {
    for (const item of items) {
      if (tags.length < 3) tags.push(item);
    }
  };

  if (/\blaugh|\bgiggle|\bchuckle|\bha ha|\bhaha|\bgrin/.test(key)) push('[laughing]');
  else if (/\bsigh/.test(key)) push('[sighing]');
  else if (/\bgasp/.test(key)) push('[gasping]');
  else if (/\bgroan|\bmoan|\bugh/.test(key)) push('[groaning]');
  else if (/\byawn/.test(key)) push('[yawning]');
  else if (/\bsob|\bcry/.test(key)) push('[sad]', '[sobbing]');
  else if (/\bwhisper/.test(key)) push('[whispering]', '[soft tone]');
  else if (/\bshout|\byell|\bscream/.test(key)) push('[shouting]');
  else if (/\bblush|\bshy|\bembarrass/.test(key)) push('[embarrassed]', '[soft tone]');
  else if (/\bwink|\bflirt|\btease|\bsmirk/.test(key)) push('[flirty]', '[playful tone]');
  else if (/\bglare|\bscowl/.test(key)) push('[angry]', '[cold tone]');
  else if (/\bfrown|\bsad/.test(key)) push('[sad]');
  else if (/\bperk|\bbounce|\btail|\bear|\bexcit/.test(key)) push('[excited]', '[slightly higher pitch]');
  else if (/\blean/.test(key)) push('[curious]', '[soft tone]');
  else if (/\bthink|\bponder/.test(key)) push('[calm]', '[measured pace]');
  else if (/\bannoy|\broll/.test(key)) push('[sarcastic]', '[sighing]');
  else if (/\bnod/.test(key)) push('[confident]');
  else if (/\bshrug/.test(key)) push('[indifferent]');
  else if (/\bpurr/.test(key)) push('[relaxed]', '[breathy]', '[soft tone]');
  else {
    const freeForm = action.replace(/\*+/g, '').trim().slice(0, 48);
    if (freeForm) push(`[${freeForm}]`);
  }

  return tags;
}

export function mapActionToFishTag(action: string): string | null {
  return mapActionToFishTags(action)[0] ?? null;
}

export function relationshipToFishMood(relationship: string | null | undefined): string[] {
  const tier = inferBondTier(relationship);
  if (tier === 'hostile') return ['[angry]', '[sarcastic]', '[cold tone]'];
  if (tier === 'annoyed') return ['[frustrated]', '[sarcastic]', '[dry and unimpressed]'];
  if (tier === 'cool') return ['[indifferent]', '[cold tone]'];
  if (tier === 'stranger' || tier === 'acquaintance') return ['[calm]', '[curious]'];
  if (tier === 'warming') return ['[warm tone]', '[playful tone]'];
  if (tier === 'bonded' || tier === 'romantic') return ['[flirty]', '[warm tone]'];
  return ['[calm]', '[curious]'];
}

function inferTagsForSentence(sentence: string, moodTags: string[]): string[] {
  if (LEADING_TAGS.test(sentence)) return [];

  const tags = [...moodTags];
  const lower = sentence.toLowerCase();

  if (/\?/.test(sentence) && !tags.some((t) => /curious|uncertain/i.test(t))) {
    tags.push('[curious]');
  }
  if (/!/.test(sentence) && !tags.some((t) => /excited|happy|angry/i.test(t))) {
    tags.push('[excited]');
  }
  if (/\b(sorry|apolog)\b/.test(lower)) tags.push('[empathetic]', '[soft tone]');
  if (/\b(love|darling|honey|sweetheart)\b/.test(lower)) tags.push('[warm tone]');
  if (/\b(no|never|stop|ugh)\b/.test(lower)) tags.push('[frustrated]');
  if (/\b(haha|lol|funny)\b/.test(lower)) tags.push('[chuckling]');
  if (/\b(wait|hold on|hang on)\b/.test(lower)) tags.push('[surprised]');
  if (/\b(maybe|perhaps|i guess)\b/.test(lower)) tags.push('[uncertain]');

  return [...new Set(tags)].slice(0, 3);
}

function prependTags(sentence: string, tags: string[]) {
  if (!tags.length) return sentence.trim();
  return `${tags.join('')} ${sentence.trim()}`;
}

export function enrichFishTtsText(text: string, context: FishTtsEnrichContext = {}) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';

  let working = trimmed;
  for (const action of context.actions ?? []) {
    const tags = mapActionToFishTags(action);
    if (tags.length && !working.includes(tags[0]!)) {
      working = `${tags.join('')} ${working}`;
    }
  }

  const moodTags = relationshipToFishMood(context.relationship);
  const defaultMood = context.defaultMood ? [context.defaultMood] : moodTags.slice(0, 1);

  const parts = working.split(SENTENCE_END).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return prependTags(working, defaultMood);

  return parts.map((sentence, index) => {
    const mood = index === 0 ? defaultMood : moodTags.slice(0, 1);
    const extra = inferTagsForSentence(sentence, mood);
    if (LEADING_TAGS.test(sentence)) return sentence;
    const tags = extra.length ? extra : (index === 0 ? defaultMood : []);
    return prependTags(sentence, tags);
  }).join(' ');
}

export function prepareFishTtsText(ttsText: string, context: FishTtsEnrichContext = {}) {
  return enrichFishTtsText(ttsText, context);
}
