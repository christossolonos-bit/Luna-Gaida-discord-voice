export const LUNA_DM_JSON_SCHEMA = {
  type: 'object',
  properties: {
    send: { type: 'boolean' },
    userId: { type: 'string' },
    message: { type: 'string' },
    reason: { type: 'string' }
  },
  required: ['send']
} as const;

export interface LunaDmCandidate {
  userId: string;
  displayName: string;
  guildId: string;
  summary: string;
  relationship: string;
  hoursSinceLastDm: number | null;
  inVoiceWithLuna: boolean;
}

export interface LunaDmPromptInput {
  personalityInstruction: string;
  candidates: LunaDmCandidate[];
  lifeByGuild: Array<{ guildId: string; narrative: string }>;
  recentDmLines: string[];
}

export function buildLunaDmPrompt(input: LunaDmPromptInput) {
  const candidateBlocks = input.candidates.map((person) => {
    const lines = [
      `userId: ${person.userId}`,
      `name: ${person.displayName}`,
      `shared server id: ${person.guildId}`,
      person.inVoiceWithLuna ? 'currently in voice with you' : 'not in your voice channel right now',
      person.hoursSinceLastDm != null
        ? `last DM you sent them: ${person.hoursSinceLastDm.toFixed(1)} hours ago`
        : 'you have never DMed them before',
      person.summary.trim() ? `facts you remember:\n${person.summary}` : '',
      person.relationship.trim() ? `how you feel about them:\n${person.relationship}` : ''
    ].filter(Boolean);
    return lines.join('\n');
  });

  const lifeBlocks = input.lifeByGuild
    .filter((entry) => entry.narrative.trim())
    .map((entry) => `Guild ${entry.guildId} — your life:\n${entry.narrative}`);

  const system = [
    input.personalityInstruction,
    'You are Luna on Discord. You may send a private DM to someone you share a server with — only if YOU genuinely want to.',
    'This is autonomous outreach. Most of the time you should NOT send anything.',
    'Send a DM only when you have something personal to say or ask — grounded in memory, your feelings, or your life journal.',
    'Good reasons: following up on something they told you, a thought you had about them, missing them, teasing someone you like, a question you actually care about.',
    'Bad reasons: generic check-ins, assistant behavior, spam, guilt, or inventing facts not in memory.',
    'Pick at most ONE person from the candidate list. Their userId must be copied exactly from the list.',
    'DM text: 1–3 short sentences, casual, under 400 characters. No markdown, no asterisk actions, no voice tags.',
    lifeBlocks.length ? lifeBlocks.join('\n\n') : '',
    input.recentDmLines.length
      ? `Recent DMs you already sent (do not repeat the same topic):\n${input.recentDmLines.join('\n')}`
      : '',
    'Respond in JSON only: { "send": true|false, "userId": "discord id or empty", "message": "dm text", "reason": "private note" }.',
    'If send is false, userId and message must be empty.'
  ].filter(Boolean).join('\n');

  const userPrompt = [
    'People you may DM (mutual servers, you have memory about them):',
    candidateBlocks.length ? candidateBlocks.join('\n\n---\n\n') : '(no eligible candidates)',
    'Decide whether to send one DM. Use only facts from memory above.'
  ].join('\n\n');

  return { system, userPrompt };
}

export function parseLunaDmReply(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed) as {
      send?: boolean;
      userId?: string;
      message?: string;
      reason?: string;
    };
    if (!data?.send) {
      return { send: false as const, userId: null, message: null, reason: data?.reason?.trim() || null };
    }
    const userId = data.userId?.trim() ?? '';
    const message = data.message?.trim().replace(/^["']|["']$/g, '') ?? '';
    if (!userId || !message || /^silent\.?$/i.test(message)) {
      return { send: false as const, userId: null, message: null, reason: data?.reason?.trim() || 'invalid dm' };
    }
    return {
      send: true as const,
      userId,
      message,
      reason: data?.reason?.trim() || null
    };
  } catch {
    return null;
  }
}
