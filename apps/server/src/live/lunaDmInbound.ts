import type { AppConfig } from '../config/env.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import type { UserVoiceMemoryStore } from '../memory/userVoiceMemory.js';
import type { LunaLifeStore } from '../memory/lunaLifeStore.js';
import type { LunaDmStore } from '../memory/lunaDmStore.js';
import { OllamaTextClient } from '../providers/ollamaText.js';
import { assertDiscordSafe, sanitizeForDiscord } from '../policy/privacy.js';
import { buildResearchContextBlock, buildMessageResearchBlock } from './researchForMessage.js';
import { LunaResearchStore } from '../memory/lunaResearchStore.js';
import type { ConversationResearchContext } from '../research/conversationResearch.js';

export interface LunaInboundDmInput {
  authorId: string;
  username: string;
  displayName: string;
  text: string;
  guildId: string | null;
  recentDmLines: string[];
}

export async function generateLunaInboundDmReply(
  config: AppConfig,
  personality: PersonalityInstructionProvider,
  userVoiceMemory: UserVoiceMemoryStore | undefined,
  lunaLife: LunaLifeStore | undefined,
  lunaDmStore: LunaDmStore | undefined,
  input: LunaInboundDmInput
): Promise<string | null> {
  if (config.GIADA_VOICE_PROVIDER !== 'local') {
    return null;
  }

  const ollama = new OllamaTextClient(config);
  const researchStore = config.lunaResearchEnabled ? new LunaResearchStore(config.databasePath) : null;

  let memoryBlock = '';
  let relationshipBlock = '';
  if (userVoiceMemory && input.guildId) {
    const record = userVoiceMemory.get(input.guildId, input.authorId);
    if (record?.summary?.trim()) {
      memoryBlock = `What you remember about ${input.displayName} from voice:\n${record.summary}`;
    }
    if (record?.relationship?.trim()) {
      relationshipBlock = `How you feel about ${input.displayName}:\n${record.relationship}`;
    }
  }

  let lifeBlock = '';
  if (lunaLife && input.guildId) {
    const narrative = lunaLife.getNarrative(input.guildId);
    if (narrative.trim()) {
      lifeBlock = `Your life journal:\n${narrative}`;
    }
  }

  const researchContext: ConversationResearchContext = {
    recentLines: input.recentDmLines,
    voiceMemorySummary: memoryBlock.replace(/^What you remember about [^:]+:\n/, ''),
    displayName: input.displayName,
    currentMessage: input.text
  };

  const researchBlock = researchStore
    ? [
      buildResearchContextBlock(researchStore),
      await buildMessageResearchBlock(
        config,
        input.text,
        researchStore,
        researchContext,
        {
          userId: input.authorId,
          username: input.username,
          displayName: input.displayName
        }
      )
    ].filter(Boolean).join('\n\n')
    : '';

  const system = [
    personality.buildInstruction('discord', { nsfwAllowed: true }),
    'You are Luna replying in a private Discord DM.',
    `${input.displayName} messaged you directly. Reply as yourself — honest and in character, not like a helpdesk bot.`,
    buildLunaDmConversationRules(input.recentDmLines),
    'When they share a link you read, react naturally — your honest take, what caught your eye, or a question it sparked. Do not just summarize.',
    'When they ask about news, headlines, or current events, discuss those topics directly using your research notes — share specifics and your take; do not invent facts beyond research.',
    'Relationship notes only shape warmth and tone; they never excuse dodging the question they asked.',
    'Keep it concise: usually 1–4 sentences unless they asked for detail.',
    'No asterisk stage directions, no voice tags, no markdown headers.',
    'If you genuinely have nothing to say, reply with exactly [[LUNA_NO_REPLY]].',
    input.recentDmLines.length
      ? `Recent DM history with this person (do not copy phrasing from these lines):\n${input.recentDmLines.join('\n')}`
      : '',
    memoryBlock,
    relationshipBlock,
    lifeBlock,
    researchBlock
  ].filter(Boolean).join('\n');

  const raw = await ollama.generate({
    system,
    userText: `${input.displayName}: ${input.text}`,
    maxCompletionTokens: 280,
    temperature: 0.62
  });

  const visible = sanitizeForDiscord(raw).trim();
  if (!visible || /\[\[LUNA_NO_REPLY\]\]/i.test(visible)) {
    return null;
  }

  const safe = assertDiscordSafe(visible);
  if (!safe.ok || !safe.text.trim()) {
    return null;
  }

  if (lunaDmStore && input.guildId) {
    lunaDmStore.record({
      guildId: input.guildId,
      userId: input.authorId,
      displayName: input.displayName,
      message: safe.text,
      reason: 'inbound reply'
    });
  }

  return safe.text;
}

export function buildLunaDmConversationRules(recentDmLines: string[] = []) {
  const rules = [
    'Answer what they actually asked first. Stay on that topic for the whole reply.',
    'Do not pivot to generic comfort ("I\'m here for you", "what\'s on your mind", "let\'s not let X distract us") unless they asked for emotional support.',
    'If they ask a follow-up on the same topic, go deeper or add a new angle — do not repeat your previous reply with small edits.',
    'Match intimacy to your relationship notes. Do not default to pet names or heavy romance unless that bond is clearly established there.',
    'Be intuitive — notice what they care about from recent chat and memory; connect your answer to those interests when it fits naturally.',
    'Vary your phrasing. Avoid predictable romantic openers and the same closing line every time.'
  ];
  if (recentDmLines.length) {
    rules.push('Recent DM history is in this prompt. Do not reuse its metaphors, openers, or closing lines.');
  }
  return rules.join('\n');
}

export function pickGuildForDmUser(
  userVoiceMemory: UserVoiceMemoryStore | undefined,
  mutualGuildIds: string[],
  userId: string
) {
  if (!mutualGuildIds.length) return null;
  if (!userVoiceMemory) return mutualGuildIds[0] ?? null;

  let bestGuild = mutualGuildIds[0]!;
  let bestScore = -1;
  for (const guildId of mutualGuildIds) {
    const record = userVoiceMemory.get(guildId, userId);
    const score = (record?.summary?.length ?? 0) + (record?.relationship?.length ?? 0);
    if (score > bestScore) {
      bestScore = score;
      bestGuild = guildId;
    }
  }
  return bestGuild;
}
