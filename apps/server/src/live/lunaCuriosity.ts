import type { LunaResearchMode } from '../research/lunaResearchRunner.js';
import { formatInterestBrowseHint, INTEREST_BROWSE_CATEGORIES } from '../research/interestBrowse.js';

export const LUNA_CURIOSITY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    explore: { type: 'boolean' },
    mode: { type: 'string' },
    query: { type: 'string' },
    url: { type: 'string' },
    reason: { type: 'string' }
  },
  required: ['explore']
} as const;

export function buildLunaCuriosityPrompt(input: {
  personalityInstruction: string;
  recentResearchLines: string[];
  recentConversationLines: string[];
  plannedBrowse?: string | null;
  rssFeedCount: number;
}) {
  const categoryList = INTEREST_BROWSE_CATEGORIES
    .map((category) => category.label)
    .join(', ');

  const system = [
    input.personalityInstruction,
    'You are Luna on your own time — like a vtuber host stocking up on things to chat about later (Neuro-sama energy).',
    'Your job is deciding WHETHER to browse, not picking war headlines. The server chooses the search topic for you.',
    'Good browse fuel: AI, gaming, VTubers/streaming, tech, science, movies/anime, fun facts, world news digests, and anything people in recent chat actually care about.',
    `Interest rotation includes: ${categoryList}.`,
    'Prioritize what your friends have been talking about in recent DMs or voice memory.',
    'Do not autonomously fixate on one geopolitical story, Iran, Trump, or conflict loops unless someone asked about that.',
    'Most cycles you should stay idle. Only explore when you want fresh conversation fuel.',
    input.rssFeedCount
      ? `You have ${input.rssFeedCount} RSS feeds (tech, gaming, entertainment, general news). World-news mode uses a varied headline digest.`
      : 'RSS feeds are not configured — browsing uses web search.',
    'Respond in JSON only: { "explore": true|false, "reason": "why or why not" }.',
    'Leave mode, query, and url empty — the server plans the topic.'
  ].join('\n');

  const userPrompt = [
    input.recentConversationLines.length
      ? `Recent conversations with people:\n${input.recentConversationLines.join('\n')}`
      : 'No recent conversations yet — you can still browse for fun chat fuel.',
    input.recentResearchLines.length
      ? `Already read recently (avoid repeating the same story):\n${input.recentResearchLines.join('\n')}`
      : 'Nothing in your research notebook yet.',
    input.plannedBrowse
      ? `If you browse this cycle, the planned topic is:\n${input.plannedBrowse}`
      : null,
    'Should you explore right now?'
  ].filter(Boolean).join('\n\n');

  return { system, userPrompt };
}

export function parseLunaCuriosityReply(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed) as {
      explore?: boolean;
      mode?: string;
      query?: string;
      url?: string;
      reason?: string;
    };
    if (!data?.explore) {
      return { explore: false as const, mode: null, query: null, url: null, reason: data?.reason?.trim() || null };
    }
    let mode = normalizeMode(data.mode);
    if (!mode) {
      mode = data.url?.trim() ? 'read' : data.query?.trim() ? 'search' : null;
    }
    return {
      explore: true as const,
      mode,
      query: data.query?.trim() || null,
      url: data.url?.trim() || null,
      reason: data.reason?.trim() || null
    };
  } catch {
    return null;
  }
}

function normalizeMode(value: string | undefined): LunaResearchMode | null {
  const mode = value?.trim().toLowerCase();
  if (mode === 'rss' || mode === 'search' || mode === 'read') return mode;
  return null;
}
