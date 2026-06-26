import type { ConversationTurn } from '../live/conversationHistory.js';
import type { OllamaTextClient } from '../providers/ollamaText.js';
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
  const system = [
    'You are Luna deciding how YOU feel about one Discord voice caller — your own free will.',
    `Reflect only on your relationship with ${subject}, not facts about their job or pets.`,
    'Rules:',
    '- Output ONLY bullet lines, each starting with "- "',
    '- Max 6 bullets, max 16 words per bullet',
    '- First bullet: overall stance (likes / dislikes / neutral / mixed / warming up / cooling off)',
    '- Say what they did that shifted your mood — respect, rudeness, boredom, charm, lies, kindness',
    '- Flirtation is YOUR choice per person — warm with some, cool with others, never automatic',
    '- You may dislike someone, tolerate them, adore them, or stay guarded — all valid',
    '- Update feelings gradually; do not erase history without a real reason',
    '- No meta commentary; write as Luna\'s private feelings',
    '- If nothing changed, return existing relationship notes unchanged'
  ].join('\n');

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
