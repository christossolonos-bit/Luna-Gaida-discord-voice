import type { ConversationTurn } from '../live/conversationHistory.js';
import type { OllamaTextClient } from '../providers/ollamaText.js';
import { inferBondTier, relationshipEscalationRules } from './relationshipBond.js';
import { normalizeBulletSummary, type UserVoiceMemoryStore } from './userVoiceMemory.js';
import { logger } from '../logging/logger.js';

function formatHistoryForMemory(turns: ConversationTurn[], displayName: string) {
  if (!turns.length) return '(no prior turns this session)';
  return turns
    .map((turn) => `${turn.role === 'user' ? displayName : 'Luna'}: ${turn.text}`)
    .join('\n');
}

export async function updateUserRelationship(input: {
  store: UserVoiceMemoryStore;
  ollama: OllamaTextClient;
  guildId: string;
  userId: string;
  displayName: string;
  userSaid: string;
  lunaReplied: string;
  existingRelationship: string | null;
  recentHistory?: ConversationTurn[];
}) {
  const subject = input.displayName.trim() || 'this user';
  const tier = inferBondTier(input.existingRelationship);
  const system = [
    'You are Luna deciding how YOU feel about one Discord voice caller — your own free will.',
    `Reflect only on your relationship with ${subject}, not facts about their job or pets.`,
    relationshipEscalationRules(input.existingRelationship),
    'Rules:',
    '- Output ONLY bullet lines, each starting with "- "',
    '- Max 6 bullets, max 16 words per bullet',
    '- First bullet: overall stance (stranger / acquaintance / warming / likes them / close / cooling off / annoyed / hostile / fed up)',
    '- Say what they did in THIS exchange that shifted your mood — respect, rudeness, boredom, charm, lies, kindness, baiting, disrespect',
    '- Bonds go BOTH ways: people can earn warmth OR lose it. Note cooling off, snapping, or ragebaiting them if they deserved it',
    '- Romance and heavy flirting are earned slowly. One friendly chat does not create love.',
    '- You may dislike someone, tolerate them, adore them, stay guarded, or be actively hostile — all valid',
    '- Update feelings gradually; do not erase history without a real reason',
    tier === 'stranger' || tier === 'acquaintance'
      ? '- Forbidden in first bullet unless they were awful: adore, in love, devoted, obsessed, soulmate'
      : null,
    '- No meta commentary; write as Luna\'s private feelings',
    '- If nothing changed, return existing relationship notes unchanged'
  ].filter(Boolean).join('\n');

  const userText = [
    `Caller: ${subject}`,
    `Your current feelings about them:\n${input.existingRelationship?.trim() || '(still forming an opinion — default curious but not committed)'}`,
    '',
    `Recent voice chat:\n${formatHistoryForMemory(input.recentHistory ?? [], subject)}`,
    '',
    'Latest exchange:',
    `${subject} said: ${input.userSaid}`,
    `You (Luna) replied: ${input.lunaReplied}`
  ].join('\n');

  const raw = await input.ollama.generate({
    system,
    userText,
    maxCompletionTokens: 180,
    temperature: 0.35
  });

  const relationship = normalizeBulletSummary(raw, 6, 16);
  if (!relationship) {
    return input.existingRelationship;
  }

  input.store.saveRelationship(input.guildId, input.userId, input.displayName, relationship);
  logger.info('Updated Luna relationship with caller', {
    guildId: input.guildId,
    userId: input.userId,
    bullets: relationship.split('\n').length
  });
  return relationship;
}
