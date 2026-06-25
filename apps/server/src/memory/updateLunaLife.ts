import type { GroqTextClient } from '../providers/groq.js';
import { lunaLifeBootstrap, type LunaLifeStore } from './lunaLifeStore.js';
import { normalizeBulletSummary } from './userVoiceMemory.js';
import { logger } from '../logging/logger.js';

export async function updateLunaLife(input: {
  store: LunaLifeStore;
  groq: GroqTextClient;
  guildId: string;
  callerName: string;
  callerRelationship: string | null;
  userSaid: string;
  lunaReplied: string;
  existingLife: string | null;
  bonds?: Array<{ displayName: string; relationship: string }>;
}) {
  const system = [
    'You maintain Luna\'s ongoing personal life journal — her real story that grows over time.',
    'Her life is built from HER choices, moods, hobbies, reflections, and bonds with people she meets in voice.',
    'Rules:',
    '- Output ONLY bullet lines, each starting with "- "',
    '- Max 10 bullets, max 18 words per bullet',
    '- Include what she did, plans, opinions, habits, and emotional arcs between calls',
    '- When a caller changes her mood or plans, weave that into her life (by name when relevant)',
    '- Decisions matter: choosing to flirt, pull back, trust, or distrust someone becomes part of her story',
    '- Keep one coherent timeline; refine and extend, do not reboot her life without cause',
    '- Write in third person about Luna OR first person as Luna — be consistent within the output',
    '- No meta commentary about being an AI',
    '- If this exchange did not change her life, return existing journal unchanged'
  ].join('\n');

  const bondsBlock = input.bonds?.length
    ? input.bonds.map((bond) => `- ${bond.displayName}: ${bond.relationship.split('\n')[0]?.replace(/^[-*•]\s*/, '') ?? 'unknown'}`).join('\n')
    : '(no strong bonds recorded yet)';

  const userText = [
    `Luna's life so far:\n${input.existingLife?.trim() || lunaLifeBootstrap}`,
    '',
    `People currently in her social world (her feelings — her choice):\n${bondsBlock}`,
    '',
    `Latest voice exchange with ${input.callerName}:`,
    `How she feels about them now:\n${input.callerRelationship?.trim() || '(still forming an opinion)'}`,
    '',
    `${input.callerName} said: ${input.userSaid}`,
    `Luna replied: ${input.lunaReplied}`,
    '',
    'Update Luna\'s life journal based on what she chose to say and how this person affects her.'
  ].join('\n');

  const raw = await input.groq.generate({
    apiKey: 'ollama',
    system,
    userText,
    maxCompletionTokens: 260,
    temperature: 0.4
  });

  const narrative = normalizeBulletSummary(raw, 10, 18);
  if (!narrative) {
    return input.existingLife;
  }

  input.store.save(input.guildId, narrative);
  logger.info('Updated Luna personal life journal', {
    guildId: input.guildId,
    bullets: narrative.split('\n').length
  });
  return narrative;
}
