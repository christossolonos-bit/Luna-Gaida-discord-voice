import type { LunaResearchStore } from '../memory/lunaResearchStore.js';
import type { LunaResearchMode } from './lunaResearchRunner.js';
import { planInterestBrowse } from './interestBrowse.js';

export interface ConversationResearchContext {
  recentLines?: string[];
  voiceMemorySummary?: string;
  displayName?: string;
  currentMessage?: string;
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'being', 'could', 'does', 'doing', 'from', 'have',
  'having', 'here', 'just', 'know', 'like', 'love', 'luna', 'make', 'more', 'much', 'news',
  'really', 'said', 'says', 'some', 'that', 'their', 'them', 'then', 'there', 'they', 'this',
  'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your', 'you', 'are', 'was',
  'were', 'will', 'headlines', 'headline', 'reading', 'read', 'latest', 'current', 'today',
  'hello', 'hey', 'thanks', 'thank', 'please', 'okay', 'yeah', 'still', 'always', 'never'
]);

const TOPIC_CUE_RE = /\b(?:about|into|playing|watching|reading|discussing|talking about|interested in|fan of|love|hate|work on|working on|learning|started|picked up)\s+([a-z0-9][\w\s'’-]{2,40})/gi;

export function extractTopicsFromConversation(context: ConversationResearchContext): string[] {
  const topics = new Set<string>();
  const corpus = [
    ...(context.recentLines ?? []),
    context.voiceMemorySummary ?? '',
    context.currentMessage ?? ''
  ].join('\n');

  for (const match of corpus.matchAll(/"([^"]{3,50})"/g)) {
    addTopic(topics, match[1]!);
  }

  for (const line of context.recentLines ?? []) {
    if (/^Luna:/i.test(line.trim())) continue;
    const text = line.replace(/^[^:]+:\s*/, '');
    for (const match of text.matchAll(TOPIC_CUE_RE)) {
      addTopic(topics, match[1]!);
    }
    for (const match of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
      addTopic(topics, match[1]!);
    }
  }

  for (const match of (context.voiceMemorySummary ?? '').matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
    addTopic(topics, match[1]!);
  }

  for (const line of (context.voiceMemorySummary ?? '').split(/\r?\n/)) {
    const bullet = line.replace(/^[-*•]\s*/, '').trim();
    if (bullet.length >= 4) {
      addTopic(topics, bullet.split(/[.;,]/)[0] ?? bullet);
    }
  }

  if (context.displayName) {
    topics.delete(context.displayName);
    for (const topic of [...topics]) {
      if (topic.toLowerCase() === context.displayName!.toLowerCase()) topics.delete(topic);
    }
  }

  return [...topics].slice(0, 6);
}

export function buildConversationResearchQuery(
  context: ConversationResearchContext,
  mode: 'search' | 'rss' = 'search'
): string | null {
  const topics = extractTopicsFromConversation(context);
  if (!topics.length) return null;

  const focus = topics.slice(0, 2).join(' ');
  const who = context.displayName?.trim();
  const year = new Date().getFullYear();

  if (mode === 'rss') {
    return focus;
  }

  if (who) {
    return `latest ${focus} news ${year}`;
  }
  return `recent ${focus} ${year}`;
}

export function getRecentlyCoveredKeywords(researchStore: LunaResearchStore, limit = 8): string[] {
  const keywords = new Set<string>();
  for (const record of researchStore.recent(limit)) {
    for (const token of tokenizeForOverlap(`${record.title} ${record.query ?? ''} ${record.summary}`)) {
      if (token.length >= 4) keywords.add(token);
    }
  }
  return [...keywords];
}

export function enhanceResearchIntent(
  intent: { mode: LunaResearchMode; query?: string; url?: string; deep?: boolean },
  context: ConversationResearchContext | undefined,
  researchStore: LunaResearchStore | undefined
): {
  mode: LunaResearchMode;
  query?: string;
  url?: string;
  excludeKeywords?: string[];
  excludeUrls?: string[];
  preferDigest?: boolean;
  deep?: boolean;
} {
  const excludeKeywords = researchStore ? getRecentlyCoveredKeywords(researchStore) : [];
  const excludeUrls = researchStore?.recent(8).map((record) => record.url).filter(Boolean) as string[] ?? [];

  if (intent.mode === 'read' && intent.url) {
    return { ...intent, excludeKeywords, excludeUrls };
  }

  if (intent.mode === 'rss' && !intent.query?.trim()) {
    const conversationQuery = context ? buildConversationResearchQuery(context, 'rss') : null;
    if (conversationQuery) {
      return { ...intent, query: conversationQuery, excludeKeywords, excludeUrls, preferDigest: false };
    }
    return { ...intent, query: 'recent headlines', excludeKeywords, excludeUrls, preferDigest: true };
  }

  if (intent.mode === 'search' && intent.query?.trim()) {
    const conversationQuery = context ? buildConversationResearchQuery(context, 'search') : null;
    if (conversationQuery && NEWSISH_RE.test(intent.query)) {
      return { ...intent, query: conversationQuery, excludeKeywords, excludeUrls, deep: true };
    }
    return { ...intent, excludeKeywords, excludeUrls, deep: intent.deep ?? true };
  }

  const conversationQuery = context ? buildConversationResearchQuery(context, 'search') : null;
  if (conversationQuery) {
    return { mode: 'search', query: conversationQuery, excludeKeywords, excludeUrls, deep: true };
  }

  return { ...intent, excludeKeywords, excludeUrls, deep: intent.deep };
}

const NEWSISH_RE = /\b(?:news|headlines?|latest|current)\b/i;

export function detectConversationFollowUpResearch(
  userText: string,
  context: ConversationResearchContext
): { mode: LunaResearchMode; query: string } | null {
  const text = userText.trim();
  if (!text || text.length < 8) return null;

  const topics = extractTopicsFromConversation(context);
  if (!topics.length) return null;

  if (/\b(?:tell me more|go on|what else|anything else|keep going|and\?)\b/i.test(text)) {
    return { mode: 'search', query: `latest ${topics[0]} updates`, deep: true };
  }

  if (/\b(?:related to|connected to|because of|since we|you mentioned)\b/i.test(text)) {
    return { mode: 'search', query: `${topics.slice(0, 2).join(' ')} context`, deep: true };
  }

  return null;
}

export function formatConversationContextForCuriosity(
  dmLines: string[],
  voiceSnippets: string[]
): string[] {
  const lines: string[] = [];
  if (dmLines.length) {
    lines.push('Recent DMs with people:');
    lines.push(...dmLines.slice(-10));
  }
  if (voiceSnippets.length) {
    lines.push('What you remember from voice calls:');
    lines.push(...voiceSnippets.slice(0, 6));
  }
  return lines;
}

export function queryOverlapsRecentResearch(query: string, researchStore: LunaResearchStore) {
  const covered = new Set(getRecentlyCoveredKeywords(researchStore));
  const haystack = query.toLowerCase();
  let overlap = 0;
  for (const keyword of covered) {
    if (keyword.length >= 4 && haystack.includes(keyword)) {
      overlap += 1;
    }
  }
  return overlap >= 2;
}

const AUTONOMOUS_GEOPOLITICS_RE = /\b(iran|trump|israel|gaza|ukraine|hormuz|ceasefire|geopolitic|middle east|cargo ship)\b/i;

export function queryIsOffConversationTopic(
  query: string,
  dmLines: string[],
  voiceSnippets: string[]
) {
  if (!AUTONOMOUS_GEOPOLITICS_RE.test(query)) {
    return false;
  }
  const conversation = [...dmLines, ...voiceSnippets].join('\n');
  return !AUTONOMOUS_GEOPOLITICS_RE.test(conversation);
}

export function suggestCuriosityResearch(
  dmLines: string[],
  voiceSnippets: string[],
  researchStore: LunaResearchStore
) {
  const plan = planInterestBrowse(dmLines, voiceSnippets, researchStore);
  return { mode: plan.mode, query: plan.query };
}

function addTopic(topics: Set<string>, raw: string) {
  const cleaned = raw
    .replace(/[?.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 3 || cleaned.length > 60) return;
  const lower = cleaned.toLowerCase();
  if (STOP_WORDS.has(lower)) return;
  if (/^(yes|no|okay|thanks|hello|hi)$/i.test(cleaned)) return;
  if (/^[A-Z][a-z]+$/.test(cleaned) && cleaned.length <= 12) return;
  topics.add(cleaned);
}

function tokenizeForOverlap(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}
