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

  const exchangeLines: string[] = [];
  for (const [key, history] of conversationBySpeaker) {
    if (key === currentKey) continue;
    const name = participantNames.get(key) ?? 'Someone';
    const turns = history.snapshot();
    if (!turns.length) continue;
    const recent = turns.slice(-4);
    const parts = recent.map((turn) =>
      turn.role === 'user' ? `said "${turn.text}"` : `Luna replied "${turn.text}"`
    );
    exchangeLines.push(`- ${name}: ${parts.join('; ')}`);
  }

  for (const other of others) {
    const key = speakerKey(speaker.guildId, other.userId);
    if (conversationBySpeaker.has(key)) continue;
    exchangeLines.push(`- ${other.displayName}: in the call but has not spoken to Luna yet this session`);
  }

  const memoryBlock = otherMemoryNotes?.length
    ? `\nPast notes about others in this call (from earlier sessions):\n${otherMemoryNotes.join('\n')}`
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

function speakerKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}
