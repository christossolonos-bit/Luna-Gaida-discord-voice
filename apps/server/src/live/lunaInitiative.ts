import type { VoiceCallParticipant } from './liveSession.js';

/** When Luna checks the room: on join, or on a periodic vibe pass. */
export type LunaInitiativeTrigger = 'join' | 'vibe_check';

export interface LunaInitiativeHost {
  isChannelAttached(): boolean;
  isBusy(): boolean;
  getGuildId(): string | null;
  getParticipants(): VoiceCallParticipant[];
}

export const LUNA_INITIATIVE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    vibe: { type: 'string' },
    changeVibe: { type: 'boolean' },
    speak: { type: 'boolean' },
    line: { type: 'string' },
    reason: { type: 'string' }
  },
  required: ['vibe', 'changeVibe', 'speak']
} as const;

export interface LunaInitiativeDecision {
  vibe: string | null;
  changeVibe: boolean;
  speak: boolean;
  line: string | null;
  reason: string | null;
}

export interface LunaInitiativeContextInput {
  personalityInstruction: string;
  guildId: string;
  participants: VoiceCallParticipant[];
  lifeNarrative: string | null;
  memoryRecords: Array<{
    displayName: string;
    summary: string;
    relationship: string;
  }>;
  recentExchanges: string[];
  silenceSec: number;
  useFishTts: boolean;
  fishExpressionBlock: string;
  researchContext?: string;
  conversationTopic?: string;
  trigger: LunaInitiativeTrigger;
}

export function summarizeVibeSignals(input: {
  silenceSec: number;
  recentExchanges: string[];
  participantCount: number;
  trigger: LunaInitiativeTrigger;
}) {
  const lines: string[] = [];
  lines.push(`${input.participantCount} ${input.participantCount === 1 ? 'person' : 'people'} in the call.`);

  if (input.silenceSec < 15) {
    lines.push('Someone spoke very recently — energy is active.');
  } else if (input.silenceSec < 45) {
    lines.push('Brief lull — could be natural pause or fading energy.');
  } else if (input.silenceSec < 120) {
    lines.push('Noticeable quiet — vibe may feel stale, tense, or distracted.');
  } else {
    lines.push('Long silence — awkward, sleepy, or everyone checked out.');
  }

  if (!input.recentExchanges.length) {
    lines.push('Almost no conversation yet this session.');
  } else if (input.recentExchanges.length >= 6) {
    lines.push('Chat has been flowing — read the emotional tone from recent lines.');
  } else {
    lines.push('Light conversation so far — the mood is still forming.');
  }

  if (input.trigger === 'join') {
    lines.push('You are walking into whatever vibe already exists — read it before you act.');
  } else {
    lines.push('The call has been running — decide if the current vibe suits you or needs a nudge.');
  }

  return lines.join(' ');
}

