import type { ConversationHistory } from './conversationHistory.js';
import type { VoiceSpeakerContext } from './liveSession.js';

export function recordParticipantNames(
  names: Map<string, string>,
  speaker: VoiceSpeakerContext
) {
  const key = speakerKey(speaker.guildId, speaker.userId);
  names.set(key, speaker.displayName);
  for (const other of speaker.othersInCall ?? []) {
    names.set(speakerKey(speaker.guildId, other.userId), other.displayName);
  }
}

export function buildVoiceCallContextBlock(input: {
  speaker: VoiceSpeakerContext;
  conversationBySpeaker: Map<string, ConversationHistory>;
  participantNames: Map<string, string>;
  otherMemoryNotes?: string[];
}): string {
  const { speaker, conversationBySpeaker, participantNames, otherMemoryNotes } = input;
  const currentKey = speakerKey(speaker.guildId, speaker.userId);
  const others = speaker.othersInCall ?? [];

  const rosterNames = others.map((person) => person.displayName);
  const rosterLine = rosterNames.length
    ? rosterNames.join(', ')
    : 'no other humans detected in the channel';

  const exchangeLines = buildOtherExchangeLines({
    speaker,
    currentKey,
    others,
    conversationBySpeaker,
    participantNames
  });

  const memoryBlock = otherMemoryNotes?.length
    ? `\nPast notes about others in this call (from earlier sessions — NOT facts about ${speaker.displayName}):\n${otherMemoryNotes.join('\n')}`
    : '';

  return [
    '\nVoice call context:',
    `People in this call besides ${speaker.displayName}: ${rosterLine}`,
    `Current speaker: ${speaker.displayName}`,
    '',
    'What others in this call have said to Luna this session (use this when someone asks what another person said):',
    exchangeLines.length ? exchangeLines.join('\n') : '(no one else has spoken to Luna yet this session)',
    memoryBlock
  ].join('\n');
}

/** Narrow call log for per-user memory updates — no other users' saved bullets. */
export function buildVoiceCallContextForMemory(input: {
  speaker: VoiceSpeakerContext;
  conversationBySpeaker: Map<string, ConversationHistory>;
  participantNames: Map<string, string>;
}): string {
  const currentKey = speakerKey(input.speaker.guildId, input.speaker.userId);
  const exchangeLines = buildOtherExchangeLines({
    speaker: input.speaker,
    currentKey,
    others: input.speaker.othersInCall ?? [],
    conversationBySpeaker: input.conversationBySpeaker,
    participantNames: input.participantNames
  });

  if (!exchangeLines.length) {
    return '(no other participants spoke this session)';
  }

  return [
    `Reference only — these lines are what OTHER people said, not ${input.speaker.displayName}:`,
    exchangeLines.join('\n')
  ].join('\n');
}

function buildOtherExchangeLines(input: {
  speaker: VoiceSpeakerContext;
  currentKey: string;
  others: Array<{ userId: string; displayName: string }>;
  conversationBySpeaker: Map<string, ConversationHistory>;
  participantNames: Map<string, string>;
}) {
  const exchangeLines: string[] = [];
  for (const [key, history] of input.conversationBySpeaker) {
    if (key === input.currentKey) continue;
    const name = input.participantNames.get(key) ?? 'Someone';
    const turns = history.snapshot();
    if (!turns.length) continue;
    const recent = turns.slice(-4);
    const parts = recent.map((turn) =>
      turn.role === 'user' ? `said "${turn.text}"` : `Luna replied "${turn.text}"`
    );
    exchangeLines.push(`- ${name}: ${parts.join('; ')}`);
  }

  for (const other of input.others) {
    const key = speakerKey(input.speaker.guildId, other.userId);
    if (input.conversationBySpeaker.has(key)) continue;
    exchangeLines.push(`- ${other.displayName}: in the call but has not spoken to Luna yet this session`);
  }

  return exchangeLines;
}

function speakerKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}
