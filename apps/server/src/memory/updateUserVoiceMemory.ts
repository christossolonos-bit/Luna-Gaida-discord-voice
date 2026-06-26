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

export async function updateUserVoiceMemory(input: {
  store: UserVoiceMemoryStore;
  ollama: OllamaTextClient;
  guildId: string;
  userId: string;
  displayName: string;
  userSaid: string;
  lunaReplied: string;
  existingSummary: string | null;
  recentHistory?: ConversationTurn[];
  callContext?: string | null;
}) {
  const subject = input.displayName.trim() || 'this user';
  const system = [
    `You maintain short bullet notes about ONE Discord voice user: ${subject}.`,
    'Learn only from what THAT person said about themselves, their preferences, and their questions.',
    'Rules:',
    '- Output ONLY bullet lines, each starting with "- "',
    '- Max 8 bullets, max 14 words per bullet',
    `- Every bullet must be about ${subject} only — never about someone else in the call`,
    `- Do NOT copy another caller's job, pets, location, hobbies, or traits onto ${subject}`,
    `- If ${subject} asks about another person, save meta bullets like "${subject} asked about Travis's dog" — not "owns Travis's dog"`,
    '- Refine bullets as you learn more; drop stale, duplicate, or wrongly attributed bullets',
    '- No speculation, no meta commentary, no quotes from Luna',
    '- If nothing new to remember about this person, return the existing notes unchanged'
  ].join('\n');

  const userText = [
    `Subject (the ONLY person these notes describe): ${subject}`,
    `Saved notes from past sessions:\n${input.existingSummary?.trim() || '(none yet)'}`,
    '',
    `Other participants this session (reference only — do NOT save their facts under ${subject}):\n${input.callContext?.trim() || '(none)'}`,
    '',
    `Recent voice chat with ${subject} this session:\n${formatHistoryForMemory(input.recentHistory ?? [], subject)}`,
    '',
    'Latest exchange with this subject only:',
    `${subject} said: ${input.userSaid}`,
    `Luna replied: ${input.lunaReplied}`
  ].join('\n');

  const raw = await input.ollama.generate({
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