export function buildLunaInitiativePrompt(input: LunaInitiativeContextInput) {
  const roster = input.participants.length
    ? input.participants.map((person) => person.displayName).join(', ')
    : 'the voice channel (no humans detected yet)';

  const vibeSignals = summarizeVibeSignals({
    silenceSec: input.silenceSec,
    recentExchanges: input.recentExchanges,
    participantCount: input.participants.length,
    trigger: input.trigger
  });

  const memoryLines = input.memoryRecords.flatMap((record) => {
    const lines: string[] = [];
    if (record.summary.trim()) {
      lines.push(`${record.displayName} — facts you remember:\n${record.summary}`);
    }
    if (record.relationship.trim()) {
      lines.push(`${record.displayName} — how you feel about them:\n${record.relationship}`);
    }
    return lines;
  });

  const system = [
    input.personalityInstruction,
    'You are Luna in a Discord voice channel. This is a vibe check — read the room, then decide what YOU want to do.',
    'Step 1: Sense the vibe — playful, tense, boring, cozy, chaotic, flirty, awkward, hyped, melancholy, etc. Name it honestly in "vibe".',
    'Step 2: Decide if YOU want to change the vibe. changeVibe=true only when you genuinely want to steer the energy — not because you think you should talk.',
    'Step 3: If changeVibe is false, let the vibe ride — speak=false and empty line. Comfortable silence and a good vibe are fine; do not interrupt.',
    'Step 4: If changeVibe is true, speak=true and say something that shifts energy the way YOU want: lighten tension, break awkward quiet, tease, flirt, energize, soften, pivot topic, or match and amplify if the vibe is good but sleepy.',
    input.trigger === 'join'
      ? 'You just joined. Read the existing vibe first — you may join it, gently shift it, or stay quiet if it already feels right.'
      : 'The call is ongoing. If the subject or energy bores you, changeVibe can be true — tell them and steer somewhere new.',
    'If you change the vibe, ground your line in memory, feelings, your life, or conversation topics below.',
    'Voice lines: 1–2 short sentences, natural speech, under 40 words unless Fish tags are used.',
    'Use *asterisk actions* sparingly; mirror emotion with Fish tags when voice synthesis uses them.',
    input.useFishTts ? input.fishExpressionBlock : '',
    input.lifeNarrative
      ? `Your life right now (draw from this when it fits):\n${input.lifeNarrative}`
      : '',
    input.researchContext?.trim() || '',
    input.conversationTopic?.trim() || '',
    memoryLines.length
      ? `Memory about people in this call:\n${memoryLines.join('\n\n')}`
      : 'You have little stored memory about people here yet — still read the vibe from the signals and recent chat.',
    'Respond in JSON only: { "vibe": "your read of the room", "changeVibe": true|false, "speak": true|false, "line": "words if speaking", "reason": "why you kept or changed the vibe" }.',
    'If changeVibe is false, speak must be false and line empty.'
  ].filter(Boolean).join('\n');

  const userPrompt = [
    `People in voice: ${roster}`,
    `Room signals:\n${vibeSignals}`,
    `Quiet for about ${Math.round(input.silenceSec)} seconds since last speech.`,
    input.recentExchanges.length
      ? `Recent conversation (use this to read the vibe):\n${input.recentExchanges.join('\n')}`
      : 'No conversation in this session yet.',
    input.trigger === 'join'
      ? 'You just entered. Check the vibe and decide whether to join it, shift it, or stay quiet.'
      : 'Check the vibe. Do you want to change it, or let it ride?'
  ].join('\n\n');

  return { system, userPrompt };
}

export function parseLunaInitiativeReply(raw: string): LunaInitiativeDecision | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed) as {
      vibe?: string;
      changeVibe?: boolean;
      speak?: boolean;
      line?: string;
      reason?: string;
    };
    const vibe = data.vibe?.trim() || null;
    const reason = data.reason?.trim() || null;
    const changeVibe = data.changeVibe === true;

    if (!changeVibe) {
      return { vibe, changeVibe: false, speak: false, line: null, reason: reason ?? 'letting the vibe ride' };
    }

    if (!data?.speak) {
      return { vibe, changeVibe: true, speak: false, line: null, reason: reason ?? 'wanted change but stayed quiet' };
    }

    const line = data.line?.trim().replace(/^["']|["']$/g, '') ?? '';
    if (!line || /^silent\.?$/i.test(line)) {
      return { vibe, changeVibe: true, speak: false, line: null, reason: reason ?? 'empty line' };
    }

    return { vibe, changeVibe: true, speak: true, line, reason };
  } catch {
    const line = trimmed.replace(/^["']|["']$/g, '');
    if (!line || /^silent\.?$/i.test(line)) return null;
    return { vibe: null, changeVibe: true, speak: true, line, reason: null };
  }
}

export function pickInitiativeRelationship(
  memoryRecords: Array<{ relationship: string }>
): string | null {
  const ranked = memoryRecords
    .map((record) => record.relationship.trim())
    .filter(Boolean);
  return ranked[0] ?? null;
}
