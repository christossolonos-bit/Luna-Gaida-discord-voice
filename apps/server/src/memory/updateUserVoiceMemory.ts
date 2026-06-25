import type { ConversationTurn } from '../live/conversationHistory.js';
import type { GroqTextClient } from '../providers/groq.js';
import { normalizeBulletSummary, type UserVoiceMemoryStore } from './userVoiceMemory.js';
import { logger } from '../logging/logger.js';

function formatHistoryForMemory(turns: ConversationTurn[]) {
  if (!turns.length) return '(no prior turns this session)';
  return turns
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Luna'}: ${turn.text}`)
    .join('\n');
}

export async function updateUserVoiceMemory(input: {
  store: UserVoiceMemoryStore;
  groq: GroqTextClient;
  guildId: string;
  userId: string;
  displayName: string;
  userSaid: string;
  lunaReplied: string;
  existingSummary: string | null;
  recentHistory?: ConversationTurn[];
  callContext?: string | null;
}) {
  const system = [
    'You maintain short bullet notes about a Discord voice user for an assistant named Luna.',
    'Learn from the user over time — merge new stable facts from recent chat history and the latest exchange.',
    'Rules:',
    '- Output ONLY bullet lines, each starting with "- "',
    '- Max 8 bullets, max 14 words per bullet',
    '- Keep name, preferences, recurring topics, relationship cues, ongoing threads',
    '- Note when this user asks about other people in the voice call or mentions them by name',
    '- Refine bullets as you learn more; drop stale or duplicate bullets',
    '- No speculation, no meta commentary, no quotes from Luna',
    '- If nothing new to remember, return the existing notes unchanged'
  ].join('\n');

  const userText = [
    `Speaker display name: ${input.displayName}`,
    `Saved notes from past sessions:\n${input.existingSummary?.trim() || '(none yet)'}`,
    '',
    `Shared voice call context (other participants in this session):\n${input.callContext?.trim() || '(none)'}`,
    '',
    `Recent voice chat this session:\n${formatHistoryForMemory(input.recentHistory ?? [])}`,
    '',
    `Latest exchange:`,
    `User said: ${input.userSaid}`,
    `Luna replied: ${input.lunaReplied}`
  ].join('\n');

  const raw = await input.groq.generate({
    apiKey: 'ollama',
    system,
    userText,
    maxCompletionTokens: 220,
    temperature: 0.2
  });

  const summary = normalizeBulletSummary(raw);
  if (!summary) {
    return input.existingSummary;
  }

  input.store.save(input.guildId, input.userId, input.displayName, summary);
  logger.info('Updated Luna voice user memory', {
    guildId: input.guildId,
    userId: input.userId,
    bullets: summary.split('\n').length,
    historyTurns: input.recentHistory?.length ?? 0
  });
  return summary;
}
